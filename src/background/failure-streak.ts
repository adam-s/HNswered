/**
 * Consecutive-failure escalation for tick/refresh polling.
 *
 * A single failed poll is usually a transient network/API hiccup and
 * self-heals on the next tick — surfacing it as console.error would put a
 * red entry in chrome://extensions for something that needs no action. But
 * failure repeating tick after tick is persistent breakage (an upstream API
 * change, an outage, or an extension bug) that a human needs to look at —
 * that's exactly how the 2026-07 Algolia `parent_id` filter removal
 * manifested. So: warn below the threshold, error at it.
 *
 * The streak counts ALL consecutive failures, not just same-signature ones:
 * `syncAuthor` fires story+comment queries via Promise.all, so persistent
 * breakage can alternate between two error signatures nondeterministically —
 * a same-signature-only streak would never escalate on it. The signature is
 * kept to make the escalation MESSAGE honest: a uniform streak reads as "API
 * change or bug", a mixed streak as "outage or connectivity".
 *
 * The streak lives in chrome.storage.local (via Store), not module state:
 * the MV3 SW suspends between ticks, and a module counter would reset to
 * zero before three 5-minute ticks ever accumulated. All reads/writes happen
 * inside LOCK.TICK (every caller holds it), which stands in for CAS.
 */
import type { Store } from './store.ts';
import { logErr } from '../shared/debug.ts';

/** Consecutive poll failures before escalating to console.error. */
export const FAILURE_STREAK_ERROR_THRESHOLD = 3;

/**
 * Normalize an error into a streak signature. Digits are collapsed so the
 * rolling parts of request URLs (created_at_i cursors, item ids) don't make
 * every occurrence of the same failure look unique — EXCEPT a 3-digit token
 * right after "HTTP ", which is a status code and the single most diagnostic
 * part of the message ("HTTP 400" = API contract change vs "HTTP 503" =
 * outage). Non-Error throws are JSON-stringified where possible so distinct
 * objects don't all collapse to "[object Object]".
 */
export function failureSignature(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'object' && err !== null) {
    try {
      msg = JSON.stringify(err) ?? String(err);
    } catch {
      msg = String(err);
    }
  } else {
    msg = String(err);
  }
  return msg.replace(/\d+/g, (match, offset: number) =>
    msg.slice(Math.max(0, offset - 5), offset) === 'HTTP ' ? match : '#');
}

export interface FailureVerdict {
  /** Consecutive poll failures, including this one. */
  count: number;
  /** True once the streak reaches the threshold — log console.error. */
  escalate: boolean;
  /** True when every failure in the streak shares one signature. */
  uniform: boolean;
}

/** Record a failed poll. Returns whether the caller should escalate. */
export async function recordFailure(store: Store, err: unknown): Promise<FailureVerdict> {
  const signature = failureSignature(err);
  const prior = await store.getFailureStreak();
  const count = prior.count + 1;
  const uniform = prior.count === 0 || ((prior.uniform ?? true) && prior.signature === signature);
  await store.setFailureStreak({ signature, count, uniform });
  return { count, escalate: count >= FAILURE_STREAK_ERROR_THRESHOLD, uniform };
}

/** Record a successful poll — resets any streak. */
export async function recordSuccess(store: Store): Promise<void> {
  await store.clearFailureStreak();
}

/**
 * Report a failed poll to the console at the right severity. NEVER throws —
 * this runs inside catch blocks, and a rejection escaping a catch would
 * surface as an unhandled SW rejection while silencing the original failure.
 * If the streak itself can't be persisted (storage broken), the original
 * error is reported at error level unconditionally.
 */
export async function reportPollFailure(store: Store, source: string, err: unknown): Promise<void> {
  let verdict: FailureVerdict | null = null;
  try {
    verdict = await recordFailure(store, err);
  } catch (streakErr) {
    logErr('failure-streak.reportPollFailure', 'could not persist streak', streakErr);
  }
  if (!verdict) {
    console.error(
      `[HNswered] ${source} failed, and the failure tracker could not persist state ` +
      `(storage error?). Original failure:`,
      err,
    );
    return;
  }
  const { count, escalate, uniform } = verdict;
  if (escalate && uniform) {
    console.error(
      `[HNswered] ${source} failed — same error ${count} polls in a row. ` +
      `This is NOT a transient hiccup; likely an HN/Algolia API change or an extension bug. ` +
      `Reply capture may be degraded until it's addressed:`,
      err,
    );
  } else if (escalate) {
    console.error(
      `[HNswered] ${source} failed — ${count} consecutive polls have failed (differing errors). ` +
      `Persistent problem: network/API outage, or an extension bug. ` +
      `Reply capture is degraded while this continues. Latest error:`,
      err,
    );
  } else {
    console.warn(
      `[HNswered] ${source} failed (${count}/${FAILURE_STREAK_ERROR_THRESHOLD} before escalation — ` +
      `transient unless failures continue):`,
      err,
    );
  }
}

/**
 * Run one poll cycle's work and record its outcome on the streak. NEVER
 * throws: failures are reported via reportPollFailure and swallowed, so
 * fire-and-forget callers (`void runRefresh(...)`, the inline fullDrain
 * path) cannot leak unhandled rejections. This wrapper — not the callers —
 * owns the success/failure bookkeeping, so the pairing is testable and a
 * caller can't wire one side without the other.
 */
export async function trackPollOutcome(store: Store, source: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logErr('failure-streak.trackPollOutcome', `${source} failed`, err);
    await reportPollFailure(store, source, err);
    return;
  }
  try {
    await recordSuccess(store);
  } catch (err) {
    // Storage failing on the success path: nothing actionable — the next
    // failure's reportPollFailure will surface storage breakage loudly.
    logErr('failure-streak.trackPollOutcome', 'could not clear streak', err);
  }
}
