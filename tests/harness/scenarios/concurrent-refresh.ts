/**
 * Scenario: parallel runRefresh calls must coalesce into one slot of HN work.
 *
 * Coalescing is provided by `navigator.locks.request(LOCK.TICK, ...)` in
 * exclusive mode (see src/background/index.ts runRefresh). Two concurrent
 * runRefresh calls queue on the same lock; when the second one reaches the
 * body, the throttle check already rejects it into the lock-drain path.
 *
 * HOW A COALESCING REGRESSION ACTUALLY FAILS THIS TEST.
 *
 * The recorded tape contains exactly TWO refresh-flows worth of HN traffic:
 *   1. One auto-refresh kicked off by the user-change branch in set-config.
 *   2. One refresh from the parallel pair below — *coalesced into a single
 *      slot of work* by the Web Lock.
 *
 * A TapeMiss alone is NOT the assertion (an earlier version of this header
 * claimed it was — falsely): a duplicate refresh's TapeMiss is retried by
 * fetchJSON's backoff and then swallowed by the failure tracking in the
 * refresh path, so the run itself completes. The regression is caught by two
 * independent checks instead:
 *   1. The exact request-count assertion in concurrent-refresh.test.ts —
 *      duplicate refreshes make more requests than the tape recorded.
 *   2. The `failureStreak` field in the storage golden — a swallowed
 *      TapeMiss failure leaves a non-null streak behind, diverging from the
 *      committed snapshot.
 *
 * What the test does NOT cover:
 *   - Multi-driver-per-process scenarios (chrome shim + dynamic import are
 *     single-driver per process, by design — see driver.ts header). The
 *     benefit of serializing across multiple sidepanel contexts that Web
 *     Locks gives us can't be exercised here without process orchestration.
 */
import type { Driver } from '../driver.ts';

// Mirrors src/background/index.ts MIN_REFRESH_INTERVAL_MS. Hardcoded here so
// the scenario stays a black-box test of behavior, not an import of internals.
const MIN_REFRESH_INTERVAL_MS = 10_000;

export const scenario = {
  name: 'concurrent-refresh',
  user: 'mfiguiere',
  async run(driver: Driver): Promise<void> {
    // Step 1: configure handle. set-config detects the user change, calls
    // clearPerUserState, kicks off `void runRefresh()` (fire-and-forget).
    await driver.send({ kind: 'set-config', config: { hnUser: scenario.user, tickMinutes: 5 } });

    // Step 2: drain the auto-refresh. force-refresh from this same instant is
    // throttled (lastForceRefreshAt was just set by the auto-refresh), falls
    // through to runTick → singleFlight returns the in-flight slot → both
    // promises resolve when the original refresh completes.
    await driver.send({ kind: 'force-refresh' });

    // Step 3: advance past the throttle window so the next refresh path does
    // real work (otherwise it'd just throttle and coalesce trivially).
    await driver.clock.tickAsync(MIN_REFRESH_INTERVAL_MS + 1_000);

    // Step 4: THE TEST. Fire two parallel runRefresh calls.
    //
    // JS execution order under V8:
    //   - Call A starts. Body runs synchronously up to its first internal
    //     await: reads Date.now, computes sinceLastMs > threshold (unthrottled),
    //     sets lastForceRefreshAt = now, acquires LOCK.TICK exclusively.
    //     Control yields at the lock's first internal await.
    //   - Call B starts. Body runs synchronously: reads the just-set
    //     lastForceRefreshAt, computes sinceLastMs = 0 (throttled), enters
    //     the lock-drain path: `navigator.locks.request(LOCK.TICK, () => {})`
    //     queues behind call A and resolves when call A releases.
    //
    // Tape captures only call A's traffic. If call B somehow executed
    // separately, its Algolia searches would overrun the tape → TapeMiss →
    // test fails with a clear diagnostic.
    await Promise.all([driver.bg.runRefresh(), driver.bg.runRefresh()]);

    await driver.expectGolden('after-coalesced-refresh');
  },
};
