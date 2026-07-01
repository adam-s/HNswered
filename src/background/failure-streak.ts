/**
 * Consecutive-failure escalation for tick/refresh polling.
 *
 * A single failed poll is usually a transient network/API hiccup and
 * self-heals on the next tick — surfacing it as console.error would put a
 * red entry in chrome://extensions for something that needs no action. But
 * the SAME error repeating tick after tick is the signature of persistent
 * breakage (an upstream API change, or an extension bug) that a human needs
 * to look at — that's exactly how the 2026-07 Algolia `parent_id` filter
 * removal manifested. So: warn below the threshold, error at it.
 *
 * The streak lives in chrome.storage.local (via Store), not module state:
 * the MV3 SW suspends between ticks, and a module counter would reset to
 * zero before three 5-minute ticks ever accumulated.
 */
import type { Store } from './store.ts';

/** Consecutive same-signature failures before escalating to console.error. */
export const FAILURE_STREAK_ERROR_THRESHOLD = 3;

/**
 * Normalize an error into a streak signature. Digits are collapsed so the
 * rolling parts of request URLs (created_at_i cursors, item ids, HTTP status
 * interpolations) don't make every occurrence of the same failure look
 * unique.
 */
export function failureSignature(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\d+/g, '#');
}

export interface FailureVerdict {
  /** Consecutive failures with this signature, including this one. */
  count: number;
  /** True once the streak reaches the threshold — log console.error. */
  escalate: boolean;
}

/** Record a failed poll. Returns whether the caller should escalate. */
export async function recordFailure(store: Store, err: unknown): Promise<FailureVerdict> {
  const signature = failureSignature(err);
  const prior = await store.getFailureStreak();
  const count = prior.signature === signature ? prior.count + 1 : 1;
  await store.setFailureStreak({ signature, count });
  return { count, escalate: count >= FAILURE_STREAK_ERROR_THRESHOLD };
}

/** Record a successful poll — resets any streak. */
export async function recordSuccess(store: Store): Promise<void> {
  await store.clearFailureStreak();
}
