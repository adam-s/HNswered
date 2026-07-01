---
name: red-team-review
description: Launch an adversarial bug-hunting code reviewer (Opus) to find real bugs, correctness issues, concurrency hazards, and server/resource abuse risks — not style nits. Use when the user asks for a "red team", "bug hunt", "adversarial review", or at checkpoints during long coding tasks.
---

# Red-team adversary review

Launches an **Opus** general-purpose agent as an adversarial code reviewer.

For a different-model-family cross-check, the maintainer runs additional adversary passes (e.g., Opus 4.6, other providers) out-of-band in a separate harness. This skill stays on Opus because that's what the Agent tool resolves `"opus"` to today, and it gives the highest-depth pass of anything available through the built-in tool.

## When to invoke

- User says: "red team", "bug hunt", "adversarial review", "find what's broken", "find real bugs"
- Completion of a major feature where the surface area grew significantly
- Before a release
- Proactively at checkpoints during long coding tasks (per user preference for autonomy)

## How to invoke

Use the `Agent` tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description`: 3–5 word description (e.g. `"Red-team review after X"`)
- `prompt`: follow the template below

## Prompt template

Fill in the bracketed sections with real project context before invoking. Do NOT send the template as-is.

```
You are an adversarial code reviewer performing a red-team bug hunt on
[PROJECT NAME / KIND]. You find real bugs, correctness issues,
concurrency hazards, and server/resource abuse risks — NOT style nits.
Rank findings by severity (CRITICAL / HIGH / MEDIUM / LOW).

## Project

[ABSOLUTE PATH]

[2-3 sentences on what it does and the runtime/deployment model —
e.g. "Chrome MV3 extension, Svelte sidepanel, polls Firebase API on
chrome.alarms cadence."]

## What changed since last review (if applicable)

[Bullet list of notable changes with file:line anchors. If no prior
review, describe the full surface area.]

## What to hunt

Group concerns. Examples (adapt to the project):
- Server/resource abuse: retry storms, alarm storms, unbounded loops,
  missing rate limits, concurrency guards
- Data corruption: read-modify-write races on shared stores without CAS
- Security: XSS via {@html} or innerHTML, unsanitized URLs, JSON-in-URL,
  access-control gaps
- Correctness: wrong invariants, silent fallbacks masking errors, edge
  cases (deleted/dead items, clock skew, timezone, duplicate inputs)
- Lifecycle: MV3 SW suspensions, page refresh, concurrent tabs, alarm races
- Tests that validate mocks, not behavior

## Output format

~300–500 words. Group by severity. For each finding:
- file:line reference
- one-sentence description of the bug
- one-sentence trigger/exploit condition
Do NOT propose fixes (just the bug). End with a one-sentence risk
delta vs the previous review if one exists.

Be terse. Be specific. Find real bugs.
```

## Scripts and assets

This skill currently uses no scripts. If future versions need helper
scripts for, say, parsing the review output into a ranked TODO list,
they go in this folder:

```
.agents/skills/red-team-review/
  SKILL.md        # this file
  <helper>.mjs    # optional helpers, live here only
```

## Cleanup discipline

**This skill must clean up after itself.** The adversary agent is
read-only by design and should not create files. If you (or it) produce
any scratch artifacts:

- Temporary prompt files → delete after the agent returns.
- Scratch analysis dumps → delete unless the user asked to keep them.
- The agent's response itself belongs inline in the conversation; do
  NOT write it to a `.md` file in the repo unless requested.

Before returning control to the user, verify no stray files were left
in the repo root, `.claude/tmp/` (if used), or elsewhere. A final
`git status` check is cheap.
