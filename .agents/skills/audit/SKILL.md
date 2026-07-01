---
name: audit
description: Run a bounded live audit of the extension against multiple HN handles in parallel — Playwright + real Chromium + real HN, time-series snapshots, deterministic divergence analysis. Use when the user asks to "audit", "sit and observe", "live test", or "check whether the extension is correctly tracking real HN activity across multiple users". Bounded by wall time AND request budget — never unbounded.
allowed-tools: Bash(node scripts/audit.mjs *), Bash(node scripts/audit-analyze.mjs *), Read, Bash(ls .audit*)
---

# Live audit — multi-user observation + deterministic divergence

Two-stage shell-orchestrator skill. The skill itself does NOT use the `Agent` tool; it invokes external scripts via Bash and reads their output.

## When to invoke

- User says: "audit", "live audit", "sit and observe", "watch real HN behavior", "check the extension across users"
- Before/after a refactor that touches polling, sync, or storage paths — verify behavior held against real data
- Periodically (weekly cadence works well) to catch HN schema drift the frozen tape harness can't see

## How it works

1. **Run** ([scripts/audit.mjs](../../../scripts/audit.mjs)) launches one headless Chrome per HN handle (separate `userDataDir` each), each with the production-built extension loaded. Each instance runs on the extension's natural alarm cadence (default `tickMinutes: 5`). Snapshots all instances every `--interval` minutes into a JSONL time series, then closes.
2. **Analyze** ([scripts/audit-analyze.mjs](../../../scripts/audit-analyze.mjs)) reads the snapshots + a fresh ground-truth fetch from HN, produces a deterministic divergence report (set-membership and integer-arithmetic only — no LLM judgment). Checks: missed-replies, phantom-replies, bucket-integrity, self-contamination, retention, coverage, politeness.

## Defaults the skill should pass

```
--users=mfiguiere,dang,pg,patio11   (4 contrasting handles: heavy poster, classic high-karma, founder, prolific commenter)
--duration=60                       (minutes total)
--interval=15                       (snapshot cadence; 5 snapshots over 60 min including baseline at t=0)
--budget=4000                       (total HN requests across all users; ~2hr of headroom at the typical ~2000 req/hr aggregate rate)
--headless=true
```

## Invocation pattern

```bash
LABEL="audit-$(date -u +%Y%m%d-%H%M%S)"

# 1. Run. Blocks for `--duration` minutes (or until budget hits).
node scripts/audit.mjs \
  --label="$LABEL" \
  --users=mfiguiere,dang,pg,patio11 \
  --duration=60 \
  --interval=15 \
  --budget=4000

# 2. Analyze. Reads .audit/$LABEL/ + ~50 fresh HN requests for ground truth.
node scripts/audit-analyze.mjs --label="$LABEL"
```

The runner blocks on the foreground. Don't background it — see "Hard caps" below.

## Hard caps the skill MUST enforce

AGENTS.md hard rule: "do not pound HN." These caps exist to honor that.

- **Wall time:** never invoke `audit.mjs` with `--duration` exceeding 120 (2 hours). For longer observation, schedule multiple separate audits.
- **Request budget:** never invoke with `--budget` exceeding 8000 unless the user explicitly justifies it.
- **User count:** keep `--users` to 6 or fewer. Each user is a separate Chrome process; 6+ is a memory and politeness concern.
- **Concurrency:** do NOT run two audits in parallel from the same machine. Memory + HN load doubles.
- **No background launches:** run `audit.mjs` synchronously (foreground bash). The "set and forget" pattern is dangerous because there's no exit guarantee — the user may not realize an audit is running for hours.

If the user asks to override any of these, push back and ask for explicit justification before complying.

## Reading the report

`divergence-report.json` shape:

```json
{
  "overall": "PASS" | "FAIL",
  "politeness": { "totalRequests": N, "budget": N, "status": "PASS|FAIL" },
  "perUser": [
    {
      "user": "mfiguiere",
      "extensionState": { "monitoredCount": N, "replyCount": N },
      "checks": [
        { "name": "coverage|self-contamination|retention|bucket-integrity|missed-replies|phantom-replies",
          "status": "PASS|FAIL",
          "detail": "..." }
      ]
    }
  ],
  "failures": [...]
}
```

When relaying to the user: lead with `overall` + politeness, then per-user `monitoredCount`/`replyCount`/failures. Skip PASS detail unless asked.

## Output structure

```
.audit/<label>/
  checkpoints.jsonl          one JSON line per (user, snapshot)
  summary.json               per-user totals, request counts, polite check
  replies-<user>.json        per-user surfaced replies (analyzer input)
  divergence-report.json     analyzer output
  logs/<user>.log            per-user JSONL events for debugging
```

`.audit/` is gitignored. Outputs accumulate locally; recommend cleaning periodically with `rm -rf .audit/audit-*` if disk pressure becomes an issue.

## Cleanup discipline

The runner closes all Chrome instances on completion (or on error via try/finally). If the user `Ctrl+C`s mid-run, Playwright's persistent context may leave child processes — verify with `ps aux | grep -i chrom` and `pkill -f "chromium.*hnswered"` if needed.

The harness (`tests/harness/`) and audit are independent test layers. Audit does NOT touch tape fixtures or goldens; harness does NOT touch `.audit/`.
