import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createStore } from '../../src/background/store.ts';
import {
  FAILURE_STREAK_ERROR_THRESHOLD,
  failureSignature,
  recordFailure,
  recordSuccess,
} from '../../src/background/failure-streak.ts';

test('failureSignature collapses digits so rolling cursors share a signature', () => {
  const a = failureSignature(new Error('HTTP 400 https://hn.algolia.com/api/v1/search?tags=comment&numericFilters=parent_id=48749868,created_at_i%3E1781527864&hitsPerPage=1000'));
  const b = failureSignature(new Error('HTTP 400 https://hn.algolia.com/api/v1/search?tags=comment&numericFilters=parent_id=48749868,created_at_i%3E1781528462&hitsPerPage=1000'));
  assert.equal(a, b);
  const c = failureSignature(new Error('TypeError: Failed to fetch'));
  assert.notEqual(a, c);
});

test('same error escalates at the threshold; a different error restarts the streak', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const badRequest = new Error('HTTP 400 https://hn.algolia.com/api/v1/search?parent_id=1,created_at_i%3E2');

    for (let i = 1; i < FAILURE_STREAK_ERROR_THRESHOLD; i++) {
      const v = await recordFailure(store, badRequest);
      assert.deepEqual(v, { count: i, escalate: false });
    }
    const atThreshold = await recordFailure(store, badRequest);
    assert.deepEqual(atThreshold, { count: FAILURE_STREAK_ERROR_THRESHOLD, escalate: true });

    // Streak keeps counting past the threshold (stays escalated).
    const past = await recordFailure(store, badRequest);
    assert.deepEqual(past, { count: FAILURE_STREAK_ERROR_THRESHOLD + 1, escalate: true });

    // A different error signature restarts from 1 — three unrelated
    // transient failures must NOT escalate.
    const other = await recordFailure(store, new Error('TypeError: Failed to fetch'));
    assert.deepEqual(other, { count: 1, escalate: false });
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
    // Post-reset, the same error starts over at 1 and does not escalate.
    const v = await recordFailure(store, err);
    assert.deepEqual(v, { count: 1, escalate: false });
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
    assert.deepEqual(v, { count: 1, escalate: false });
  } finally {
    off();
  }
});
