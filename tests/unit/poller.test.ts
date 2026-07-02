import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createFakeHN } from '../shim/fake-hn.ts';
import { createStore } from '../../src/background/store.ts';
import {
  ageMs,
  computeBackfillSinceMs,
  drainOneBackfillItem,
  maybeEnqueueBackfillSweep,
  maybeSyncAuthor,
  pollComments,
  syncAuthor,
  toMonitoredFromAuthorHit,
  toReplyFromCommentHit,
} from '../../src/background/poller.ts';
import { AUTHOR_SYNC_MS, DAY_MS, DROP_AGE_MS, OVERLAP_MS } from '../../src/shared/constants.ts';
import type { AlgoliaAuthorHit, AlgoliaCommentHit, MonitoredItem } from '../../src/shared/types.ts';

// Builders — keep tests legible.

function commentHit(over: Partial<AlgoliaCommentHit> & { id: number; parent_id: number }): AlgoliaCommentHit {
  const secondsNow = Math.floor(Date.now() / 1000);
  return {
    objectID: String(over.id),
    created_at_i: over.created_at_i ?? secondsNow,
    author: over.author ?? 'other',
    comment_text: over.comment_text ?? `reply to ${over.parent_id}`,
    parent_id: over.parent_id,
    story_id: over.story_id,
  };
}

function authorStoryHit(over: Partial<AlgoliaAuthorHit> & { id: number; author: string }): AlgoliaAuthorHit {
  const secondsNow = Math.floor(Date.now() / 1000);
  return {
    objectID: String(over.id),
    created_at_i: over.created_at_i ?? secondsNow,
    author: over.author,
    _tags: ['story', `author_${over.author}`],
    title: over.title ?? `story ${over.id}`,
  };
}

function authorCommentHit(over: Partial<AlgoliaAuthorHit> & { id: number; author: string }): AlgoliaAuthorHit {
  const secondsNow = Math.floor(Date.now() / 1000);
  return {
    objectID: String(over.id),
    created_at_i: over.created_at_i ?? secondsNow,
    author: over.author,
    _tags: ['comment', `author_${over.author}`],
    comment_text: over.comment_text ?? `authored by ${over.author}`,
    story_id: over.story_id ?? 9999,
  };
}

function monitoredStory(over: Partial<MonitoredItem> & { id: number }): MonitoredItem {
  return {
    id: over.id,
    type: 'story',
    submittedAt: over.submittedAt ?? Date.now(),
    title: over.title ?? `story ${over.id}`,
  };
}

function monitoredComment(over: Partial<MonitoredItem> & { id: number }): MonitoredItem {
  return {
    id: over.id,
    type: 'comment',
    submittedAt: over.submittedAt ?? Date.now(),
    excerpt: over.excerpt ?? `excerpt of ${over.id}`,
  };
}

// -----------------------------------------------------------------------------
// Pure-function tests
// -----------------------------------------------------------------------------

test('toMonitoredFromAuthorHit recognises stories and comments via _tags', () => {
  const story = toMonitoredFromAuthorHit(authorStoryHit({ id: 100, author: 'alice' }));
  assert.equal(story?.type, 'story');
  assert.equal(story?.id, 100);
  assert.equal(story?.title, 'story 100');

  const comment = toMonitoredFromAuthorHit(authorCommentHit({ id: 200, author: 'alice' }));
  assert.equal(comment?.type, 'comment');
  assert.equal(comment?.id, 200);
  assert.ok(comment?.excerpt?.includes('authored by alice'));
});

test('toMonitoredFromAuthorHit rejects non-story/comment types', () => {
  const pollHit: AlgoliaAuthorHit = {
    objectID: '42',
    created_at_i: 1_700_000_000,
    author: 'alice',
    _tags: ['poll', 'author_alice'],
  };
  assert.equal(toMonitoredFromAuthorHit(pollHit), null);
});

test('toMonitoredFromAuthorHit infers from field presence when _tags missing', () => {
  const noTags: AlgoliaAuthorHit = {
    objectID: '1',
    created_at_i: 1_700_000_000,
    author: 'alice',
    title: 'headline',
  };
  assert.equal(toMonitoredFromAuthorHit(noTags)?.type, 'story');
});

test('toReplyFromCommentHit rejects hits with no author or non-numeric objectID', () => {
  const parent = monitoredStory({ id: 1 });
  assert.equal(
    toReplyFromCommentHit({ ...commentHit({ id: 2, parent_id: 1 }), author: '' }, parent),
    null,
  );
  assert.equal(
    toReplyFromCommentHit({ ...commentHit({ id: 2, parent_id: 1 }), objectID: 'not-a-number' }, parent),
    null,
  );
});

// -----------------------------------------------------------------------------
// pollComments
// -----------------------------------------------------------------------------

test('pollComments surfaces a direct reply on a monitored story', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    await store.upsertMonitored(monitoredStory({ id: 100 }));
    hn.seedComment(commentHit({ id: 500, parent_id: 100, author: 'bob' }));

    const res = await pollComments(hn, store);

    assert.equal(res.newReplies, 1);
    const replies = Object.values(await store.getReplies());
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, 500);
    assert.equal(replies[0].author, 'bob');
    assert.equal(replies[0].parentItemId, 100);
    assert.equal(replies[0].parentItemTitle, 'story 100');
  } finally { off(); }
});

test('pollComments filters self-replies (case-insensitive)', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'Alice' });
    await store.upsertMonitored(monitoredStory({ id: 100 }));
    hn.seedComment(commentHit({ id: 501, parent_id: 100, author: 'alice' }));
    hn.seedComment(commentHit({ id: 502, parent_id: 100, author: 'ALICE' }));
    hn.seedComment(commentHit({ id: 503, parent_id: 100, author: 'bob' }));

    const res = await pollComments(hn, store);

    assert.equal(res.newReplies, 1);
    const replies = Object.values(await store.getReplies());
    assert.equal(replies[0].id, 503);
    assert.equal(replies[0].author, 'bob');
  } finally { off(); }
});

test('pollComments ignores hits whose parent is not monitored', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    await store.upsertMonitored(monitoredStory({ id: 100 }));
    hn.seedComment(commentHit({ id: 600, parent_id: 9999, author: 'bob' }));
    hn.seedComment(commentHit({ id: 601, parent_id: 8888, author: 'carol' }));
    hn.seedComment(commentHit({ id: 602, parent_id: 100, author: 'dan' }));

    const res = await pollComments(hn, store);

    assert.equal(res.newReplies, 1);
    const replies = Object.values(await store.getReplies());
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, 602);
  } finally { off(); }
});

test('pollComments dedupes on repeat calls via addReplies idempotency', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    await store.upsertMonitored(monitoredStory({ id: 100 }));
    hn.seedComment(commentHit({ id: 700, parent_id: 100, author: 'bob' }));

    await pollComments(hn, store);
    await pollComments(hn, store);

    const replies = Object.values(await store.getReplies());
    assert.equal(replies.length, 1, 'duplicate poll must not duplicate the reply');
  } finally { off(); }
});

test('pollComments skips when there is no hnUser or no monitored items', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();

    let res = await pollComments(hn, store);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-user');

    await store.setConfig({ hnUser: 'alice' });
    res = await pollComments(hn, store);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-monitored');
  } finally { off(); }
});

test('pollComments hydrates comment-parent excerpt on replies', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    await store.upsertMonitored(monitoredComment({ id: 300, excerpt: 'my earlier thought' }));
    hn.seedComment(commentHit({ id: 800, parent_id: 300, author: 'bob', comment_text: 'great point' }));

    await pollComments(hn, store);

    const replies = Object.values(await store.getReplies());
    assert.equal(replies[0].parentExcerpt, 'my earlier thought');
    assert.equal(replies[0].parentItemTitle, undefined);
  } finally { off(); }
});

// -----------------------------------------------------------------------------
// syncAuthor
// -----------------------------------------------------------------------------

test('syncAuthor adds newly-authored stories and comments to monitored', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    hn.seedAuthorItem('alice', authorStoryHit({ id: 1000, author: 'alice', title: 'my story' }));
    hn.seedAuthorItem('alice', authorCommentHit({ id: 1001, author: 'alice' }));

    const added = await syncAuthor(hn, store);

    assert.equal(added, 2);
    const monitored = await store.getMonitored();
    assert.equal(monitored['1000']?.type, 'story');
    assert.equal(monitored['1000']?.title, 'my story');
    assert.equal(monitored['1001']?.type, 'comment');
  } finally { off(); }
});

test('syncAuthor drops items older than DROP_AGE_MS', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    const ancientSec = Math.floor((Date.now() - 2 * DROP_AGE_MS) / 1000);
    hn.seedAuthorItem('alice', authorStoryHit({ id: 2000, author: 'alice', created_at_i: ancientSec }));
    hn.seedAuthorItem('alice', authorStoryHit({ id: 2001, author: 'alice' }));

    const added = await syncAuthor(hn, store);

    assert.equal(added, 1);
    const monitored = await store.getMonitored();
    assert.equal(monitored['2000'], undefined);
    assert.ok(monitored['2001']);
  } finally { off(); }
});

test('syncAuthor records lastAuthorSync timestamp', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    hn.seedAuthorItem('alice', authorStoryHit({ id: 3000, author: 'alice' }));

    assert.equal((await store.getTimestamps()).lastAuthorSync, 0);
    await syncAuthor(hn, store);
    assert.ok((await store.getTimestamps()).lastAuthorSync > 0);
  } finally { off(); }
});

test('syncAuthor does not overwrite an existing monitored entry', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    await store.upsertMonitored(monitoredStory({ id: 4000, title: 'original title' }));
    hn.seedAuthorItem('alice', authorStoryHit({ id: 4000, author: 'alice', title: 'REPLACED' }));

    await syncAuthor(hn, store);

    const monitored = await store.getMonitored();
    assert.equal(monitored['4000']?.title, 'original title', 'existing entry preserved (idempotent add)');
  } finally { off(); }
});

// Note: first-sync backfill is now handled by the dedicated backfill worker
// (maybeEnqueueBackfillSweep + drainOneBackfillItem) rather than baked into
// syncAuthor. See the "Backfill" test section near the bottom of this file.

// -----------------------------------------------------------------------------
// maybeSyncAuthor (cadence-gated)
// -----------------------------------------------------------------------------

test('maybeSyncAuthor runs on first call then gates until AUTHOR_SYNC_MS elapses', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice' });
    hn.seedAuthorItem('alice', authorStoryHit({ id: 5000, author: 'alice' }));

    const added1 = await maybeSyncAuthor(hn, store);
    assert.equal(added1, 1);
    assert.ok((await store.getTimestamps()).lastAuthorSync > 0);

    // Call again immediately — must be gated.
    hn.seedAuthorItem('alice', authorStoryHit({ id: 5001, author: 'alice' }));
    const added2 = await maybeSyncAuthor(hn, store);
    assert.equal(added2, 0, 'second call within AUTHOR_SYNC_MS must not run syncAuthor');
    assert.equal((await store.getMonitored())['5001'], undefined);

    // Simulate cadence elapsed.
    await store.setTimestamp('lastAuthorSync', Date.now() - AUTHOR_SYNC_MS - 1000);
    const added3 = await maybeSyncAuthor(hn, store);
    assert.equal(added3, 1, 'after cadence elapsed, sync runs and picks up the new item');
  } finally { off(); }
});

// -----------------------------------------------------------------------------
// ageMs
// -----------------------------------------------------------------------------

test('ageMs reports milliseconds since submission', () => {
  const now = 1_000_000;
  const m = monitoredStory({ id: 1, submittedAt: now - 60_000 });
  assert.equal(ageMs(m, now), 60_000);
});

// ===========================================================================
// Backfill — "catch up after absence"
//
// Temporal-logic tests. The backfill worker has three moving parts:
//
//   1. computeBackfillSinceMs(now, lastBackfillSweepAt, backfillDays)
//      = max(lastBackfillSweepAt, now - backfillDays*DAY_MS)
//
//   2. maybeEnqueueBackfillSweep(store, now) — enqueue items from monitored
//      posted within the backfillDays window, newest-first, but ONLY when a
//      "gap" is detected: `now - lastCommentPoll > OVERLAP_MS` (or
//      lastCommentPoll == 0, meaning first install).
//
//   3. drainOneBackfillItem(client, store, now) — pop head, searchByParent
//      with `since = computeBackfillSinceMs`, addReplies, persist shortened
//      queue. When queue empties, set `lastBackfillSweepAt = now`.
//
// The invariant we're proving: **every reply posted during an absence to a
// monitored item within the backfillDays window is surfaced**, nothing older
// or outside the window is fetched, and re-triggers don't re-storm.
// ===========================================================================

// --- 1. computeBackfillSinceMs (pure) --------------------------------------

test('computeBackfillSinceMs: first install → now - depth', () => {
  const now = 10 * DAY_MS;
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: 0, backfillDays: 7 });
  assert.equal(since, now - 7 * DAY_MS);
});

test('computeBackfillSinceMs: brief absence → lastBackfillSweepAt (gap only)', () => {
  const now = 30 * DAY_MS;
  const lastSweep = now - 3 * 60 * 60 * 1000; // 3 hours ago
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: lastSweep, backfillDays: 7 });
  assert.equal(since, lastSweep, '3hr absence with 7d depth: since=lastSweep, not depth floor');
});

test('computeBackfillSinceMs: long absence exceeding depth → now - depth (depth caps)', () => {
  const now = 100 * DAY_MS;
  const lastSweep = now - 30 * DAY_MS; // 30 days ago
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: lastSweep, backfillDays: 7 });
  assert.equal(since, now - 7 * DAY_MS, 'depth (7d) wins over lastSweep (30d ago)');
});

test('computeBackfillSinceMs: at exact boundary (lastSweep == now - depth)', () => {
  const now = 50 * DAY_MS;
  const lastSweep = now - 7 * DAY_MS;
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: lastSweep, backfillDays: 7 });
  assert.equal(since, lastSweep, 'ties resolve to lastSweep (Math.max equal values)');
});

test('computeBackfillSinceMs: 90-day depth, 4-week absence → 4 weeks (gap)', () => {
  const now = 200 * DAY_MS;
  const lastSweep = now - 28 * DAY_MS;
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: lastSweep, backfillDays: 90 });
  assert.equal(since, lastSweep, '28d < 90d depth → since=lastSweep');
});

// --- 2. maybeEnqueueBackfillSweep — gap-trigger + ordering -----------------

test('enqueue: first install (lastCommentPoll=0) triggers and queues past-week items, DESC by submittedAt', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;
    // Three items inside past week, one outside. Intentional interleaved IDs
    // to distinguish ordering-by-submittedAt from ordering-by-id.
    await store.setMonitored({
      '1': monitoredStory({ id: 1, submittedAt: now - 3 * DAY_MS }),   // 3d old
      '2': monitoredStory({ id: 2, submittedAt: now - 1 * DAY_MS }),   // 1d old (newest)
      '3': monitoredStory({ id: 3, submittedAt: now - 6 * DAY_MS }),   // 6d old
      '4': monitoredStory({ id: 4, submittedAt: now - 8 * DAY_MS }),   // 8d old — OUTSIDE
    });

    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 3, 'three items within depth; id=4 excluded');

    const queue = await store.getBackfillQueue();
    assert.deepEqual(queue, [2, 1, 3], 'DESC by submittedAt: 1d < 3d < 6d ago');
  } finally { off(); }
});

test('enqueue: gap ≤ OVERLAP_MS after a successful poll → no-op (no re-storm)', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;
    await store.setTimestamp('lastCommentPoll', now - 60 * 1000); // 1 min ago (< OVERLAP_MS)
    // Pretend a prior sweep already completed so the "never-swept" trigger doesn't fire.
    await store.setTimestamp('lastBackfillSweepAt', now - 60 * 1000);
    await store.setMonitored({ '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }) });

    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 0, 'back-to-back ticks never re-enqueue');
    assert.deepEqual(await store.getBackfillQueue(), []);
  } finally { off(); }
});

test('enqueue: gap > OVERLAP_MS triggers after the threshold', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;
    // Just over the threshold — a tick that wakes up from a 46-min suspension.
    await store.setTimestamp('lastCommentPoll', now - OVERLAP_MS - 60 * 1000);
    await store.setMonitored({ '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }) });

    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 1);
  } finally { off(); }
});

test('enqueue: no-op while a sweep is in progress (queue non-empty)', async () => {
  // Contract: maybeEnqueueBackfillSweep is a no-op when the queue is non-empty.
  // Without this gate, drained items would be re-enqueued on every tick (they
  // are still in monitored, and the dedupe against `existing` does not catch
  // an item that was popped from the queue but not yet removed from monitored).
  // Result: queue would stay pinned at ~original size, never draining.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({
      '10': monitoredStory({ id: 10, submittedAt: now - 4 * DAY_MS }),
      '11': monitoredStory({ id: 11, submittedAt: now - 2 * DAY_MS }),
    });
    await store.setBackfillQueue([10]); // sweep already in progress

    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 0, 'sweep in progress → no re-enqueue');

    const queue = await store.getBackfillQueue();
    assert.deepEqual(queue, [10], 'queue untouched — existing sweep drains to completion first');
  } finally { off(); }
});

test('enqueue: no user, no monitored, or no-trigger — all no-ops', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const now = 100 * DAY_MS;
    // No user
    assert.equal(await maybeEnqueueBackfillSweep(store, now), 0);
    // User set but monitored empty
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    assert.equal(await maybeEnqueueBackfillSweep(store, now), 0);
    // Monitored has items OUTSIDE depth window → still no-op
    await store.setMonitored({ '99': monitoredStory({ id: 99, submittedAt: now - 30 * DAY_MS }) });
    assert.equal(await maybeEnqueueBackfillSweep(store, now), 0);
    assert.deepEqual(await store.getBackfillQueue(), []);
  } finally { off(); }
});

// --- 3. drainOneBackfillItem — windowed fetch + state progression ---------

test('drain: queue empty → 0, no side effects', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const surfaced = await drainOneBackfillItem(hn, store, 100 * DAY_MS);
    assert.equal(surfaced, 0);
    assert.equal(hn.counts().searchByParent, 0);
  } finally { off(); }
});

test('drain: pops head, calls searchByParent with computed since, surfaces replies', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;
    const lastSweep = now - 3 * 60 * 60 * 1000; // 3h ago

    await store.setTimestamp('lastBackfillSweepAt', lastSweep);
    await store.setMonitored({ '7': monitoredStory({ id: 7, submittedAt: now - 2 * DAY_MS }) });
    await store.setBackfillQueue([7]);

    // Seed two replies: one OLDER than lastSweep (should be filtered by fake-hn
    // since shim), one NEWER.
    const oldSec = Math.floor((lastSweep - 1000) / 1000);
    const newSec = Math.floor((now - 60_000) / 1000);
    hn.seedParentChild(7, commentHit({ id: 101, parent_id: 7, created_at_i: oldSec, author: 'bob' }));
    hn.seedParentChild(7, commentHit({ id: 102, parent_id: 7, created_at_i: newSec, author: 'carol' }));

    const surfaced = await drainOneBackfillItem(hn, store, now);
    assert.equal(surfaced, 1, 'only the reply newer than `since` is surfaced');
    const replies = await store.getReplies();
    assert.ok(replies['102'], 'newer reply stored');
    assert.ok(!replies['101'], 'older reply NOT stored — filtered by Algolia since-filter');
  } finally { off(); }
});

test('drain: filters out self-replies case-insensitively', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'Alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({ '5': monitoredStory({ id: 5, submittedAt: now - 1 * DAY_MS }) });
    await store.setBackfillQueue([5]);

    const s = Math.floor((now - 60_000) / 1000);
    hn.seedParentChild(5, commentHit({ id: 201, parent_id: 5, created_at_i: s, author: 'ALICE' }));
    hn.seedParentChild(5, commentHit({ id: 202, parent_id: 5, created_at_i: s, author: 'other' }));

    const surfaced = await drainOneBackfillItem(hn, store, now);
    assert.equal(surfaced, 1);
    const replies = await store.getReplies();
    assert.ok(replies['202']);
    assert.ok(!replies['201'], 'self-reply filtered');
  } finally { off(); }
});

test('drain: fetch failure rotates the head to the tail and rethrows — one bad parent cannot starve the queue', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({
      '7': monitoredStory({ id: 7, submittedAt: now - 2 * DAY_MS }),
      '8': monitoredStory({ id: 8, submittedAt: now - 3 * DAY_MS }),
    });
    await store.setBackfillQueue([7, 8]);
    await store.setTimestamp('backfillSweepFloor', now - 5 * DAY_MS);

    // Parent 7's query fails deterministically (the 2026-07 Algolia
    // parent_id incident shape); parent 8 works.
    const flaky = {
      ...hn,
      searchByParent: async (id: number, since?: number) => {
        if (id === 7) throw new Error('HTTP 400 https://hn.algolia.com/api/v1/search_by_date?parent_id=7');
        return hn.searchByParent(id, since);
      },
    };

    await assert.rejects(
      () => drainOneBackfillItem(flaky, store, now),
      /HTTP 400/,
      'the failure still propagates so the tick-level streak sees it',
    );
    assert.deepEqual(await store.getBackfillQueue(), [8, 7], 'failed head rotated to tail, not stuck and not dropped');
    const ts = await store.getTimestamps();
    assert.equal(ts.backfillSweepFloor, now - 5 * DAY_MS, 'pinned floor untouched by the rotation');

    // Next drain serves parent 8 — the bad head no longer blocks it.
    const s = Math.floor((now - 60_000) / 1000);
    hn.seedParentChild(8, commentHit({ id: 301, parent_id: 8, created_at_i: s, author: 'bob' }));
    const surfaced = await drainOneBackfillItem(flaky, store, now);
    assert.equal(surfaced, 1, 'parent behind the failing head drains normally');
    assert.deepEqual(await store.getBackfillQueue(), [7], 'bad parent stays queued for retry');
  } finally { off(); }
});

test('drain: parent evicted since enqueue → silently drops, no Algolia call for missing parent', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({}); // parent 99 is NOT in monitored
    await store.setBackfillQueue([99]);

    const surfaced = await drainOneBackfillItem(hn, store, now);
    assert.equal(surfaced, 0);
    assert.deepEqual(await store.getBackfillQueue(), [], 'evicted parent removed from queue');
    assert.equal(hn.counts().searchByParent, 0, 'no Algolia call wasted on evicted parent');
  } finally { off(); }
});

test('drain: queue emptying advances lastBackfillSweepAt to now', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({ '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }) });
    await store.setBackfillQueue([1]);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, 0);

    await drainOneBackfillItem(hn, store, now);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, now,
      'sweep complete → lastBackfillSweepAt = now');
  } finally { off(); }
});

test('drain: queue not empty → lastBackfillSweepAt unchanged', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 100 * DAY_MS;

    await store.setMonitored({
      '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }),
      '2': monitoredStory({ id: 2, submittedAt: now - 2 * DAY_MS }),
    });
    await store.setBackfillQueue([1, 2]);
    await drainOneBackfillItem(hn, store, now);

    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, 0,
      'one item remains — sweep not yet complete, timestamp not advanced');
    assert.deepEqual(await store.getBackfillQueue(), [2]);
  } finally { off(); }
});

// --- 4. Full scenario — user-requested temporal cases ---------------------

async function setupScenario(opts: {
  hnUser: string;
  backfillDays: number;
  now: number;
  lastCommentPoll: number;
  lastBackfillSweepAt?: number;
  monitored: Array<{ id: number; ageMs: number }>;
}) {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  const store = createStore(shim.storage.local);
  await store.setConfig({ hnUser: opts.hnUser, backfillDays: opts.backfillDays });
  await store.setTimestamp('lastCommentPoll', opts.lastCommentPoll);
  if (opts.lastBackfillSweepAt !== undefined) {
    await store.setTimestamp('lastBackfillSweepAt', opts.lastBackfillSweepAt);
  }
  const monitored: Record<string, MonitoredItem> = {};
  for (const m of opts.monitored) {
    monitored[String(m.id)] = monitoredStory({ id: m.id, submittedAt: opts.now - m.ageMs });
  }
  await store.setMonitored(monitored);
  const hn = createFakeHN();
  return { store, hn, cleanup: off };
}

test('scenario: off 3 hours, 1-week setting — enqueue past-week, since=3h-ago', async () => {
  const now = 500 * DAY_MS;
  const threeHrs = 3 * 60 * 60 * 1000;
  const { store, hn, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 7, now,
    lastCommentPoll: now - threeHrs,
    lastBackfillSweepAt: now - threeHrs, // prior sweep completed 3h ago
    monitored: [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 6 * DAY_MS },
      { id: 3, ageMs: 8 * DAY_MS }, // OUTSIDE 7d depth
    ],
  });
  try {
    await maybeEnqueueBackfillSweep(store, now);
    const queue = await store.getBackfillQueue();
    assert.deepEqual(queue, [1, 2], 'within depth, DESC by submittedAt; id=3 excluded');

    // Seed a reply posted during the 3h gap (2h ago, NEW) and one posted 5h ago
    // (before lastBackfillSweepAt; should not be returned by Algolia since-filter).
    const inGapSec = Math.floor((now - 2 * 60 * 60 * 1000) / 1000);
    const preSweepSec = Math.floor((now - 5 * 60 * 60 * 1000) / 1000);
    hn.seedParentChild(1, commentHit({ id: 500, parent_id: 1, created_at_i: inGapSec, author: 'bob' }));
    hn.seedParentChild(1, commentHit({ id: 501, parent_id: 1, created_at_i: preSweepSec, author: 'bob' }));

    const surfaced = await drainOneBackfillItem(hn, store, now);
    assert.equal(surfaced, 1, 'only the 2h-old reply (inside gap) surfaces');

    // Verify the since was computed correctly (should be lastBackfillSweepAt, not depth-floor).
    const logs = hn.log();
    const call = logs.find((l) => l.includes('parent_id=1'));
    assert.ok(call);
    const sinceArg = Number((call ?? '').match(/since=(\d+)/)?.[1] ?? 0);
    assert.equal(sinceArg, Math.floor((now - threeHrs) / 1000),
      'since = lastBackfillSweepAt (3h ago), not depth floor');
  } finally { cleanup(); }
});

test('scenario: off 2 days, 1-week setting — enqueue past-week, since=2d-ago (gap)', async () => {
  const now = 500 * DAY_MS;
  const twoDays = 2 * DAY_MS;
  const { store, hn, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 7, now,
    lastCommentPoll: now - twoDays,
    lastBackfillSweepAt: now - twoDays,
    monitored: [
      { id: 10, ageMs: 0.5 * DAY_MS },
      { id: 20, ageMs: 3 * DAY_MS },
      { id: 30, ageMs: 10 * DAY_MS }, // OUTSIDE 7d
    ],
  });
  try {
    await maybeEnqueueBackfillSweep(store, now);
    assert.deepEqual(await store.getBackfillQueue(), [10, 20]);

    hn.seedParentChild(10, commentHit({
      id: 700, parent_id: 10, author: 'bob',
      created_at_i: Math.floor((now - 1 * DAY_MS) / 1000), // 1 day ago (inside 2d gap)
    }));
    await drainOneBackfillItem(hn, store, now);

    const logs = hn.log();
    const sinceArg = Number(logs.find((l) => l.includes('parent_id=10'))?.match(/since=(\d+)/)?.[1] ?? 0);
    assert.equal(sinceArg, Math.floor((now - twoDays) / 1000),
      '2d absence < 7d depth → since = 2d ago');
  } finally { cleanup(); }
});

test('scenario: off 4 weeks, 1-week setting — enqueue past-WEEK only, since=7d-ago (depth caps)', async () => {
  const now = 500 * DAY_MS;
  const fourWeeks = 28 * DAY_MS;
  const { store, hn, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 7, now,
    lastCommentPoll: now - fourWeeks,
    lastBackfillSweepAt: now - fourWeeks,
    monitored: [
      { id: 1, ageMs: 3 * DAY_MS },  // within week
      { id: 2, ageMs: 6 * DAY_MS },  // within week (edge)
      { id: 3, ageMs: 14 * DAY_MS }, // week 2 — user said weeks 2+ are ignored
      { id: 4, ageMs: 21 * DAY_MS }, // week 3 — ignored
    ],
  });
  try {
    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 2, 'only the two past-week items; older weeks ignored');
    assert.deepEqual(await store.getBackfillQueue(), [1, 2]);

    hn.seedParentChild(1, commentHit({
      id: 800, parent_id: 1, author: 'bob',
      created_at_i: Math.floor((now - 5 * DAY_MS) / 1000),
    }));
    await drainOneBackfillItem(hn, store, now);
    const logs = hn.log();
    const sinceArg = Number(logs.find((l) => l.includes('parent_id=1'))?.match(/since=(\d+)/)?.[1] ?? 0);
    assert.equal(sinceArg, Math.floor((now - 7 * DAY_MS) / 1000),
      'depth (7d) caps since — we never fetch older than depth');
  } finally { cleanup(); }
});

test('scenario: off 4 weeks, 3-month setting — enqueue past 3mo, since=4-weeks-ago (gap wins)', async () => {
  const now = 500 * DAY_MS;
  const fourWeeks = 28 * DAY_MS;
  const { store, hn, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 90, now,
    lastCommentPoll: now - fourWeeks,
    lastBackfillSweepAt: now - fourWeeks,
    monitored: [
      { id: 1, ageMs: 10 * DAY_MS },
      { id: 2, ageMs: 60 * DAY_MS },
      { id: 3, ageMs: 85 * DAY_MS },
      { id: 4, ageMs: 120 * DAY_MS }, // outside 90d
    ],
  });
  try {
    const n = await maybeEnqueueBackfillSweep(store, now);
    assert.equal(n, 3);

    hn.seedParentChild(2, commentHit({
      id: 900, parent_id: 2, author: 'bob',
      created_at_i: Math.floor((now - 10 * DAY_MS) / 1000),
    }));
    // Process each queue item. Order DESC: [1, 2, 3].
    const logs: string[] = [];
    for (let i = 0; i < 3; i++) {
      await drainOneBackfillItem(hn, store, now);
      logs.push(...hn.log().slice(logs.length));
    }
    const sinceArg = Number(
      hn.log().find((l) => l.includes('parent_id=2'))?.match(/since=(\d+)/)?.[1] ?? 0,
    );
    assert.equal(sinceArg, Math.floor((now - fourWeeks) / 1000),
      '4w absence < 90d depth → since = 4w ago (the actual gap), not 90d');
  } finally { cleanup(); }
});

test('scenario: full drain completes — queue empties, timestamp advances, subsequent tick does nothing', async () => {
  const now = 500 * DAY_MS;
  const { store, hn, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 7, now,
    lastCommentPoll: now - 2 * 60 * 60 * 1000,
    lastBackfillSweepAt: now - 2 * 60 * 60 * 1000,
    monitored: [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 2 * DAY_MS },
      { id: 3, ageMs: 3 * DAY_MS },
    ],
  });
  try {
    await maybeEnqueueBackfillSweep(store, now);
    assert.equal((await store.getBackfillQueue()).length, 3);

    // Drip three ticks.
    await drainOneBackfillItem(hn, store, now);
    await drainOneBackfillItem(hn, store, now);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, now - 2 * 60 * 60 * 1000,
      'not yet advanced — still one item in queue');
    await drainOneBackfillItem(hn, store, now);
    assert.equal((await store.getBackfillQueue()).length, 0);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, now,
      'queue drained → advanced to now');

    // Simulate a new tick 1 minute later. lastCommentPoll gets updated by pollComments
    // in real flow; for this test we set it manually to prove the gap check.
    const laterNow = now + 60 * 1000;
    await store.setTimestamp('lastCommentPoll', laterNow);
    const n = await maybeEnqueueBackfillSweep(store, laterNow + 1000);
    assert.equal(n, 0, 'no gap → no re-enqueue');
  } finally { cleanup(); }
});

test('scenario: back-to-back 1-min ticks never re-enqueue once steady-state', async () => {
  const now = 500 * DAY_MS;
  const { store, cleanup } = await setupScenario({
    hnUser: 'alice', backfillDays: 7, now,
    lastCommentPoll: now - 60 * 1000, // last tick was 1 min ago — steady state
    lastBackfillSweepAt: now - 60 * 60 * 1000,
    monitored: [{ id: 1, ageMs: 1 * DAY_MS }],
  });
  try {
    assert.equal(await maybeEnqueueBackfillSweep(store, now), 0);
    assert.equal(await maybeEnqueueBackfillSweep(store, now + 60_000), 0);
    assert.equal(await maybeEnqueueBackfillSweep(store, now + 120_000), 0);
  } finally { cleanup(); }
});

test('scenario: state persists across store re-creation (simulates SW suspension)', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const now = 500 * DAY_MS;
    // SW alive — enqueue.
    {
      const store = createStore(shim.storage.local);
      await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
      await store.setMonitored({
        '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }),
        '2': monitoredStory({ id: 2, submittedAt: now - 2 * DAY_MS }),
      });
      await maybeEnqueueBackfillSweep(store, now);
    }
    // SW suspended, re-spawned — new store instance over same storage.
    {
      const store2 = createStore(shim.storage.local);
      assert.deepEqual(await store2.getBackfillQueue(), [1, 2],
        'queue survives store re-creation (chrome.storage.local persists)');
    }
  } finally { off(); }
});

test('scenario: re-drain same parent after sweep complete — since advances, Algolia filters old replies', async () => {
  // Proves the full round-trip of the `since` cursor: after the first sweep
  // completes, lastBackfillSweepAt=now, so a subsequent drain of the same
  // parent queries Algolia with since=now and gets nothing (the reply we seeded
  // is older than now). This guards the "don't re-storm identical requests"
  // property — combined with addReplies idempotency, re-enqueues are cheap.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const now = 500 * DAY_MS;
    await store.setMonitored({ '1': monitoredStory({ id: 1, submittedAt: now - 1 * DAY_MS }) });
    hn.seedParentChild(1, commentHit({
      id: 555, parent_id: 1, author: 'bob',
      created_at_i: Math.floor((now - 60_000) / 1000),
    }));

    await store.setBackfillQueue([1]);
    assert.equal(await drainOneBackfillItem(hn, store, now), 1);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, now);

    // Second drain at the same `now` — since=now → no hits returned.
    await store.setBackfillQueue([1]);
    assert.equal(await drainOneBackfillItem(hn, store, now), 0, 'since=now filters everything');

    const replies = await store.getReplies();
    assert.equal(Object.keys(replies).length, 1, 'the one reply from the first drain remains');
  } finally { off(); }
});

// -----------------------------------------------------------------------------
// Algolia client pagination guard
// -----------------------------------------------------------------------------
// Production's searchByAuthor / searchByParent paginate up to MAX_PAGES=5 and
// rely on `hits.length < ALGOLIA_HITS_PER_PAGE` to stop. The fake-HN shim
// returns all seeded hits in one shot — so for a seed of <1000 hits, only
// page 0 is ever fetched, making pagination logic untested by every other
// test in this file. This test exercises the pagination branch directly.
// -----------------------------------------------------------------------------

import { algoliaClient } from '../../src/background/algolia-client.ts';
import { ALGOLIA_HITS_PER_PAGE } from '../../src/shared/constants.ts';

test('algolia-client: searchByParent paginates when a page is full (MAX_PAGES cap)', async () => {
  // Intercept fetch with a scripted responder that returns exactly
  // ALGOLIA_HITS_PER_PAGE hits on page 0 and 2 hits on page 1, then a short
  // page on page 2 to prove the stop condition fires.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    const pageMatch = url.match(/[&?]page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 0;
    const hitsCount = page === 0 ? ALGOLIA_HITS_PER_PAGE : page === 1 ? ALGOLIA_HITS_PER_PAGE : 3;
    const hits = Array.from({ length: hitsCount }, (_, i) => ({
      objectID: String(page * ALGOLIA_HITS_PER_PAGE + i),
      created_at_i: 1_700_000_000,
      author: 'bob',
      comment_text: 'x',
      parent_id: 42,
    }));
    return {
      ok: true,
      json: async () => ({ hits, nbPages: 1, page }), // nbPages=1 lie — must be ignored
    } as Response;
  }) as typeof fetch;
  try {
    const hits = await algoliaClient.searchByParent(42);
    assert.equal(hits.length, ALGOLIA_HITS_PER_PAGE * 2 + 3,
      'three pages fetched: 1000 + 1000 + 3 = 2003');
    assert.equal(calls.length, 3, 'exactly three page requests');
    // Prove first-page URL did NOT include &page=0 (byte-identical to pre-pagination shape).
    assert.ok(!calls[0].includes('&page='), 'page 0 URL omits explicit page param');
    assert.ok(calls[1].includes('&page=1'));
    assert.ok(calls[2].includes('&page=2'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('algolia-client: searchByAuthor paginates both tag queries (story AND comment) past the nbPages=1 lie', async () => {
  // Mutation M3: searchByAuthor's paginate() stop condition
  // `data.hits.length < ALGOLIA_HITS_PER_PAGE` — flipping to `<=` would
  // exit after the first page, silently truncating prolific authors (the
  // pjmlp nbHits=7681 nbPages=1 case from the research sweep). searchByParent
  // has a test for this; searchByAuthor did not, and the mutation survived.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    const pageMatch = url.match(/[&?]page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 0;
    // Both tag queries paginate identically: page 0 full, page 1 short.
    const hitsCount = page === 0 ? ALGOLIA_HITS_PER_PAGE : 7;
    const isStory = url.includes('tags=story');
    const hits = Array.from({ length: hitsCount }, (_, i) => ({
      objectID: String(page * ALGOLIA_HITS_PER_PAGE + i + (isStory ? 100_000 : 0)),
      created_at_i: 1_700_000_000,
      author: 'pjmlp',
      title: isStory ? 'x' : undefined,
      comment_text: isStory ? undefined : 'x',
      story_id: isStory ? undefined : 42,
    }));
    return {
      ok: true,
      json: async () => ({ hits, nbPages: 1, page }), // nbPages=1 lie
    } as Response;
  }) as typeof fetch;
  try {
    const hits = await algoliaClient.searchByAuthor('pjmlp', 0);
    // 2 full + 2 short pages = 4 fetches; 1000+7+1000+7 = 2014 hits total.
    assert.equal(calls.length, 4, 'four page requests (2 tags × 2 pages each)');
    assert.equal(hits.length, ALGOLIA_HITS_PER_PAGE * 2 + 14,
      `both tag queries drained past page 0 — got ${hits.length}`);
    // Sanity: each tag fired page 0 and page 1 exactly once.
    const storyCalls = calls.filter((u) => u.includes('tags=story'));
    const commentCalls = calls.filter((u) => u.includes('tags=comment'));
    assert.equal(storyCalls.length, 2, 'story tag: page 0 + page 1');
    assert.equal(commentCalls.length, 2, 'comment tag: page 0 + page 1');
    assert.ok(!storyCalls[0].includes('&page='), 'story page 0 omits explicit page param');
    assert.ok(storyCalls[1].includes('&page=1'));
    assert.ok(!commentCalls[0].includes('&page='));
    assert.ok(commentCalls[1].includes('&page=1'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('algolia-client: searchByParent stops at MAX_PAGES=5 even if every page is full', async () => {
  const realFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        hits: Array.from({ length: ALGOLIA_HITS_PER_PAGE }, (_, i) => ({
          objectID: String(callCount * 1000 + i),
          created_at_i: 1_700_000_000,
          author: 'bob',
          comment_text: 'x',
          parent_id: 42,
        })),
        nbPages: 1,
        page: callCount - 1,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const hits = await algoliaClient.searchByParent(42);
    assert.equal(callCount, 5, 'MAX_PAGES=5 cap enforced');
    assert.equal(hits.length, ALGOLIA_HITS_PER_PAGE * 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});
