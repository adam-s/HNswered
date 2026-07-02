import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createStore, type Store } from '../../src/background/store.ts';
import {
  FAILURE_STREAK_ERROR_THRESHOLD,
  failureSignature,
  recordFailure,
  recordSuccess,
  reportPollFailure,
  trackPollOutcome,
} from '../../src/background/failure-streak.ts';

/** Capture console.warn/error calls for the duration of fn. */
async function withConsoleSpy(fn: (spy: { warns: unknown[][]; errors: unknown[][] }) => Promise<void>): Promise<void> {
  const spy = { warns: [] as unknown[][], errors: [] as unknown[][] };
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => { spy.warns.push(args); };
  console.error = (...args: unknown[]) => { spy.errors.push(args); };
  try {
    await fn(spy);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

test('failureSignature collapses rolling digits but preserves HTTP status codes', () => {
  const a = failureSignature(new Error('HTTP 400 https://hn.algolia.com/api/v1/search?tags=comment&numericFilters=parent_id=48749868,created_at_i%3E1781527864&hitsPerPage=1000'));
  const b = failureSignature(new Error('HTTP 400 https://hn.algolia.com/api/v1/search?tags=comment&numericFilters=parent_id=99999999,created_at_i%3E1781528462&hitsPerPage=1000'));
  // Same failure with different cursors/ids → same signature.
  assert.equal(a, b);
  // Different HTTP status on the same endpoint → DIFFERENT signature. The
  // status code is the most diagnostic token; collapsing it would make a
  // mixed 429/503 outage indistinguishable from a persistent 400.
  const c = failureSignature(new Error('HTTP 503 https://hn.algolia.com/api/v1/search?tags=comment&numericFilters=parent_id=48749868,created_at_i%3E1781527864&hitsPerPage=1000'));
  assert.notEqual(a, c);
  assert.ok(a.includes('HTTP 400'), `status preserved in signature: ${a}`);
  // Non-HTTP errors differ from HTTP ones.
  assert.notEqual(a, failureSignature(new Error('TypeError: Failed to fetch')));
});

test('failureSignature stringifies non-Error objects instead of [object Object]', () => {
  const a = failureSignature({ code: 'EAI_AGAIN' });
  const b = failureSignature({ code: 'ECONNRESET' });
  assert.notEqual(a, b);
  assert.notEqual(a, '[object Object]');
});

test('escalates at the threshold and keeps escalating past it', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const badRequest = new Error('HTTP 400 https://hn.algolia.com/api/v1/search?parent_id=1,created_at_i%3E2');

    for (let i = 1; i < FAILURE_STREAK_ERROR_THRESHOLD; i++) {
      const v = await recordFailure(store, badRequest);
      assert.deepEqual(v, { count: i, escalate: false, uniform: true });
    }
    const atThreshold = await recordFailure(store, badRequest);
    assert.deepEqual(atThreshold, { count: FAILURE_STREAK_ERROR_THRESHOLD, escalate: true, uniform: true });

    const past = await recordFailure(store, badRequest);
    assert.deepEqual(past, { count: FAILURE_STREAK_ERROR_THRESHOLD + 1, escalate: true, uniform: true });
  } finally {
    off();
  }
});

test('differing consecutive errors STILL escalate, but as a non-uniform streak', async () => {
  // Regression guard for the alternating-signature hole: syncAuthor fires
  // story+comment queries via Promise.all, so persistent breakage can
  // alternate between two signatures nondeterministically. Counting only
  // same-signature runs would keep permanent breakage at warn level forever.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const a = new Error('HTTP 400 https://x/tags=story,author_u');
    const b = new Error('HTTP 503 https://x/tags=comment,author_u');

    assert.deepEqual(await recordFailure(store, a), { count: 1, escalate: false, uniform: true });
    assert.deepEqual(await recordFailure(store, b), { count: 2, escalate: false, uniform: false });
    const third = await recordFailure(store, a);
    assert.deepEqual(third, { count: 3, escalate: FAILURE_STREAK_ERROR_THRESHOLD <= 3, uniform: false });
  } finally {
    off();
  }
});

test('a successful poll resets the streak', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const err = new Error('HTTP 400 whatever');

    for (let i = 0; i < FAILURE_STREAK_ERROR_THRESHOLD - 1; i++) {
      await recordFailure(store, err);
    }
    await recordSuccess(store);
    const v = await recordFailure(store, err);
    assert.deepEqual(v, { count: 1, escalate: false, uniform: true });
  } finally {
    off();
  }
});

test('streak survives an SW restart (persisted, not module state)', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const err = new Error('HTTP 400 persistent');
    const storeA = createStore(shim.storage.local);
    await recordFailure(storeA, err);
    await recordFailure(storeA, err);

    // New store instance over the same storage area = SW restarted.
    const storeB = createStore(shim.storage.local);
    const v = await recordFailure(storeB, err);
    assert.equal(v.count, 3);
    assert.equal(v.escalate, FAILURE_STREAK_ERROR_THRESHOLD <= 3);
  } finally {
    off();
  }
});

test('clearPerUserState clears the failure streak', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const err = new Error('HTTP 400 whatever');
    await recordFailure(store, err);
    await recordFailure(store, err);
    await store.clearPerUserState();
    const v = await recordFailure(store, err);
    assert.deepEqual(v, { count: 1, escalate: false, uniform: true });
  } finally {
    off();
  }
});

test('trackPollOutcome pairs failure-record and success-reset around the work', async () => {
  // The wiring invariant a mutation run proved untested: deleting the
  // success-reset from the tick path SURVIVED the suite. This drives the
  // wrapper the tick/refresh paths actually use through a fail→fail→succeed→
  // fail cycle and asserts the streak state at each step.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const boom = async () => { throw new Error('HTTP 400 poll blew up'); };
    const ok = async () => {};

    await withConsoleSpy(async (spy) => {
      await trackPollOutcome(store, 'tick', boom);
      await trackPollOutcome(store, 'tick', boom);
      assert.equal((await store.getFailureStreak()).count, 2);
      assert.equal(spy.warns.length, 2, 'below threshold → warn');
      assert.equal(spy.errors.length, 0);

      // Healthy poll resets — the next failure starts a new streak instead
      // of escalating.
      await trackPollOutcome(store, 'tick', ok);
      assert.equal((await store.getFailureStreak()).count, 0);
      await trackPollOutcome(store, 'tick', boom);
      assert.equal((await store.getFailureStreak()).count, 1);
      assert.equal(spy.errors.length, 0, 'reset prevented spurious escalation');
    });
  } finally {
    off();
  }
});

test('trackPollOutcome escalates to console.error on the threshold failure and never throws', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const boom = async () => { throw new Error('HTTP 400 poll blew up'); };

    await withConsoleSpy(async (spy) => {
      for (let i = 0; i < FAILURE_STREAK_ERROR_THRESHOLD; i++) {
        // Must not reject even though fn throws every time.
        await trackPollOutcome(store, 'tick', boom);
      }
      assert.equal(spy.errors.length, 1, 'exactly the threshold failure escalates');
      assert.match(String(spy.errors[0][0]), /polls in a row/);
      assert.equal(spy.warns.length, FAILURE_STREAK_ERROR_THRESHOLD - 1);
    });
  } finally {
    off();
  }
});

test('reportPollFailure survives broken storage and still reports the original error', async () => {
  // H2 regression guard: reportPollFailure runs inside catch blocks; if the
  // streak write throws (storage broken), it must neither swallow the report
  // nor leak a rejection out of the catch.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const real = createStore(shim.storage.local);
    const broken: Store = {
      ...real,
      async getFailureStreak() { throw new Error('QUOTA_BYTES exceeded'); },
      async setFailureStreak() { throw new Error('QUOTA_BYTES exceeded'); },
    };
    const original = new Error('HTTP 400 the actual poll failure');

    await withConsoleSpy(async (spy) => {
      await reportPollFailure(broken, 'tick', original); // must not throw
      assert.equal(spy.errors.length, 1, 'falls back to unconditional console.error');
      assert.ok(spy.errors[0].includes(original), 'original error is in the report');
    });
  } finally {
    off();
  }
});
