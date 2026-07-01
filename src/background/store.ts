import type {
  Config,
  FailureStreak,
  MonitoredItem,
  Reply,
  StoreSchema,
  TimestampKey,
} from '../shared/types.ts';
import { BACKFILL_DAY_OPTIONS, DEFAULT_CONFIG, MAX_TICK_MINUTES } from '../shared/constants.ts';
import { log } from '../shared/debug.ts';

type Area = chrome.storage.StorageArea;

export interface Store {
  getConfig(): Promise<Config>;
  setConfig(partial: Partial<Config>): Promise<Config>;
  getMonitored(): Promise<Record<string, MonitoredItem>>;
  setMonitored(monitored: Record<string, MonitoredItem>): Promise<void>;
  upsertMonitored(item: MonitoredItem): Promise<void>;
  removeMonitored(ids: number[]): Promise<void>;
  getReplies(): Promise<Record<string, Reply>>;
  /** Idempotent (keyed by reply id). Returns the number of NEW rows written
   *  — duplicates from a prior call report 0. Callers log this to prove
   *  whether a fetch actually surfaced anything. */
  addReplies(replies: Reply[]): Promise<number>;
  markRead(id: number): Promise<void>;
  markAllRead(): Promise<void>;
  getUnreadCount(): Promise<number>;
  pruneReplies(opts: { readOlderThanMs?: number; hardCap?: number; orphanedIfMonitoredMissing?: boolean; now?: number }): Promise<number>;
  clearRead(): Promise<number>;
  clearAllReplies(): Promise<number>;
  clearPerUserState(): Promise<void>;
  getBytesInUse(): Promise<number>;
  getTimestamps(): Promise<Pick<StoreSchema, TimestampKey>>;
  setTimestamp(key: TimestampKey, ts: number): Promise<void>;
  getBackfillQueue(): Promise<number[]>;
  setBackfillQueue(queue: number[]): Promise<void>;
  getFailureStreak(): Promise<FailureStreak>;
  setFailureStreak(streak: FailureStreak): Promise<void>;
  /** No-op when the streak is already clear, so healthy ticks don't pay a
   *  storage write. */
  clearFailureStreak(): Promise<void>;
}

export function createStore(area: Area = chrome.storage.local): Store {
  async function get<K extends keyof StoreSchema>(key: K, fallback: StoreSchema[K]): Promise<StoreSchema[K]> {
    const res = (await area.get(key)) as Partial<StoreSchema>;
    const value = res[key];
    return (value ?? fallback) as StoreSchema[K];
  }
  async function set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): Promise<void> {
    await area.set({ [key]: value });
  }

  return {
    async getConfig() {
      return get('config', { ...DEFAULT_CONFIG });
    },
    async setConfig(partial) {
      const current = await this.getConfig();
      const merged = { ...current, ...partial };
      // Defense-in-depth clamps — the UI dropdowns are the first line, but a
      // legacy saved config (e.g. tickMinutes=60 from a prior build) or a
      // crafted setConfig call could otherwise bypass invariants the poller
      // depends on (OVERLAP_MS ≥ tickMinutes + AUTHOR_SYNC_MS) or hit the
      // Algolia politeness cap.
      const next = {
        ...merged,
        tickMinutes: Math.min(Math.max(1, merged.tickMinutes ?? DEFAULT_CONFIG.tickMinutes), MAX_TICK_MINUTES),
        backfillDays: BACKFILL_DAY_OPTIONS.includes(merged.backfillDays as 7 | 30 | 90)
          ? merged.backfillDays
          : DEFAULT_CONFIG.backfillDays,
      };
      await set('config', next);
      return next;
    },
    async getMonitored() {
      return get('monitored', {});
    },
    async setMonitored(monitored) {
      await set('monitored', monitored);
    },
    async upsertMonitored(item) {
      const current = await this.getMonitored();
      current[String(item.id)] = item;
      await set('monitored', current);
    },
    async removeMonitored(ids) {
      const current = await this.getMonitored();
      for (const id of ids) delete current[String(id)];
      await set('monitored', current);
    },
    async getReplies() {
      return get('replies', {});
    },
    async addReplies(newReplies) {
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      for (const r of newReplies) {
        if (!current[String(r.id)]) current[String(r.id)] = r;
      }
      const after = Object.keys(current).length;
      const inserted = after - before;
      log('store.addReplies', `incoming=${newReplies.length} inserted=${inserted} before=${before} after=${after}`);
      if (inserted > 0) await set('replies', current);
      return inserted;
    },
    async markRead(id) {
      const current = await this.getReplies();
      const r = current[String(id)];
      if (r && !r.read) {
        r.read = true;
        await set('replies', current);
      }
    },
    async markAllRead() {
      const current = await this.getReplies();
      let changed = false;
      for (const r of Object.values(current)) {
        if (!r.read) {
          r.read = true;
          changed = true;
        }
      }
      if (changed) await set('replies', current);
    },
    async getUnreadCount() {
      const current = await this.getReplies();
      let n = 0;
      for (const r of Object.values(current)) if (!r.read) n++;
      return n;
    },
    async pruneReplies(opts) {
      const now = opts.now ?? Date.now();
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      const monitored = opts.orphanedIfMonitoredMissing ? await this.getMonitored() : null;
      const entries = Object.entries(current);

      // Drop: (1) read replies past retention age, (2) orphaned READ replies whose parent
      // is no longer monitored. Unread replies are preserved even when orphaned — they
      // still have author/text/parentAuthor/parentExcerpt stored, so the UI can render
      // them without the parent. Preserves the "unread is never auto-evicted" contract.
      for (const [key, r] of entries) {
        if (opts.readOlderThanMs !== undefined && r.read && now - r.discoveredAt > opts.readOlderThanMs) {
          delete current[key];
          continue;
        }
        if (monitored && r.read && !monitored[String(r.parentItemId)]) {
          delete current[key];
          continue;
        }
      }

      // Hard cap: if still over, drop oldest read-first, then oldest unread as last resort.
      if (opts.hardCap !== undefined && Object.keys(current).length > opts.hardCap) {
        const remaining = Object.values(current).sort((a, b) => {
          if (a.read !== b.read) return a.read ? -1 : 1; // read first (older priority)
          return a.discoveredAt - b.discoveredAt;
        });
        const over = remaining.length - opts.hardCap;
        for (let i = 0; i < over; i++) delete current[String(remaining[i].id)];
      }

      const after = Object.keys(current).length;
      if (after !== before) await set('replies', current);
      return before - after;
    },
    async clearRead() {
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      for (const [key, r] of Object.entries(current)) {
        if (r.read) delete current[key];
      }
      const after = Object.keys(current).length;
      if (after !== before) await set('replies', current);
      return before - after;
    },
    async clearAllReplies() {
      const current = await this.getReplies();
      const n = Object.keys(current).length;
      if (n > 0) await set('replies', {});
      return n;
    },
    async clearPerUserState() {
      // Used when hnUser changes — wipe stale replies, monitored items, the
      // sync/poll timestamps, AND the backfill queue (which references
      // parent IDs belonging to the prior user). First-sync semantics kick
      // in on the next tick.
      await area.remove([
        'replies',
        'monitored',
        'lastCommentPoll',
        'lastAuthorSync',
        'lastBackfillSweepAt',
        'backfillSweepFloor',
        'backfillQueue',
        'failureStreak',
      ]);
    },
    async getBytesInUse() {
      if (typeof area.getBytesInUse !== 'function') return 0;
      return new Promise<number>((resolve) => {
        try {
          const maybePromise = (area as unknown as { getBytesInUse: (keys: null, cb: (bytes: number) => void) => Promise<number> | void }).getBytesInUse(null, (b) => resolve(b ?? 0));
          if (maybePromise && typeof (maybePromise as Promise<number>).then === 'function') {
            (maybePromise as Promise<number>).then((b) => resolve(b ?? 0), () => resolve(0));
          }
        } catch {
          resolve(0);
        }
      });
    },
    async getTimestamps() {
      const res = (await area.get(['lastCommentPoll', 'lastAuthorSync', 'lastBackfillSweepAt', 'backfillSweepFloor'])) as Partial<StoreSchema>;
      return {
        lastCommentPoll: res.lastCommentPoll ?? 0,
        lastAuthorSync: res.lastAuthorSync ?? 0,
        lastBackfillSweepAt: res.lastBackfillSweepAt ?? 0,
        backfillSweepFloor: res.backfillSweepFloor ?? 0,
      };
    },
    async setTimestamp(key, ts) {
      await set(key, ts);
    },
    async getBackfillQueue() {
      return get('backfillQueue', []);
    },
    async setBackfillQueue(queue) {
      await set('backfillQueue', queue);
    },
    async getFailureStreak() {
      return get('failureStreak', { signature: '', count: 0 });
    },
    async setFailureStreak(streak) {
      await set('failureStreak', streak);
    },
    async clearFailureStreak() {
      const current = await this.getFailureStreak();
      if (current.count > 0) await area.remove('failureStreak');
    },
  };
}
