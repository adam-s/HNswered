/**
 * Replay test for the concurrent-refresh scenario.
 *
 * The scenario definition (steps + expected golden + assertion mechanism) lives
 * in concurrent-refresh.ts and is shared with tests/harness/recorder.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriver } from '../driver.ts';
import { scenario } from './concurrent-refresh.ts';

test('parallel runRefresh calls coalesce into one slot of HN work', async () => {
  const driver = await createDriver({ scenario: scenario.name, mode: 'replay' });
  try {
    await scenario.run(driver);
    // Exact-consumption assertion: replay is deterministic, so the scenario
    // must make EXACTLY as many HN requests as the tape recorded. A loose
    // upper bound (the old <= 250) cannot catch a coalescing regression —
    // the duplicate refresh's TapeMisses are retried by fetchJSON and then
    // swallowed by the failure tracking, so the test would pass on storage
    // state alone. Extra requests can't hide from an exact count.
    assert.equal(
      driver.hnRequests.length,
      driver.tape.calls.length,
      `concurrent-refresh made ${driver.hnRequests.length} HN requests, tape recorded ${driver.tape.calls.length} — ` +
      `more means coalescing leaked a duplicate refresh, fewer means the scenario drifted from the tape`,
    );
  } finally {
    await driver.uninstall();
  }
});
