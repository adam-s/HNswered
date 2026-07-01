---
name: mutation-red-team
description: Launch an adversarial mutation-testing agent (Opus) that injects targeted regressions into production code, runs the test suite, and reports which mutations SURVIVED — surviving mutations are direct evidence of test-coverage gaps. Use when the user says "trickster", "mutation test", "break the code", "can the tests catch regressions", "grade the tests", or after adding production code whose test coverage you're not sure about.
---

# Mutation red-team (the trickster)

Launches an **Opus** general-purpose agent that does what a mischievous human reviewer would do if given a worktree and told "try to break this without the tests catching it." It picks a load-bearing invariant, silently mutates it, runs `pnpm type-check && pnpm test && pnpm harness:replay`, and reports the verdict per mutation.

**Surviving mutations are the finding.** A SURVIVED mutation means the test suite could not distinguish broken code from working code — a concrete coverage gap, pointing at a specific invariant that no test actually enforces. This is complementary to [test-red-team](../test-red-team/SKILL.md) (which reads tests statically) and [red-team-review](../red-team-review/SKILL.md) (which reads prod statically) — mutation-red-team is the dynamic, empirical check: does the suite *actually* catch bad code.

For context on why mutation scores beat coverage metrics: the classic Meta ACH / BugGen / AdverTest line of work, plus the plain-English version at [Test Double — "Keep your coding agent on task with mutation testing"](https://testdouble.com/insights/keep-your-coding-agent-on-task-with-mutation-testing).

## When to invoke

- User says: "trickster", "mutation test", "break the code", "grade the tests", "can my tests catch regressions", "find what my tests don't cover"
- After a red-team-review finds a prod bug — run mutations against that invariant to confirm the regression test you just added actually catches future recurrences
- After a large PR that added production code — spot-check the test suite before declaring it covered
- Proactively on invariants the user flags as load-bearing (anything listed under AGENTS.md "Hard rules" / "Load-bearing invariants")
- **Do NOT run** during an in-flight `audit` or live HN observation — worktree commands share `dist/` build output with the main tree via gitignored paths, and mutating the dist is not the point.

## How to invoke

Use the `Agent` tool with:

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `isolation: "worktree"` — **mandatory**. The agent edits production code; without isolation it would dirty the user's working tree. With isolation, a clean revert at the end of the run makes the worktree auto-clean up.
- `description`: 3–5 word description (e.g. `"Mutation red-team poller"`)
- `prompt`: follow the template below
- One agent invocation per mutation. To cover N mutations, issue N parallel Agent calls in a single message — each gets its own worktree and runs independently.

## Curated mutations (this project)

Do NOT let the agent pick random lines. The signal-to-noise is terrible for random mutants. Hand-pick from load-bearing invariants documented in [AGENTS.md](../../../AGENTS.md) and from prior red-team findings. Starter set for HNswered:

1. **Self-reply filter** — in [src/background/poller.ts](../../../src/background/poller.ts) `pollComments`, change `hit.author.toLowerCase() === hnUserLc` to `!==` (or delete the continue). A test suite that does its job must have a test seeding a self-authored reply and asserting it is NOT surfaced.
2. **OVERLAP_MS ≥ AUTHOR_SYNC_MS assertion** — in [src/shared/constants.ts](../../../src/shared/constants.ts), loosen the module-load check (e.g., drop the `throw`). A principled suite must exercise that assertion path.
3. **Pagination stop condition** — in [src/background/algolia-client.ts](../../../src/background/algolia-client.ts) `searchByAuthor`, swap `data.hits.length < ALGOLIA_HITS_PER_PAGE` to `<=`. This is the exact bug we burned on (the `nbPages=1` lie); a regression test was added — does it catch this?
4. **addReplies no-op guard** — drop the `if (inserted > 0)` before `set('replies')`. Silent performance regression. Hard to catch; SURVIVED here is acceptable if the invariant is unobservable from the outside.
5. **drainAll startTime stamp** — in [src/background/poller.ts](../../../src/background/poller.ts) `drainBackfillQueueCompletely`, change `setTimestamp('lastBackfillSweepAt', started)` to `nowMs()`. This is the red-team #3 bug; its regression test lives in [tests/unit/temporal-backfill.test.ts](../../../tests/unit/temporal-backfill.test.ts). Must be CAUGHT.
6. **Backfill sweep floor reset** — skip the `setTimestamp('backfillSweepFloor', 0)` call when the queue empties. Next sweep's floor would be stale.
7. **Retention inequality off-by-one** — in [src/background/store.ts](../../../src/background/store.ts) `pruneReplies`, flip `>` to `>=` on the retention age comparison.
8. **User-change clear** — in `clearPerUserState`, drop `backfillQueue` from the removed keys. Queue now references the previous user's parent IDs; next drain references evicted parents. Does any test cover switching users with a non-empty queue?

Each of these targets a **named invariant** in AGENTS.md or a **prior regression test**. A SURVIVED result on any of them is a specific, actionable coverage gap.

## Prompt template

Fill the bracketed sections. Send ONE mutation per agent invocation.

```
You are a trickster. Your job is to introduce a specific regression into
production code, run the test suite, and report whether the tests caught
you. You are operating in an isolated git worktree — edit freely, the
tree is disposable.

## Rules

- Apply EXACTLY the mutation specified below. Do not invent other mutations.
- Do not touch any test file, harness file, tape, golden, or constants
  unrelated to the mutation. If the mutation is in constants, change only
  the specified constant or assertion.
- Do not modify `dist/`. The test harness reads only source.
- After applying the mutation, run:
    pnpm type-check && pnpm test && pnpm harness:replay
  Capture stdout+stderr. Note which of the three steps failed (if any).
- Revert the mutation (`git checkout -- <file>` or equivalent) before
  exiting so the worktree auto-cleans.

## Mutation

File: [ABSOLUTE PATH]
Change: [EXACT BEFORE → AFTER, e.g. `x < y` → `x <= y`]
Reasoning-for-humans: [one sentence — which invariant this probes]

## Verdict

Report exactly:
- CAUGHT if any of the three commands (type-check / test / harness) failed
  after the mutation was applied
- SURVIVED if all three passed

For CAUGHT: name the test(s) that failed (look for `not ok` / `FAIL` /
error traces in the captured output). One to three sentence summary —
is the failure specific to the invariant, or incidental?

For SURVIVED: this is the interesting case. State what the mutation
means the code now does incorrectly, and speculate on what kind of test
would have caught it. No fix — diagnosis only.

## Output format

~150–300 words. Lead with the one-word verdict. Then the failing-test
names (if CAUGHT) or the coverage-gap description (if SURVIVED).

Before exiting, `git status` must be clean. Verify and report.
```

## Reading the results

Aggregate across all mutations:

- **Mutation score** = CAUGHT / total. Under 80% is a weak suite; under 50% is dangerous.
- **Surviving mutations by invariant** — these are your prioritized list of missing tests. Every SURVIVED result maps to one regression test you should add.
- **Compare to prior runs** — if a mutation that was CAUGHT last cycle now SURVIVES, a recent change weakened a test or removed coverage.

Don't obsess over getting to 100%. Some mutations are behaviorally identical (equivalent mutants), and some invariants are legitimately unobservable at the test boundary. The point is to find the ones that *should* be observable but aren't.

## Scripts and assets

No scripts today. If the starter mutation set grows past ~20, consider a
small driver at `.agents/skills/mutation-red-team/run.mjs` that:

- reads a list of mutations from `mutations.json` in this folder
- spawns N Agent calls in parallel (one per mutation)
- aggregates into a mutation-score report

Keep helpers in this folder; do not add them to the main `scripts/` tree.

## Cleanup discipline

**Stricter than the other red-team skills** because this agent writes code.

- The `isolation: "worktree"` flag handles the happy path — a clean revert means the worktree auto-deletes.
- If the agent leaves uncommitted changes, the harness returns the worktree path/branch. Inspect once, delete with `git worktree remove <path>` after.
- Prompt templates used here: delete after the run.
- Mutation output belongs **inline in the conversation**, not in a `.md` file in the repo. The SURVIVED findings may be long — condense before reporting, don't dump.
- Before returning control: `git status` on the main working tree must be clean, and `git worktree list` should not show stray entries. A stray worktree from a botched run is the mutation-test equivalent of an orphaned process.

If a mutation's worktree is preserved (SURVIVED and the user wants to inspect), note the path to the user explicitly — don't leave it as an implicit side effect.
