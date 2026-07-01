---
name: test-red-team
description: Launch an adversarial reviewer (Opus) to find bugs IN THE TEST SUITE — tautological assertions, weak oracles, shim/mock lies, stale fixtures, coverage gaps, clock-mock pitfalls. Use when the user says "red team the tests", "audit the tests", "are our tests any good", "find weak tests", or after adding a large batch of tests that needs scrutiny.
---

# Test-suite red-team review

Launches an **Opus** general-purpose agent to hunt bugs *in the tests themselves*, not the production code. Tests can create false confidence in three ways — tautological assertions, mocks that lie about real-API behavior, and coverage that looks broad but skips the hard paths. This skill finds all three.

Complementary to [red-team-review](../red-team-review/SKILL.md) (which hunts production-code bugs). Run both on major change points.

## When to invoke

- User says: "red team the tests", "audit the tests", "find weak tests", "are our tests rigorous", "tests that only check mocks", "test coverage gaps"
- After adding a large batch of tests — a fresh pass often finds tautologies before they rot
- After a red-team-review finds bugs the existing tests did not catch — ask "why didn't our tests find this?" and run this skill
- Before a release, if the suite hasn't been scrutinized in a while

## How to invoke

Use the `Agent` tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description`: 3–5 word description (e.g. `"Red-team test suite"`)
- `prompt`: follow the template below

## Prompt template

Fill the bracketed sections with current project state. Do NOT send as-is.

```
You are an adversarial code reviewer performing a red-team bug hunt on
the TEST SUITE of [PROJECT NAME / KIND]. Your target is the correctness
and rigor of the tests themselves — not the production code. You find
tautological assertions, weak oracles, shim/mock lies, stale fixtures,
and coverage gaps. Rank findings CRITICAL / HIGH / MEDIUM / LOW.

## Setup

[bash block: cp project to /tmp/<id>, pnpm install, capture
typecheck/test/harness output to logs for grep]

## Target surface

[tree of tests/ directory, noting unit vs harness vs shim vs fixture]

## What's worth hunting — the "how tests lie" checklist

1. Tautological assertions. For each test file, pick 3–5 assertions and
   ask: "if the production code were replaced with return 0 / return []
   / a no-op, would this test fail?" If no, the test is vacuous.

2. Weakly-constrained oracles. Golden-file snapshots — what fields are
   in, what are out? Would a wrong value in a captured field be caught,
   or is the check just `assert.ok(snapshot)`?

3. Shim lies. Reimplemented Chrome/HTTP/external APIs diverge from the
   real thing. Check filter semantics (strict vs. non-strict >), return
   ordering, event-firing async vs sync, pagination stop conditions.

4. Fixture drift. Tapes/fixtures recorded once against live systems —
   does the current code path still produce requests captured in the
   tape, or has the code drifted?

5. Clock-mocking pitfalls. @sinonjs/fake-timers with toFake: ['Date']
   leaves setTimeout/setInterval/performance.now real. If production
   correctness depends on those, clock tests give false confidence.

6. Shared-state leakage. Node's --test shares module state. Globals
   mutated by one test can mask bugs in the next. Inspect cleanup in
   try/finally.

7. Coverage gaps. Production code paths not exercised by any test.
   Error branches, rate-limit retries, edge-case config values.

8. Assertion granularity. assert.deepEqual on ordered data locks order;
   length-only assertions do not. For ordered outputs (queues, sorted
   lists), was ordering actually asserted?

9. Mock vs. real-API divergence for specific new code paths (list them).

10. Explicit regression tests for prior red-team findings — would they
    fail against an implementation that returns the right answer by
    accident?

## Grep hints

[specific greps that surface weak assertions, length-only checks,
stale tapes, etc.]

## Output

300–600 words. Severity-grouped. For each finding:
- file:line reference
- one-line description of why the test is weak
- concrete trigger: "an implementation that does X would still pass this"

No fixes — diagnose only. "No CRITICAL issues found" is valuable signal;
say so explicitly.
```

## Scripts and assets

This skill currently uses no scripts. If future versions need coverage-gap helpers (e.g., parsing c8/nyc output), they go in this folder.

## Cleanup discipline

Same rules as [red-team-review](../red-team-review/SKILL.md):

- Agent is read-only by design; it should not create files.
- Temporary prompt files → delete after the agent returns.
- Scratch analysis dumps → delete unless the user asked to keep them.
- Agent's response belongs inline in the conversation, NOT written to a `.md` file in the repo unless explicitly requested.
- Final `git status` check before returning control.
