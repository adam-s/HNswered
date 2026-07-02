import { ALARM, DEFAULT_CONFIG, LOCK, MAX_TICK_MINUTES } from '../shared/constants.ts';
import type { SidepanelMessage, SidepanelResponse } from '../shared/types.ts';
import { DEBUG, log, logErr } from '../shared/debug.ts';
import { algoliaClient } from './algolia-client.ts';
import { createStore } from './store.ts';
import { drainBackfillQueueCompletely, drainOneBackfillItem, maybeEnqueueBackfillSweep, maybeSyncAuthor, pollComments, syncAuthor } from './poller.ts';
import { trackPollOutcome } from './failure-streak.ts';
import { updateBadge } from './badge.ts';

const store = createStore();

async function refreshBadge() {
  const n = await store.getUnreadCount();
  await updateBadge(n);
  log('index.refreshBadge', `unread=${n}`);
}

async function ensureAlarms() {
  const config = await store.getConfig();
  // Clamp mirrors store.setConfig: invariant OVERLAP_MS ≥ tickMinutes +
  // AUTHOR_SYNC_MS. Applied here as a second defense in case a legacy config
  // somehow bypassed setConfig clamping (e.g. direct storage.local writes).
  const requested = config.tickMinutes;
  const tickMin = Math.min(
    Math.max(1, config.tickMinutes || DEFAULT_CONFIG.tickMinutes),
    MAX_TICK_MINUTES,
  );
  const existing = await chrome.alarms.get(ALARM.TICK);
  const existingPeriod = existing?.periodInMinutes ?? null;
  const existingNextMs = existing?.scheduledTime ?? null;
  if (!existing || existing.periodInMinutes !== tickMin) {
    await chrome.alarms.create(ALARM.TICK, {
      periodInMinutes: tickMin,
      delayInMinutes: tickMin,
    });
    const created = await chrome.alarms.get(ALARM.TICK);
    log('index.ensureAlarms',
      `ACTION=registered requested=${requested} clamped=${tickMin} ` +
      `existingPeriod=${existingPeriod} existingNextIso=${existingNextMs ? new Date(existingNextMs).toISOString() : 'none'} ` +
      `newPeriod=${created?.periodInMinutes} newNextIso=${created ? new Date(created.scheduledTime).toISOString() : 'none'}`);
  } else {
    log('index.ensureAlarms',
      `ACTION=noop periodMin=${tickMin} (unchanged) nextIso=${existingNextMs ? new Date(existingNextMs).toISOString() : 'none'}`);
  }
}

// Mutual exclusion via the Web Locks API. Serializes work across the SW AND
// every open sidepanel context. Auto-releases on SW termination.
//
// Two acquisition modes:
//   - exclusive (default): runRefresh — user-initiated work that MUST run,
//     even if an alarm tick is in-flight (queues, runs after).
//   - ifAvailable: runTick — alarm-driven idempotent work that drops on the
//     floor if a peer is already holding the lock. Skipping a redundant tick
//     is strictly cheaper than queueing one.
//
// runRefresh's spam-click throttle (lastForceRefreshAt + MIN_REFRESH_INTERVAL_MS)
// gates user-driven entry BEFORE we ask for the lock, keeping cheap rejection
// off the lock queue entirely.
const MIN_REFRESH_INTERVAL_MS = 10_000;
let lastForceRefreshAt = 0;

// Exclusive LOCK.TICK helper used by sidepanel message handlers that
// read-modify-write `replies` / `config` / `monitored`. Without this,
// mark-read / clear-read / set-config can race against addReplies and
// pruneReplies during an in-flight tick — both paths read, mutate
// in-memory, and write back, so the second writer clobbers the first.
// Exclusive mode (default) queues behind any in-flight tick rather than
// dropping, because the user intent must land.
async function withTickLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(LOCK.TICK, async () => fn());
}

async function runTick(): Promise<void> {
  const lockRequestedAt = Date.now();
  await navigator.locks.request(LOCK.TICK, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      log('index.runTick', `coalesced — lock held by peer, skipping redundant tick`);
      return;
    }
    const lockGrantedAt = Date.now();
    const lockWaitMs = lockGrantedAt - lockRequestedAt;
    // trackPollOutcome owns the success/failure streak bookkeeping and never
    // throws — the try here only exists for the finally.
    try {
      await trackPollOutcome(store, 'tick', async () => {
      const tickNow = lockGrantedAt;
      if (lockWaitMs > 50) {
        // Waiting for the lock > one event-loop tick usually means a prior
        // tick or refresh is running longer than expected. Worth surfacing.
        log('index.runTick', `lock-wait waitMs=${lockWaitMs}`);
      }
      // Complete per-tick state snapshot — one line that explains WHY this
      // tick will behave however it behaves. Grep `index.runTick STATE=` to
      // walk the tick history.
      const [cfg, ts, queue, alarm] = await Promise.all([
        store.getConfig(),
        store.getTimestamps(),
        store.getBackfillQueue(),
        chrome.alarms.get(ALARM.TICK),
      ]);
      const gap = ts.lastCommentPoll > 0 ? tickNow - ts.lastCommentPoll : Infinity;
      log('index.runTick', `STATE=enter nowIso=${new Date(tickNow).toISOString()} ` +
        `config=${JSON.stringify({ user: cfg.hnUser, tickMin: cfg.tickMinutes, backfillDays: cfg.backfillDays, retention: cfg.retentionDays })} ` +
        `gapMs=${gap === Infinity ? 'first' : gap} ` +
        `ts=${JSON.stringify({ lastCommentPoll: ts.lastCommentPoll, lastAuthorSync: ts.lastAuthorSync, lastBackfillSweepAt: ts.lastBackfillSweepAt, backfillSweepFloor: ts.backfillSweepFloor })} ` +
        `queueLen=${queue.length} ` +
        `alarm=${alarm ? `period=${alarm.periodInMinutes} nextIso=${new Date(alarm.scheduledTime).toISOString()}` : 'NONE'}`);
      // Sync first so any brand-new authored items enter monitored BEFORE
      // enqueue-sweep / comment-feed poll consult it. Gated by AUTHOR_SYNC_MS.
      await maybeSyncAuthor(algoliaClient, store);
      // Gap-trigger enqueue: BEFORE pollComments updates lastCommentPoll, so
      // the gap check sees the actual offline duration.
      await maybeEnqueueBackfillSweep(store, tickNow);
      await pollComments(algoliaClient, store);
      // One backfill drain per tick — bounded work regardless of queue size.
      await drainOneBackfillItem(algoliaClient, store, tickNow);
      });
    } finally {
      await refreshBadge();
      // Exit summary is a debug-only dump. Gate the storage reads on DEBUG so
      // shipped prod (DEBUG=false) doesn't pay a full `replies` + `monitored`
      // deserialize every tick for log output nobody sees.
      if (DEBUG) {
        const [postTs, postQueue, postReplies] = await Promise.all([
          store.getTimestamps(),
          store.getBackfillQueue(),
          store.getReplies(),
        ]);
        const durationMs = Date.now() - lockGrantedAt;
        log('index.runTick',
          `STATE=exit durationMs=${durationMs} queueLen=${postQueue.length} ` +
          `repliesTotal=${Object.keys(postReplies).length} ` +
          `ts=${JSON.stringify({ lastCommentPoll: postTs.lastCommentPoll, lastBackfillSweepAt: postTs.lastBackfillSweepAt, backfillSweepFloor: postTs.backfillSweepFloor })}`);
      }
    }
  });
}

// User-initiated refresh: bypass the AUTHOR_SYNC_MS gate because the user is
// explicitly asking us to look now. Still honors the 10s refresh throttle.
//
// When `fullDrain` is true, the backfill queue is drained in ONE burst
// (paced by `DRAIN_ALL_DELAY_MS`, ~2s/item) rather than one-per-tick. Used
// for user-change + backfill-widen — explicit actions where the user is
// actively waiting for historical catch-up to appear. Normal refresh-button
// click stays at one-per-tick to not hold the lock for long.
async function runRefresh(fullDrain = false): Promise<void> {
  log('index.runRefresh', `ENTER`);
  const now = Date.now();
  const sinceLastMs = now - lastForceRefreshAt;
  if (sinceLastMs < MIN_REFRESH_INTERVAL_MS) {
    // Throttle path: a refresh ran very recently. Do NOT do more HN work, but
    // DO wait for any in-flight refresh to drain so callers see post-drain
    // storage state. An empty exclusive acquisition queues behind the in-flight
    // work and grants instantly once the lock is free.
    log('index.runRefresh', `THROTTLED sinceLastMs=${sinceLastMs} min=${MIN_REFRESH_INTERVAL_MS} — draining any in-flight tick`);
    await navigator.locks.request(LOCK.TICK, () => {});
    return;
  }
  lastForceRefreshAt = now;

  await navigator.locks.request(LOCK.TICK, async () => {
    try {
      await trackPollOutcome(store, 'refresh', async () => {
      const config = await store.getConfig();
      log('index.runRefresh', `config hnUser=${JSON.stringify(config.hnUser)} tickMin=${config.tickMinutes} retDays=${config.retentionDays}`);
      if (!config.hnUser) {
        log('index.runRefresh', `skip — no hnUser configured`);
        return;
      }
      const refreshNow = Date.now();
      const [rcfg, rts, rqueue] = await Promise.all([store.getConfig(), store.getTimestamps(), store.getBackfillQueue()]);
      log('index.runRefresh', `STATE=enter nowIso=${new Date(refreshNow).toISOString()} ` +
        `config=${JSON.stringify({ user: rcfg.hnUser, tickMin: rcfg.tickMinutes, backfillDays: rcfg.backfillDays, retention: rcfg.retentionDays })} ` +
        `ts=${JSON.stringify({ lastCommentPoll: rts.lastCommentPoll, lastAuthorSync: rts.lastAuthorSync, lastBackfillSweepAt: rts.lastBackfillSweepAt, backfillSweepFloor: rts.backfillSweepFloor })} ` +
        `queueLen=${rqueue.length}`);
      const added = await syncAuthor(algoliaClient, store);
      log('index.runRefresh', `syncAuthor added=${added}`);
      await maybeEnqueueBackfillSweep(store, refreshNow);
      const res = await pollComments(algoliaClient, store);
      log('index.runRefresh', `pollComments newReplies=${res.newReplies} skipped=${res.skipped} reason=${res.reason}`);
      if (fullDrain) {
        await drainBackfillQueueCompletely(algoliaClient, store);
      } else {
        await drainOneBackfillItem(algoliaClient, store, refreshNow);
      }
      });
    } finally {
      await refreshBadge();
      log('index.runRefresh', `EXIT`);
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  log('index.onInstalled', `fired`);
  await ensureAlarms();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  log('index.onStartup', `fired`);
  await ensureAlarms();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Measure scheduling drift — if the SW suspended or the OS throttled, the
  // alarm may fire seconds-to-minutes late. Chrome docs: alarms can be
  // delayed under battery-saver / system sleep. A 60+ second delay on a
  // 1-minute cadence means effective polling is much slower than advertised.
  const driftMs = Date.now() - alarm.scheduledTime;
  log('index.onAlarm', `fired name=${alarm.name} scheduledIso=${new Date(alarm.scheduledTime).toISOString()} driftMs=${driftMs}`);
  if (alarm.name === ALARM.TICK) void runTick();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  log('index.onStorageChanged', `keys=${JSON.stringify(keys)}`);
  if (changes.replies) void refreshBadge();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener((message: SidepanelMessage, sender, sendResponse) => {
  log('index.onMessage', `RECV kind=${message.kind} senderUrl=${sender?.url ?? 'n/a'}`);
  const respond = (value: SidepanelResponse) => sendResponse(value);
  (async () => {
    try {
      switch (message.kind) {
        case 'list-replies': {
          const replies = await store.getReplies();
          // Sort by HN's posting time, newest first — not by discoveredAt. When a
          // first-sync surfaces many pre-existing replies in one sweep they share
          // a near-identical discoveredAt, making that ordering meaningless.
          respond({ ok: true, data: Object.values(replies).sort((a, b) => b.time - a.time) });
          return;
        }
        case 'mark-read': {
          await withTickLock(() => store.markRead(message.id));
          respond({ ok: true });
          return;
        }
        case 'mark-all-read': {
          await withTickLock(() => store.markAllRead());
          respond({ ok: true });
          return;
        }
        case 'get-config': {
          const config = await store.getConfig();
          respond({ ok: true, data: config });
          return;
        }
        case 'set-config': {
          log('index.onMessage.set-config', `INCOMING payload=${JSON.stringify(message.config)}`);
          // Lock-wrapped so we drain any in-flight tick before clearing
          // per-user state. Without this, a tick holding old config could
          // write stale monitored/replies after the clear — leaving the
          // new user with ghosts from the prior account.
          const { config, userChanged, backfillWidened, nextUser } = await withTickLock(async () => {
            const prev = await store.getConfig();
            const next = await store.setConfig(message.config);
            const nextU = (next.hnUser ?? '').trim();
            const prevU = (prev.hnUser ?? '').trim();
            const changed = nextU !== prevU;
            const widened = !changed && (next.backfillDays ?? 7) > (prev.backfillDays ?? 7);
            if (changed) {
              log('index.onMessage', `user-changed from=${JSON.stringify(prevU)} to=${JSON.stringify(nextU)} → clearPerUserState`);
              await store.clearPerUserState();
            } else if (widened) {
              // User widened catch-up window (e.g. 7→30). Clear the sweep
              // markers so the next trigger fires a FRESH sweep over the
              // widened depth. Re-backfilling already-covered items in the
              // overlapping window is harmless (addReplies dedupes).
              log('index.onMessage', `backfillDays widened ${prev.backfillDays}→${next.backfillDays} → clearing lastBackfillSweepAt + queue to trigger immediate re-sweep`);
              await store.setTimestamp('lastBackfillSweepAt', 0);
              await store.setTimestamp('backfillSweepFloor', 0);
              await store.setBackfillQueue([]);
            }
            log('index.onMessage.set-config',
              `STORED prev=${JSON.stringify(prev)} next=${JSON.stringify(next)} userChanged=${changed} backfillWidened=${widened}`);
            return { config: next, userChanged: changed, backfillWidened: widened, nextUser: nextU };
          });
          if (userChanged) {
            await refreshBadge();
            if (nextUser) {
              log('index.onMessage', `user-changed → reset throttle + runRefresh(fullDrain=true) for user=${nextUser}`);
              lastForceRefreshAt = 0;
              // fullDrain: user-change is an explicit action — surface all
              // historical replies in one burst (~2s/item) instead of drip
              // over N minutes.
              void runRefresh(true);
            }
          } else if (backfillWidened) {
            // Immediate-UX: user saved a wider window and expects the new
            // replies to surface NOW, not drip over 30 minutes. Run the
            // full catch-up inline inside the tick lock — enqueue the full
            // in-window set, then drain every item end-to-end. Bounded at
            // |monitored ∩ window| × per-request time (~500ms/item).
            log('index.onMessage', `backfillDays widened → running full catch-up inline`);
            // Fire-and-forget: trackPollOutcome swallows failures into the
            // streak (an Algolia error here must not become an unhandled SW
            // rejection), and refreshBadge runs regardless of outcome.
            void (async () => {
              await withTickLock(async () => {
                await trackPollOutcome(store, 'refresh', async () => {
                  await maybeEnqueueBackfillSweep(store);
                  await drainBackfillQueueCompletely(algoliaClient, store);
                });
                await refreshBadge();
              });
            })().catch((err) => logErr('index.onMessage', 'inline fullDrain wrapper failed', err));
          }
          await ensureAlarms();
          respond({ ok: true, data: config });
          return;
        }
        case 'force-refresh': {
          await runRefresh();
          respond({ ok: true });
          return;
        }
        case 'get-monitored': {
          const monitored = await store.getMonitored();
          respond({ ok: true, data: Object.values(monitored) });
          return;
        }
        case 'reset-all': {
          await withTickLock(() => chrome.storage.local.clear());
          await refreshBadge();
          respond({ ok: true });
          return;
        }
        case 'clear-read': {
          const n = await withTickLock(() => store.clearRead());
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case 'clear-all-replies': {
          const n = await withTickLock(() => store.clearAllReplies());
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case 'get-storage-stats': {
          const [replies, monitored, bytes] = await Promise.all([
            store.getReplies(),
            store.getMonitored(),
            store.getBytesInUse(),
          ]);
          const all = Object.values(replies);
          respond({ ok: true, data: {
            replyCount: all.length,
            unreadCount: all.filter((r) => !r.read).length,
            monitoredCount: Object.keys(monitored).length,
            bytesInUse: bytes,
          }});
          return;
        }
        case 'inspect': {
          // Read-only dump of the whole state. Safe to call repeatedly — does
          // NOT touch storage or hit HN.
          const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
          log('index.inspect', `config=${JSON.stringify(all.config)}`);
          log('index.inspect', `timestamps lastCommentPoll=${all.lastCommentPoll} lastAuthorSync=${all.lastAuthorSync}`);
          const monitored = (all.monitored as Record<string, import('../shared/types.ts').MonitoredItem> | undefined) ?? {};
          const mArr = Object.values(monitored);
          log('index.inspect', `monitored count=${mArr.length}`);
          for (const m of mArr) {
            const ageDays = ((Date.now() - m.submittedAt) / 86400000).toFixed(2);
            log('index.inspect.monitored', `id=${m.id} type=${m.type} ageDays=${ageDays} title=${JSON.stringify(m.title)}`);
          }
          const replies = (all.replies as Record<string, import('../shared/types.ts').Reply> | undefined) ?? {};
          const rArr = Object.values(replies);
          const unread = rArr.filter((r) => !r.read).length;
          log('index.inspect', `replies count=${rArr.length} unread=${unread}`);
          const alarms = await chrome.alarms.getAll();
          for (const a of alarms) {
            log('index.inspect.alarm', `name=${a.name} scheduledTime=${a.scheduledTime} nextInMs=${a.scheduledTime - Date.now()} periodMin=${a.periodInMinutes}`);
          }
          respond({ ok: true, data: {
            config: all.config,
            monitored: mArr,
            replyCount: rArr.length,
            unreadCount: unread,
            timestamps: {
              lastCommentPoll: all.lastCommentPoll ?? null,
              lastAuthorSync: all.lastAuthorSync ?? null,
            },
            alarms,
          }});
          return;
        }
        default: {
          // Unknown message kind — must respond so the sidepanel's sendMessage
          // callback resolves. Otherwise Chrome holds the port open until SW
          // suspension and any UI operation that sent the message hangs.
          const kind = (message as { kind?: unknown }).kind;
          log('index.onMessage', `UNKNOWN kind=${JSON.stringify(kind)}`);
          respond({ ok: false, error: `unknown message kind: ${String(kind)}` });
          return;
        }
      }
    } catch (err) {
      logErr('index.onMessage', `kind=${message.kind}`, err);
      respond({ ok: false, error: (err as Error).message });
    }
  })();
  return true;
});

log('index.boot', `loaded`);
void ensureAlarms();
void refreshBadge();

// Test/harness hook — expose internals to scripts/* that drive the SW via CDP.
// Production code never reads this; it's just a handle for Playwright evaluate().
(globalThis as unknown as Record<string, unknown>).__hnswered = {
  store,
  runTick,
  runRefresh,
  refreshBadge,
  ensureAlarms,
};
