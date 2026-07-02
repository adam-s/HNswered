export type ItemType = 'story' | 'comment' | 'job' | 'poll' | 'pollopt';

export interface HNItem {
  id: number;
  type?: ItemType;
  deleted?: boolean;
  dead?: boolean;
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  parent?: number;
  kids?: number[];
  descendants?: number;
  score?: number;
}

export interface HNUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

// Subset of Algolia HN API hit shapes that we consume. See
// https://hn.algolia.com/api for the full schema.

export interface AlgoliaCommentHit {
  objectID: string;
  created_at_i: number;
  author: string;
  comment_text: string | null;
  parent_id: number;
  story_id?: number;
}

export interface AlgoliaAuthorHit {
  objectID: string;
  created_at_i: number;
  author: string;
  _tags?: string[];
  title?: string;
  comment_text?: string | null;
  story_id?: number;
  parent_id?: number;
}

export interface Config {
  hnUser: string;
  tickMinutes: number;
  retentionDays: number;
  // How far back to reach when catching up on replies after an absence (or on
  // first install). Valid values: 7, 30, 90. The backfill worker only scans
  // items within this window — anything older is ignored regardless of how
  // long the extension was offline.
  backfillDays: number;
}

export interface MonitoredItem {
  id: number;
  type: 'story' | 'comment';
  submittedAt: number;
  title?: string;        // set when type=story; parent context for the sidepanel
  excerpt?: string;      // set when type=comment; truncated parent text
  parentAuthor?: string; // set when type=comment; author of the comment being replied to
}

export interface Reply {
  id: number;
  parentItemId: number;
  parentItemTitle?: string;   // set when parent is a story
  parentAuthor?: string;      // set when parent is a comment
  parentExcerpt?: string;     // truncated parent text (≈140 chars, tags stripped)
  author: string;
  text: string;
  time: number;
  read: boolean;
  discoveredAt: number;
}

export interface StoreSchema {
  config: Config;
  monitored: Record<string, MonitoredItem>;
  replies: Record<string, Reply>;
  lastCommentPoll: number;
  lastAuthorSync: number;
  // Timestamp of the most recent successful backfill "sweep" completion.
  // The next sweep fetches replies created since max(lastBackfillSweepAt,
  // now - backfillDays*DAY_MS) — see [poller.ts] backfill logic.
  lastBackfillSweepAt: number;
  // **Pinned `since` floor for the currently-active sweep.** Set when the
  // sweep is enqueued; every `drainOneBackfillItem` call in that sweep uses
  // this exact value, so long drains don't slide their window forward and
  // lose coverage of later-in-queue items. Cleared (set to 0) when the queue
  // empties. 0 means "no sweep in progress".
  backfillSweepFloor: number;
  // Parent item IDs awaiting backfill, ordered newest-first by
  // item.submittedAt at enqueue time. Drip worker pops the head each tick.
  backfillQueue: number[];
  // Consecutive tick/refresh failure tracking. Persisted (not in-memory)
  // because the MV3 SW suspends between ticks, which would reset a module
  // variable before a streak could ever accumulate.
  failureStreak: FailureStreak;
}

export interface FailureStreak {
  // Normalized error message (digits collapsed, HTTP status preserved) of
  // the MOST RECENT failure.
  signature: string;
  // Consecutive poll failures, regardless of signature. Any successful poll
  // resets to 0.
  count: number;
  // Whether every failure in the streak shares one signature — drives the
  // escalation message ("API change/bug" vs "outage").
  uniform: boolean;
}

export type TimestampKey =
  | 'lastCommentPoll'
  | 'lastAuthorSync'
  | 'lastBackfillSweepAt'
  | 'backfillSweepFloor';

export type SidepanelMessage =
  | { kind: 'list-replies' }
  | { kind: 'mark-read'; id: number }
  | { kind: 'mark-all-read' }
  | { kind: 'get-config' }
  | { kind: 'set-config'; config: Partial<Config> }
  | { kind: 'force-refresh' }
  | { kind: 'get-monitored' }
  | { kind: 'get-storage-stats' }
  | { kind: 'clear-read' }
  | { kind: 'clear-all-replies' }
  | { kind: 'reset-all' }
  | { kind: 'inspect' };

export interface StorageStats {
  replyCount: number;
  unreadCount: number;
  monitoredCount: number;
  bytesInUse: number;
}

export type SidepanelResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };
