/**
 * Replay test for the first-configure scenario.
 *
 * The scenario definition (steps + expected golden names) lives in
 * first-configure.ts and is shared with tests/harness/recorder.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriver } from '../driver.ts';
import { scenario } from './first-configure.ts';

test('first-configure replays deterministically against tape', async () => {
  const driver = await createDriver({ scenario: scenario.name, mode: 'replay' });
  try {
    await scenario.run(driver);
    // Exact-consumption assertion (see concurrent-refresh.test.ts for the
    // rationale): deterministic replay must consume exactly the tape. This
    // doubles as the politeness budget — the tape length IS the recorded
    // request cost of the scenario.
    assert.equal(
      driver.hnRequests.length,
      driver.tape.calls.length,
      `first-configure made ${driver.hnRequests.length} HN requests, tape recorded ${driver.tape.calls.length}`,
    );
  } finally {
    await driver.uninstall();
  }
});
