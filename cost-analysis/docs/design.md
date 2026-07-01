# HNswered polling design

Current-truth reference for how the extension should detect replies. Replaces
the earlier exploration docs and simulator reports.

## 1. Why not `/v0/updates.json`

The HN `/v0/updates.json` feed is a narrow rolling window — roughly 40
globally-changed item ids. Using it as a gate to decide which monitored items
are worth re-fetching silently drops replies on low-traffic items, because a
monitored item is rarely present in that window at the moment the alarm fires.
It is not a viable primitive for this extension and is not used.

The production poller already removed the gate; the disavowal lives in the
comment at [src/background/poller.ts:252](../../src/background/poller.ts#L252).
Any future design work should treat that comment as load-bearing and not
re-introduce `updates.json` under any name.

## 2. Architecture

Three layers, in priority order:

1. **Algolia comment-feed polling — primary reply detection.**
   One request against `search_by_date?tags=comment` covers every comment on
   HN within the overlap window. Filter hits where `parent_id ∈ monitored`.
   Cost does not scale with the number of monitored items or with per-item
   reply fan-out.

2. **Algolia author-sync — parent discovery.**
   Periodic `search_by_date?tags=(story,comment),author_<handle>` so newly
   authored user items are known before replies land on them.

3. **Backfill catch-up — gap recovery.**
   Per-parent `search?tags=comment&numericFilters=parent_id=<id>,created_at_i>floor`
   sweep that fills offline-gap coverage holes the rolling comment-feed window
   can't cover, plus first-configure history catch-up. See §7 for the full
   design. Algolia-only; **no Firebase recovery layer**. The retrospective
   sweep (reports/report.md) measured 99.99% live agreement between Algolia
   `parent_id` and Firebase `kids[]` minus dead/deleted, which is the bar for
   correctness here — a Firebase cross-check would cost ~1 req per monitored
   item per day for ~0.01% coverage improvement.

### Correctness invariant

**Overlap window ≥ max(comment-poll interval, author-sync interval).**
If the overlap is shorter than the author-sync interval, a reply on a
freshly-authored comment can age out of the window before the author-sync
discovers the parent. This is the only non-obvious correctness trap.

### Implementation sketch

On each poll (one alarm tick, all three gates evaluated):

1. If `AUTHOR_SYNC_MS` has elapsed since `lastAuthorSync`, run
   `search_by_date?tags=(story,comment),author_<handle>&numericFilters=created_at_i>author_cursor_minus_overlap`
   (paginated up to 5 pages per tag) and update the `monitored` map.
2. If a backfill trigger is satisfied and `backfillQueue` is empty, enqueue
   eligible monitored parents (see §7).
3. Query comments:
   `search_by_date?tags=comment&numericFilters=created_at_i>now_minus_overlap&hitsPerPage=1000`.
4. Filter hits where `parent_id ∈ monitored` and `author !== hnUser`.
5. `addReplies` (idempotent via reply id); surface `inserted` count.
6. If `backfillQueue` is non-empty, drip-drain one parent (see §7).

No Firebase fallback. The retrospective sweep (reports/report.md) measured
Algolia `parent_id` at 99.99% live agreement vs Firebase `kids[]` minus
dead/deleted; a periodic Firebase cross-check would add ~1 req per monitored
item per day to recover the remaining ~0.01% and is not currently worth the
cost. If production telemetry later shows systematic Algolia index-lag misses,
revisit.

## 3. Configurations

Req/day counts Algolia comment-feed polls + Algolia author-sync + backfill
drip. Backfill fullDrain bursts (user-triggered) are excluded from steady-state
numbers; a 500-parent fullDrain at 1.5s pacing is ~500 requests in ~12 min,
which dwarfs a day of steady-state polling but only happens on first configure,
user change, or `backfillDays` widening.

### Shipped profiles

The Settings UI offers `tickMinutes ∈ {1, 5, 15, 30}` (clamped by
`MAX_TICK_MINUTES`) and `AUTHOR_SYNC_MS = 10min` hard-coded. `OVERLAP_MS = 45min`
gives >30min of cushion above every permitted setting — correctness invariant
§2 always holds.

| Name | Comment poll | Author sync | Overlap | Algolia req/day (steady) | Median surface | p95 surface |
|---|---:|---:|---:|---:|---:|---:|
| Minimum | 30m | 10m | 45m | ~240 | 15m | 28m |
| Moderate | 15m | 10m | 45m | ~240 | 7.5m | 14m |
| Balanced (default) | 5m | 10m | 45m | ~432 | 2.5m | 4.7m |
| Fast | 1m | 10m | 45m | ~1,728 | 30s | 57s |

"Req/day (steady)" includes one backfill drain per tick (dedupe path, ~0
inserts) once the initial sweep completes.

### Why no sub-minute cadence

The 2026-04-23 sweep confirmed that in-window reply catch is saturation-bound
by Algolia indexing lag around the 30-60s range, not by poll cadence. Going
sub-minute burns budget without moving p50/p95 meaningfully, and MV3 service
workers don't guarantee sub-minute alarm wake reliability. The 1-minute floor
in `MAX_TICK_MINUTES`-derived settings is both a correctness floor (invariant
§2) and a cost-effectiveness floor. If a user needs truly live notifications,
they should check HN directly — that's not this product.

### Tempting configs that fail the invariant

`poll=10m, sync=30m, overlap=10m` costs the same 192 req/day as Minimum with a
lower median, but comment-reply catch drops from 100% to ~87% within 1h. The
30-minute author sync lets reply events on freshly-authored comments age out
of the 10m overlap before the parent is known. Don't skimp on overlap vs. sync.

## 4. Sample methodology

Two datasets informed the frontier:

- **Initial live dataset** — 449 authored items, 1,490 non-self direct replies
  (1,379 story-replies, 111 comment-replies) collected via the extension's
  live audit path.
- **Widened Algolia story sample** — 497 recent story trees, 6,081 non-self
  direct reply edges (1,663 story-replies, 4,418 comment-replies). Median
  reply-age-from-parent 4,091s; p95 45,500s. Only ~0.1% of replies arrive
  within 60s of the parent; ~5.3% within 5 minutes.

The widened sample confirmed the same saturation point (~12–15s polling) as
the initial dataset.

**Collection note:** a 1,000-story burst with high concurrency triggered
Algolia `403 Forbidden`. A 500-story pass completed cleanly. Future widening
should keep concurrency modest and page/time-slice collection rather than
bursting the full cap.

## 5. Caching invariants

Store in `chrome.storage.local` (keys as shipped in [src/background/store.ts](../../src/background/store.ts)):

- `monitored` — map keyed by HN id; each entry has `id`, `type`, `submittedAt`, plus optional `title` / `excerpt` / `parentAuthor` for sidepanel hydration.
- `replies` — map keyed by reply id; each entry has author, text, parent id, `read`, `discoveredAt`.
- `lastCommentPoll`, `lastAuthorSync` — cadence-gate timestamps.
- `lastBackfillSweepAt`, `backfillSweepFloor`, `backfillQueue` — backfill state (see §7).

**Correctness comes from the overlap window plus dedupe.** Timestamps are an
optimization to shrink query ranges. If a cursor is lost or corrupted, the
overlap window (and the backfill floor) still catches everything; the system
degrades to slightly more hits per poll, not to missed replies.

Retention/pruning follows the existing policy: read replies past
`retentionDays` are dropped on each `syncAuthor` run; unread replies are never
auto-evicted. Hard cap at 5,000 replies across both buckets (read-first
eviction).

## 6. Validation

The shipped architecture was validated two ways:

1. **Retrospective sweep** ([reports/report.md](reports/report.md)): 19,819 parents × (Algolia `parent_id` vs Firebase `kids[]` minus dead/deleted) cross-check. 99.99% live agreement per-parent averaged. Confirmed Algolia `parent_id` is effectively authoritative for direct descendants — the premise that made the "no Firebase recovery" decision safe.
2. **Live audit harness** ([scripts/audit.mjs](../../scripts/audit.mjs) + [scripts/audit-analyze.mjs](../../scripts/audit-analyze.mjs)): bounded multi-user run against real HN over a configurable window. Divergence analyzer checks missed-replies, phantom-replies, self-contamination, retention, coverage, politeness against a fresh HN ground-truth fetch. See the [audit skill](../../.agents/skills/audit/SKILL.md) for invocation.

Both are repeatable. The sweep is a one-shot empirical snapshot; the audit is a watch-it-live harness. Re-run the sweep after any HN schema drift; re-run the audit before releases or after refactors touching polling/sync/storage paths.

## 7. Backfill catch-up design

The rolling comment-feed window covers live operation but misses two cases:

- **First configure** — replies that pre-date the install sit outside the 45-min window. Without catch-up, a new user sees an empty sidepanel until someone replies to their next post.
- **Offline gaps > OVERLAP_MS** — if the SW suspended for >45 min (laptop closed, Chrome killed), replies that landed during the gap age out of the window before the next live poll.

The backfill subsystem handles both with one mechanism: per-parent Algolia sweeps gated by a pinned floor.

### Data model

Three storage keys (all in `chrome.storage.local`):

- `backfillQueue: number[]` — parent ids pending sweep, DESC by `submittedAt` (most recent first).
- `backfillSweepFloor: number` (ms since epoch) — **pinned at enqueue time**, defines the `since` passed to `searchByParent` for every parent in the current sweep. Reset to 0 when queue empties.
- `lastBackfillSweepAt: number` — timestamp of the most recent completed sweep. Stamped to **drain-start**, not drain-end, so post-drain live polling has a chance to catch replies that arrived mid-drain.

### Triggers (in [maybeEnqueueBackfillSweep](../../src/background/poller.ts))

Enqueue fires if ANY of these hold AND the queue is empty (guards against re-storming mid-sweep):

1. **First configure / user change** — `lastBackfillSweepAt === 0` and `monitored` is non-empty.
2. **Gap > OVERLAP_MS** — `now - lastBackfillSweepAt > OVERLAP_MS`. Catches offline gaps.
3. **`backfillDays` widened** — user moves from 7 → 30 or 30 → 90 in Settings. Re-sweeps with the new deeper floor. Handled inline in `runRefresh(fullDrain=true)` from the config-change handler.
4. **Absence invalidation** — during a live `pollComments` tick, if a parent that *should* have returned a reply returns none, the sweep floor is widened and the queue is invalidated for re-sweep.

Computed floor at enqueue time: `since = max(lastBackfillSweepAt - OVERLAP_MS, now - backfillDays * DAY_MS)`. The `- OVERLAP_MS` back-nudge is intentional — it's cheap insurance against a missed reply on the edge of the previous sweep.

### Drain cadence

Two modes:

- **Drip** (`drainOneBackfillItem`, one parent per alarm tick) — default for gap-triggered and upgrade-in-place sweeps. Holds `LOCK.TICK` briefly (one Algolia request), does not block live polling meaningfully.
- **FullDrain** (`drainBackfillQueueCompletely`, all parents in one burst, `DRAIN_ALL_DELAY_MS=1500ms` pacing) — for user-change and `backfillDays`-widened paths where the user is actively waiting for catch-up. Holds `LOCK.TICK` for the duration (up to 12 min at 500 parents); alarm-tick polling coalesces during this window. The drain-start stamp on `lastBackfillSweepAt` preserves post-drain coverage.

Both modes call into `drainOneBackfillItem` for each parent, which:

1. Pops the head of `backfillQueue`
2. Checks the parent is still monitored (not evicted mid-sweep)
3. Calls `searchByParent(id, sinceSec)` where `sinceSec = floor(backfillSweepFloor / 1000)`
4. Filters self-replies, dedupes via idempotent `addReplies`
5. Persists the shortened queue
6. On empty queue: advances `lastBackfillSweepAt`, clears `backfillSweepFloor`

### Cost

- Drip: one `searchByParent` request per tick while queue is non-empty. Bounded by `monitored.size`. Typical user: 50–500 parents drained over 50–500 ticks (~4–42 hours at 5-min cadence). Since `sinceSec` filters replies, drained parents typically return 0–2 hits each.
- FullDrain: 500 parents × 1.5s = 12.5 min wall time, ~500 requests. Single burst per user-change or widen. Dwarfs a day of steady-state cost but is user-triggered and infrequent.
- Incremental: per-parent incremental cursors (only re-sweep past the newest stored reply) were tried and removed — they were unsafe across absence invalidations and silently skipped gap replies. Over-fetching is dedup'd cheaply by `addReplies`; correctness > speed.

### Correctness

The backfill floor is pinned at enqueue, not re-computed during drain. Every parent in one sweep uses the same `sinceSec`, so a 12-minute fullDrain doesn't shrink the window for the parents drained later. This is the "sliding-window bug" that red-team round #2 caught before it shipped — load-bearing enough that the test suite has an explicit REGRESSION HIGH test for it ([tests/unit/temporal-backfill.test.ts](../../tests/unit/temporal-backfill.test.ts)).
