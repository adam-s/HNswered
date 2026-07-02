// Algolia-first poller.
//
// Three work functions, all driven by one alarm tick:
//
//   pollComments — every tick. One Algolia comment-feed request covers all of
//     HN's recent comments within the OVERLAP_MS window; we filter locally to
//     `parent_id ∈ monitored.keys()` and `author !== hnUser`. The single live
//     detection path.
//
//   syncAuthor — gated externally by AUTHOR_SYNC_MS (except force-refresh,
//     which bypasses the gate). Two Algolia tag queries populate `monitored`.
//
//   maybeEnqueueBackfillSweep + drainOneBackfillItem — the slow-drip catch-up
//     worker. When `gap = now - lastCommentPoll > OVERLAP_MS` (i.e. the SW was
//     offline long enough that the rolling 45-min comment-feed window no
//     longer covers the gap), every monitored item posted within
//     `config.backfillDays` is enqueued (newest-first). Each subsequent tick
//     pops one item from the queue and runs `searchByParent(id, since)` with
//     `since = max(lastBackfillSweepAt, now - backfillDays*DAY_MS)` — so the
//     query returns only replies posted inside the actual gap, not the item's
//     full reply history. Queue emptied → `lastBackfillSweepAt = now` so the
//     next wake knows where to start.
//
// Dedupe is free: `store.addReplies` is already idempotent (keyed by reply id).
// No Firebase recovery layer — the retrospective sweep
// (cost-analysis/docs/reports/report.md) confirmed 99.99% live agreement
// between Algolia parent_id and Firebase kids[] minus dead/deleted.

import type { AlgoliaAuthorHit, AlgoliaCommentHit, MonitoredItem, Reply } from '../shared/types.ts';
import { AUTHOR_SYNC_MS, DAY_MS, DROP_AGE_MS, OVERLAP_MS, RETENTION } from '../shared/constants.ts';
import { excerptFrom } from '../shared/excerpt.ts';
import { log } from '../shared/debug.ts';
import type { AlgoliaClient } from './algolia-client.ts';
import type { Store } from './store.ts';

const nowMs = () => Date.now();

export interface PollResult {
  newReplies: number;
  skipped: boolean;
  reason?: string;
}

export function toMonitoredFromAuthorHit(hit: AlgoliaAuthorHit): MonitoredItem | null {
  const tags = hit._tags ?? [];
  const isStory = tags.includes('story') || (hit.title != null);
  const isComment = tags.includes('comment') || (hit.comment_text != null);
  // Ignore polls, jobs, and anything else — reply-tracking model only fits stories + comments.
  if (!isStory && !isComment) return null;
  const type: 'story' | 'comment' = isStory ? 'story' : 'comment';
  const id = Number(hit.objectID);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    type,
    submittedAt: hit.created_at_i * 1000,
    title: isStory ? hit.title : undefined,
    excerpt: isComment && hit.comment_text ? excerptFrom(hit.comment_text, 140) : undefined,
  };
}

export function toReplyFromCommentHit(hit: AlgoliaCommentHit, parent: MonitoredItem): Reply | null {
  if (!hit.author) return null;
  const id = Number(hit.objectID);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    parentItemId: parent.id,
    parentItemTitle: parent.type === 'story' ? parent.title : undefined,
    parentAuthor: parent.type === 'comment' ? parent.parentAuthor : undefined,
    parentExcerpt: parent.type === 'comment' ? parent.excerpt : undefined,
    author: hit.author,
    text: hit.comment_text ?? '',
    time: hit.created_at_i * 1000,
    read: false,
    discoveredAt: nowMs(),
  };
}

export function ageMs(item: MonitoredItem, now = nowMs()): number {
  return now - item.submittedAt;
}

export async function pollComments(
  client: AlgoliaClient,
  store: Store,
): Promise<PollResult> {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.pollComments', `skip reason=no-user`);
    return { newReplies: 0, skipped: true, reason: 'no-user' };
  }
  const hnUserLc = config.hnUser.toLowerCase();
  const monitored = await store.getMonitored();
  const parentIds = new Set<number>();
  for (const k of Object.keys(monitored)) {
    const n = Number(k);
    if (Number.isFinite(n)) parentIds.add(n);
  }
  if (parentIds.size === 0) {
    log('poller.pollComments', `skip reason=no-monitored user=${config.hnUser}`);
    await store.setTimestamp('lastCommentPoll', nowMs());
    return { newReplies: 0, skipped: true, reason: 'no-monitored' };
  }
  const sinceSec = Math.floor((nowMs() - OVERLAP_MS) / 1000);
  log('poller.pollComments', `ENTER user=${config.hnUser} monitoredCount=${parentIds.size} sinceSec=${sinceSec}`);

  const hits = await client.searchComments(sinceSec);
  log('poller.pollComments', `algolia returned ${hits.length} hits`);

  const replies: Reply[] = [];
  let selfSkip = 0;
  let notMonitoredSkip = 0;
  for (const h of hits) {
    if (!parentIds.has(h.parent_id)) {
      notMonitoredSkip++;
      continue;
    }
    if ((h.author ?? '').toLowerCase() === hnUserLc) {
      selfSkip++;
      continue;
    }
    const parent = monitored[String(h.parent_id)];
    if (!parent) continue;
    const r = toReplyFromCommentHit(h, parent);
    if (r) replies.push(r);
  }

  let inserted = 0;
  if (replies.length > 0) {
    inserted = await store.addReplies(replies);
    log('poller.pollComments', `candidates=${replies.length} inserted=${inserted} passed to addReplies`);
  }

  await store.setTimestamp('lastCommentPoll', nowMs());
  const hitRate = hits.length > 0 ? ((replies.length / hits.length) * 100).toFixed(1) : '0.0';
  const nextCommentPollFloorIso = new Date(nowMs() - OVERLAP_MS).toISOString();
  log('poller.pollComments',
    `EXIT inserted=${inserted} candidates=${replies.length} hits=${hits.length} hitRate=${hitRate}% selfSkip=${selfSkip} notMonitoredSkip=${notMonitoredSkip} ` +
    `nextWindowStartIso=${nextCommentPollFloorIso}`);
  // Return `inserted` (actually-new replies), not candidates. Callers use
  // this for UI status / log summaries.
  return { newReplies: inserted, skipped: false };
}

export async function syncAuthor(
  client: AlgoliaClient,
  store: Store,
): Promise<number> {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.syncAuthor', `skip reason=no-user`);
    return 0;
  }
  const { lastAuthorSync } = await store.getTimestamps();
  const firstSync = !lastAuthorSync;
  const now = nowMs();
  // First sync: pull everything within DROP_AGE_MS so existing authored
  // content gets tracked immediately. Subsequent syncs: use overlap window
  // from the previous run, clamped to DROP_AGE_MS.
  const sinceMs = firstSync
    ? now - DROP_AGE_MS
    : Math.max(lastAuthorSync - OVERLAP_MS, now - DROP_AGE_MS);
  const sinceSec = Math.floor(sinceMs / 1000);
  log('poller.syncAuthor', `ENTER user=${config.hnUser} firstSync=${firstSync} sinceSec=${sinceSec}`);

  const hits = await client.searchByAuthor(config.hnUser, sinceSec);
  log('poller.syncAuthor', `algolia returned ${hits.length} author hits`);

  const dropThreshold = now - DROP_AGE_MS;
  const monitored = await store.getMonitored();
  let added = 0;
  let skippedOld = 0;
  let skippedExisting = 0;
  for (const h of hits) {
    const m = toMonitoredFromAuthorHit(h);
    if (!m) continue;
    if (m.submittedAt < dropThreshold) {
      skippedOld++;
      continue;
    }
    const key = String(m.id);
    if (monitored[key]) {
      skippedExisting++;
      continue;
    }
    monitored[key] = m;
    added++;
  }

  if (added > 0) {
    await store.setMonitored(monitored);
  }

  // Age-based eviction of monitored items.
  const toDrop: number[] = [];
  for (const m of Object.values(monitored)) {
    if (ageMs(m, now) >= DROP_AGE_MS) toDrop.push(m.id);
  }
  if (toDrop.length > 0) {
    await store.removeMonitored(toDrop);
  }

  // Retention pruning of stored replies — runs every syncAuthor cycle
  // (~10min cadence). Drops read replies past retentionDays, orphaned read
  // replies, and hard-capped overflow.
  const retentionDays = Math.max(1, Number(config.retentionDays) || 30);
  const dropped = await store.pruneReplies({
    readOlderThanMs: retentionDays * DAY_MS,
    hardCap: RETENTION.HARD_REPLY_CAP,
    orphanedIfMonitoredMissing: true,
    now,
  });
  if (dropped > 0) log('poller.syncAuthor', `pruned ${dropped} replies retentionDays=${retentionDays}`);

  await store.setTimestamp('lastAuthorSync', now);
  log('poller.syncAuthor', `EXIT added=${added} skippedOld=${skippedOld} skippedExisting=${skippedExisting} dropped=${toDrop.length}`);
  return added;
}

// Gated version for alarm-driven ticks. runRefresh (user click) calls
// syncAuthor directly, bypassing the gate.
export async function maybeSyncAuthor(client: AlgoliaClient, store: Store): Promise<number> {
  const { lastAuthorSync } = await store.getTimestamps();
  const now = nowMs();
  const age = now - lastAuthorSync;
  if (lastAuthorSync > 0 && age < AUTHOR_SYNC_MS) {
    const nextEligibleAt = lastAuthorSync + AUTHOR_SYNC_MS;
    const msUntilEligible = nextEligibleAt - now;
    log('poller.maybeSyncAuthor',
      `gated age=${age} cadence=${AUTHOR_SYNC_MS} msUntilEligible=${msUntilEligible} nextEligibleIso=${new Date(nextEligibleAt).toISOString()}`);
    return 0;
  }
  return syncAuthor(client, store);
}

// ---------------------------------------------------------------------------
// Backfill sweep — "catch up after absence"
// ---------------------------------------------------------------------------

function backfillDepthMs(config: { backfillDays?: number }): number {
  const days = Math.max(1, Number(config.backfillDays) || 7);
  return days * DAY_MS;
}

/** Compute the time floor for the next backfill sweep.
 *
 *   sinceMs = min(now, max(lastBackfillSweepAt, now - backfillDays*DAY_MS))
 *
 * - On first install (lastBackfillSweepAt=0): returns `now - depth`.
 * - After an absence: returns the later of "last completed sweep" and "depth
 *   ago" — so long absences don't force us to look further back than
 *   `backfillDays`, and brief absences only fetch replies within the gap.
 * - `min(now, ...)` floor-clamps future timestamps (lastBackfillSweepAt > now)
 *   caused by system-clock rollback or VM sleep/restore. Without the clamp,
 *   `since` could be in the future and Algolia would return zero hits forever.
 *
 * Exported for tests.
 */
export function computeBackfillSinceMs(opts: {
  now: number;
  lastBackfillSweepAt: number;
  backfillDays: number;
}): number {
  const depthMs = Math.max(1, opts.backfillDays) * DAY_MS;
  return Math.min(opts.now, Math.max(opts.lastBackfillSweepAt, opts.now - depthMs));
}

/** Enqueue pending backfill work if a gap is detected. A "gap" means
 * `now - lastCommentPoll > OVERLAP_MS` — the rolling comment-feed window
 * alone can no longer recover missed replies.
 *
 * Items already in the queue are preserved (not duplicated). Newly-enqueued
 * items go at the head, newest-submitted first, so recently-authored items —
 * the ones most likely to still be receiving replies — drain first.
 *
 * Returns the number of items newly enqueued. No-op when no gap, no user,
 * or no eligible monitored items.
 */
export async function maybeEnqueueBackfillSweep(store: Store, now = nowMs()): Promise<number> {
  const config = await store.getConfig();
  if (!config.hnUser) return 0;
  const { lastCommentPoll, lastBackfillSweepAt, backfillSweepFloor } = await store.getTimestamps();
  const gap = now - lastCommentPoll;
  // Trigger on EITHER:
  //   (a) absence (gap > OVERLAP_MS): rolling comment-feed window can no
  //       longer recover missed replies.
  //   (b) never-swept state (lastBackfillSweepAt == 0) while there are
  //       monitored items: covers first install AND extension-upgrade on a
  //       user who had monitored items before the backfill feature existed
  //       (lastCommentPoll is current, but no sweep has ever run).
  const neverSwept = lastBackfillSweepAt === 0;
  const absence = lastCommentPoll > 0 && gap > OVERLAP_MS;
  const firstPoll = lastCommentPoll === 0;
  if (!neverSwept && !absence && !firstPoll) {
    return 0;
  }

  // **Sweep-in-progress handling.** Two distinct cases:
  //
  //  (i)  `neverSwept` or `firstPoll` while queue is non-empty: this is the
  //       steady state of an in-progress sweep that hasn't yet completed.
  //       Re-enqueuing would re-add drained items (they're still in
  //       monitored), pinning the queue at its original size forever. SKIP.
  //
  //  (ii) `absence` (real new gap > OVERLAP_MS) while queue is non-empty:
  //       the in-progress sweep's floor is based on pre-gap state and its
  //       already-drained items DID NOT see replies that arrived during the
  //       new gap. We must INVALIDATE the sweep: lower the floor to include
  //       the gap, clear the queue, and re-enqueue all in-window items so
  //       every monitored parent is re-checked with the widened floor.
  //       addReplies dedupes existing stored replies, so over-fetching is
  //       harmless; under-fetching would be a correctness bug.
  const existingQueue = await store.getBackfillQueue();
  const invalidateDueToAbsence = absence && existingQueue.length > 0;
  if (existingQueue.length > 0 && !invalidateDueToAbsence) {
    log('poller.maybeEnqueueBackfillSweep',
      `skip reason=sweep-in-progress queueLen=${existingQueue.length}`);
    return 0;
  }
  if (invalidateDueToAbsence) {
    log('poller.BACKFILL.invalidate',
      `reason=absence-during-sweep gap=${gap} queueLen-was=${existingQueue.length} — re-enqueueing all in-window items with widened floor`);
  }
  const depthMs = backfillDepthMs(config);
  const cutoff = now - depthMs;
  const monitored = await store.getMonitored();
  // Queue is either empty (normal enqueue) or about to be replaced wholesale
  // (absence-invalidation path). Either way we take the full in-window set.
  const candidates = Object.values(monitored)
    .filter((m) => m.submittedAt >= cutoff)
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .map((m) => m.id);
  if (candidates.length === 0) return 0;

  // **Pin `since` floor for this sweep.** Without this, a drip that takes
  // multiple hours/days would compute `since` per-drain — `now - depth` slides
  // forward, and items drained later in the sweep would miss replies that
  // landed inside the original catch-up window. Fix: compute the floor once
  // at enqueue, persist it, consume it in every drain of this sweep, clear
  // when queue empties. If a fresh enqueue lands while a sweep is still in
  // progress, take the OLDER of the two floors to preserve full coverage
  // (over-fetching is harmless because addReplies is idempotent).
  const newFloor = computeBackfillSinceMs({ now, lastBackfillSweepAt, backfillDays: Number(config.backfillDays) || 7 });
  const pinnedFloor = backfillSweepFloor > 0
    ? Math.min(backfillSweepFloor, newFloor)
    : newFloor;
  if (pinnedFloor !== backfillSweepFloor) {
    await store.setTimestamp('backfillSweepFloor', pinnedFloor);
  }

  // Queue was asserted empty at the top of this function; write the fresh
  // candidates, ordered newest-first by submittedAt (which the filter above
  // already enforced via `.sort`).
  const nextQueue = candidates;
  await store.setBackfillQueue(nextQueue);
  const trigger = firstPoll ? 'first-poll' : neverSwept ? 'never-swept' : 'absence';
  // BACKFILL-prefixed lines are the user-facing "proof it's working" channel.
  // Each line tells a self-contained story that can be grepped without context.
  log('poller.BACKFILL.enqueue',
    `trigger=${trigger} enqueued=${candidates.length} queueTotal=${nextQueue.length} depth=${Number(config.backfillDays) || 7}d floorIso=${new Date(pinnedFloor).toISOString()} windowDaysBack=${((now - pinnedFloor) / DAY_MS).toFixed(2)}`);
  log('poller.maybeEnqueueBackfillSweep',
    `gap=${gap} cutoff=${cutoff} pinnedFloor=${pinnedFloor} enqueued=${candidates.length} queueTotal=${nextQueue.length}`);
  return candidates.length;
}

/** Pop one item from the backfill queue, run `searchByParent` with a
 * `since` filter so Algolia returns only replies newer than the last
 * completed sweep, and `addReplies` the result.
 *
 * When the queue drains to empty, `lastBackfillSweepAt` is advanced to `now`
 * — the next wake will use this as its floor.
 *
 * Returns the number of replies surfaced (0 if queue empty or parent evicted).
 */
export async function drainOneBackfillItem(
  client: AlgoliaClient,
  store: Store,
  now = nowMs(),
  // Optional pre-fetched monitored map. `drainBackfillQueueCompletely` reads
  // monitored once and passes it in to avoid an O(N) JSON parse per drained
  // parent — at 5000 monitored items × 500 queue entries that saves several
  // hundred MB of deserialize traffic. Monitored is not mutated during drain.
  monitoredCache?: Record<string, MonitoredItem>,
): Promise<number> {
  const queue = await store.getBackfillQueue();
  if (queue.length === 0) return 0;
  const config = await store.getConfig();
  if (!config.hnUser) return 0;
  const [head, ...rest] = queue;
  const monitored = monitoredCache ?? await store.getMonitored();
  const parent = monitored[String(head)];
  const { lastBackfillSweepAt, backfillSweepFloor } = await store.getTimestamps();
  if (!parent) {
    // Parent was evicted since enqueue (age-based DROP_AGE_MS drop, or user
    // changed). Silently skip and persist shortened queue.
    await store.setBackfillQueue(rest);
    log('poller.drainOneBackfillItem', `parent=${head} evicted — dropped from queue`);
    if (rest.length === 0) {
      await store.setTimestamp('lastBackfillSweepAt', now);
      await store.setTimestamp('backfillSweepFloor', 0);
    }
    return 0;
  }
  // Use the pinned floor if a sweep is active; otherwise fall back to the
  // windowed computation (defensive — `drainOneBackfillItem` should not be
  // called with a non-empty queue but no pinned floor, though a forced
  // setBackfillQueue from outside could set up that state).
  const sweepFloorMs = backfillSweepFloor > 0
    ? backfillSweepFloor
    : computeBackfillSinceMs({
        now,
        lastBackfillSweepAt,
        backfillDays: Number(config.backfillDays) || 7,
      });
  // **Per-parent incremental floor — only trusted after the FIRST completed
  // sweep.** The optimization advances `since` past the newest stored reply
  // for this parent, saving Algolia bandwidth when we already have coverage.
  // BUT: a single stored reply does NOT prove continuous coverage back to the
  // sweep floor. On a fresh user change, `clearPerUserState` wipes storage,
  // `pollComments` surfaces a few recent replies from the 45-min window,
  // then backfill runs. If we used per-parent here, a single 10-min-old
  // reply on parent X would trick us into asking Algolia only for replies
  // newer than 10 min — missing the historical 7-day window entirely.
  //
  // Guard: `lastBackfillSweepAt > 0` means a prior sweep completed, which IS
  // proof that we have continuous coverage from `lastBackfillSweepAt` to now.
  // Only under that condition can we advance past the newest stored reply.
  // Per-parent cursor optimization was removed. The invariant it needed —
  // continuous coverage from sweep floor to the newest-stored-reply for each
  // parent — is not preserved across an `absence` invalidation: a wake-up
  // `pollComments` stores recent replies in the 45-min window, those are
  // newer than the absence-lowered sweep floor, and per-parent would have
  // wrongly skipped the gap interval for each parent. Always use the sweep
  // floor. Over-fetching is dedup'd by `addReplies`; correctness > speed.
  const sinceMs = sweepFloorMs;
  const sinceSec = Math.floor(sinceMs / 1000);
  let hits: AlgoliaCommentHit[];
  try {
    hits = await client.searchByParent(head, sinceSec);
  } catch (err) {
    // Rotate the failed head to the tail before rethrowing. A parent whose
    // query fails deterministically (e.g. an upstream API contract change)
    // must not pin the queue head forever — every parent behind it would be
    // starved of gap recovery, which is silent capture loss. Rotation never
    // drops the item, only deprioritizes it; the pinned sweep floor keeps
    // its window intact for the retry, and transient failures just drain it
    // one cycle later.
    await store.setBackfillQueue([...rest, head]);
    log('poller.BACKFILL.drain', `parent=${head} fetch failed — rotated to queue tail (queueLen=${rest.length + 1})`);
    throw err;
  }
  const hnUserLc = config.hnUser.toLowerCase();
  const replies: Reply[] = [];
  for (const h of hits) {
    if ((h.author ?? '').toLowerCase() === hnUserLc) continue;
    const r = toReplyFromCommentHit(h, parent);
    if (r) replies.push(r);
  }
  const inserted = replies.length > 0 ? await store.addReplies(replies) : 0;
  await store.setBackfillQueue(rest);
  // One high-signal line per drain — proves backfill is doing real work,
  // and distinguishes "Algolia returned N hits" (fetched) from "N of those
  // were actually new" (surfaced). If `inserted` is consistently 0 while
  // `hits` > 0, live polling is already keeping up; the drip is a safety net.
  // Verdict + ETA: if `inserted === 0 && hits.length > 0 && replies.length < hits.length`,
  // some hits were filtered out before addReplies (self-author, or invalid
  // toReplyFromCommentHit → null). Distinguish those cases from "pure dupes".
  const filtered = hits.length - replies.length;
  let verdict: string;
  if (inserted > 0) verdict = `SURFACED ${inserted} new`;
  else if (hits.length === 0) verdict = 'no-hits';
  else if (filtered > 0 && replies.length === 0) verdict = `no-new (all ${filtered} filtered: self/invalid)`;
  else if (filtered > 0) verdict = `no-new (${replies.length} dupes + ${filtered} filtered)`;
  else verdict = `no-new (all ${replies.length} dupes)`;
  log('poller.BACKFILL.drain',
    `parent=${head} sinceSec=${sinceSec} fetched=${hits.length} candidates=${replies.length} ${verdict} queueRemaining=${rest.length}`);
  if (rest.length === 0) {
    // Sweep complete. Advance `lastBackfillSweepAt` to `now` so the next
    // sweep computes its floor from this point, and clear the pinned floor
    // so it doesn't contaminate a future sweep (which will pin a fresh
    // value at enqueue time).
    await store.setTimestamp('lastBackfillSweepAt', now);
    await store.setTimestamp('backfillSweepFloor', 0);
    log('poller.BACKFILL.complete',
      `sweep drained — lastBackfillSweepAt=${new Date(now).toISOString()}, floor cleared. ` +
      `Next enqueue fires only on gap>${OVERLAP_MS / 60000}min OR user/data change.`);
  }
  log('poller.drainOneBackfillItem',
    `parent=${head} sinceSec=${sinceSec} hits=${hits.length} candidates=${replies.length} inserted=${inserted} queueRemaining=${rest.length}`);
  return inserted;
}

/** Drain the entire queue in one go. Used when the user explicitly widens
 * `backfillDays` — they expect the new window to take effect on save, not
 * drip in over 30 minutes. Bounded only by queue length × per-request time
 * (~300-900ms per Algolia call).
 *
 * Returns total replies surfaced across all drained items. Callers should
 * invoke this inside `LOCK.TICK` so a concurrent alarm tick doesn't race
 * with the drain loop.
 */
/** Spacing between drain-all iterations. Algolia is rate-sensitive under
 * sustained sequential load; 1.5s per call keeps us well below the per-IP
 * ceiling observed during the research sweep. Politeness matters more than
 * speed here — this is user-initiated catch-up, not live polling. */
export const DRAIN_ALL_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function drainBackfillQueueCompletely(
  client: AlgoliaClient,
  store: Store,
): Promise<{ itemsProcessed: number; repliesSurfaced: number }> {
  let itemsProcessed = 0;
  let repliesSurfaced = 0;
  const started = nowMs();
  // Cache monitored once — it isn't mutated during drain (syncAuthor can't run,
  // we hold LOCK.TICK). Passed into each drainOneBackfillItem call.
  const monitoredCache = await store.getMonitored();
  const initialLen = (await store.getBackfillQueue()).length;
  log('poller.BACKFILL.drainAll.start',
    `queueLen=${initialLen} delayMs=${DRAIN_ALL_DELAY_MS} etaMinutes=${((initialLen * DRAIN_ALL_DELAY_MS) / 60_000).toFixed(1)}`);
  while (true) {
    const queueBefore = await store.getBackfillQueue();
    if (queueBefore.length === 0) break;
    const inserted = await drainOneBackfillItem(client, store, nowMs(), monitoredCache);
    itemsProcessed++;
    repliesSurfaced += inserted;
    if (itemsProcessed > 5000) {
      log('poller.BACKFILL.drainAll.abort', `itemsProcessed=${itemsProcessed} — aborting runaway drain`);
      break;
    }
    const queueAfter = await store.getBackfillQueue();
    if (queueAfter.length > 0) {
      await sleep(DRAIN_ALL_DELAY_MS);
    }
  }
  // CRITICAL: stamp `lastBackfillSweepAt = started`, NOT `nowMs()`. During
  // the drain we held LOCK.TICK; alarm-driven pollComments ticks coalesced
  // (dropped via `ifAvailable`). Any reply to any of our monitored items
  // arriving AFTER `started` was not observed by live polling and was
  // caught (or missed) by backfill based on when each individual parent
  // was drained. Setting the stamp to `started` means the next sweep's
  // floor begins from when we BEGAN this catch-up — so the subsequent
  // pollComments OVERLAP_MS window has a chance to cover anything we
  // missed during the drain. Setting it to `now` would silently skip the
  // drain-duration interval forever.
  const queueAtEnd = await store.getBackfillQueue();
  if (queueAtEnd.length === 0) {
    // drainOneBackfillItem already advanced the stamp to `now` when the
    // queue emptied. Overwrite with `started` to reflect the actual
    // coverage horizon.
    await store.setTimestamp('lastBackfillSweepAt', started);
    log('poller.BACKFILL.drainAll.stamp',
      `lastBackfillSweepAt rewound to drain-start=${new Date(started).toISOString()} (not drain-end) so post-drain pollComments can recover missed replies`);
  }
  const durationMs = nowMs() - started;
  log('poller.BACKFILL.drainAll.done',
    `itemsProcessed=${itemsProcessed} repliesSurfaced=${repliesSurfaced} durationMs=${durationMs}`);
  return { itemsProcessed, repliesSurfaced };
}
