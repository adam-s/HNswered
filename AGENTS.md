# AGENTS.md — HNswered agent instructions

Canonical instructions for all coding agents working in this repo. Agent-specific entry points (e.g. [CLAUDE.md](CLAUDE.md)) reference this file. Shared agent resources (skills, reference docs) live under [.agents/](.agents/).

## Language (mandatory)

Do not use "kill" except for the Unix `kill` command. Use stop / end / halt / exit / close / shut down / cancel / interrupt / terminate / abort.

## What this is

Chrome MV3 extension (Svelte 5 side panel + background SW) watching HN for replies to a configured user's posts and comments. **Read-only** — only `GET` to `https://hacker-news.firebaseio.com/v0/*`.

## Hard rules

- **Capture every reply.** A new silent-loss path is a regression. The only designed exception is the `DROP_AGE_MS` 365-day retention cap.
- **Production politeness.** Caps in [src/shared/constants.ts](src/shared/constants.ts) (`MAX_SYNC_ITEMS_PER_CALL`, `MAX_REPLIES_PER_CHECK`, `USER_SYNC_MIN_INTERVAL_MS`, `PER_REQUEST_DELAY_MS`, `HARD_REPLY_CAP`) are defaults; lift deliberately and note the cost.
- **Research tooling under `cost-analysis/` plays by different rules.** One-shot probes from one IP, not millions of users. Prefer concurrency 10–20 + reactive 403/429 backoff over preemptive delays. Use wall-time and request-count seatbelts (e.g. 10 min, 20k Algolia / 50k Firebase). Log throttles visibly.
- **Aesthetic.** Teal `#2d7d7d`, beige `#f6f6ef`, Verdana, flat, no rounded corners, no shadows, dense. Deliberately NOT HN orange. Use [design-critique skill](.agents/skills/design-critique/SKILL.md) for reviews.

## Load-bearing invariants

- **`self.__hnswered`** in [src/background/index.ts](src/background/index.ts) — consumed by Playwright harnesses (CDP `evaluate`) AND Node harness (`globalThis` import). Ships in SW scope only.
- **`hnswered:` prefix** on the alarm key and `navigator.locks` name — renaming orphans existing users' alarms.
- **Self-reply filter** (case-insensitive `hit.author === hnUser` in `pollComments`) in [poller.ts](src/background/poller.ts) — intentional silence. Comment out for manual end-to-end tests; do not delete.
- **Algolia `parent_id` is authoritative for direct descendants.** The retrospective sweep at [cost-analysis/docs/reports/report.md](cost-analysis/docs/reports/report.md) measured 99.99% live agreement vs. Firebase `kids[]` minus dead/deleted (and Algolia excludes dead/deleted by design — which is what we want). Don't reach for Firebase as a recovery layer without data showing it's actually needed.
- **`OVERLAP_MS ≥ author-sync cadence + one tick`.** Otherwise a reply on a freshly-authored comment can age out of the overlap window before the next author-sync discovers the parent. `OVERLAP_MS` is pinned at `2× AUTHOR_SYNC_MS` for margin; treat it as the only correctness knob.
- **Lock mode in [index.ts](src/background/index.ts).** `runRefresh` acquires `LOCK.TICK` exclusive (queues behind in-flight tick); `runTick` uses `{ ifAvailable: true }` (peer alarm fires drop). Never switch `runRefresh` to `ifAvailable` — a user click during an alarm tick MUST do its sync work after, not skip.
- **One alarm, internal cadence gates.** `runTick` always runs `pollComments`, and runs `maybeSyncAuthor` only when `lastAuthorSync` is >= `AUTHOR_SYNC_MS` ago. Don't introduce new alarms — the cost is one compound check per tick, the payoff is a single state machine.
- **Retention pruning rides inside `syncAuthor`.** `pruneReplies` is called at the end of every syncAuthor run (~10-min cadence). There is no separate daily-scan anymore; if syncAuthor stops running, retention stops running.
- **Force-refresh bypasses the author-sync cadence gate** (calls `syncAuthor` directly, not `maybeSyncAuthor`). Still honors the 10s refresh throttle. Don't conflate the two.
- **No `/v0/updates.json`.** The rolling ~40-id window silently drops replies on low-traffic items. Don't re-introduce it as a gate or optimization — the Algolia comment feed is strictly better.

## Tests + build

- `pnpm type-check`
- `pnpm test` — unit (`tests/unit/*.test.ts`), ~2s, shims at `tests/shim/{chrome,fake-hn}.ts`.
- `pnpm harness:replay` — deterministic tape replay, ~5s.
- `pnpm impersonate` — Playwright + live HN, budget-bounded, single-user, never loops.
- `node scripts/audit.mjs && node scripts/audit-analyze.mjs` — bounded multi-user live audit. Invoke via [audit skill](.agents/skills/audit/SKILL.md).
- **`pnpm build` after ANY edit to `src/`** — the user loads the extension from `dist/`. Chrome does not see `src/` changes until `dist/` is rebuilt AND the extension is reloaded in `chrome://extensions`. Type-check passing is not the same as dist reflecting the edit. After the user reloads, also confirm the SW restarted (old SW keeps running the old code until reload).
- **`DEBUG` in [src/shared/debug.ts](src/shared/debug.ts)** toggles all `log()` / `logErr()` output. It is `false` in shipped prod; flip to `true` + rebuild when diagnosing live behavior. The user sees *no* console output when `DEBUG=false`, regardless of how much the code calls `log(...)`.

CI at [.github/workflows/ci.yml](.github/workflows/ci.yml) runs type-check + test + harness:replay on push/PR, ~7s + install. `harness:record` is NOT in CI — hits live HN.

Conventions:

- TS imports use `.ts` extensions (`--experimental-strip-types`). No parameter properties, no enums.
- Svelte 5 runes only (`$state`, `$derived`, `$props`).
- `dist/` is tracked; a typical PR is `src/` + `dist/` rebuild as one commit.

## Tapes

Fixtures at `tests/harness/fixtures/<scenario>/tape.json`; goldens at `tests/harness/golden/<scenario>/<step>.json`. Both committed.

```bash
pnpm harness:record --scenario=<name>            # live HN, one-shot
HARNESS_UPDATE_GOLDEN=1 pnpm harness:replay      # regen goldens from replay
pnpm harness:replay                              # verify
```

- Goldens come from REPLAY, never RECORD (`text` is truncated to 10 chars in tapes).
- Single-driver-per-process invariant in `tests/harness/driver.ts` — one scenario per test file.
- Re-record when CI diverges from prod or tapes hold non-200s (they incur real-wall sleeps on replay).

## Skills

Reusable agent playbooks at `.agents/skills/<name>/SKILL.md` (Claude Code auto-discovers them via the `.claude/skills` symlink; other agents can follow them as documented procedures). All read-only against production code. Format conventions: [.agents/reference/anthropic-conventions.md](.agents/reference/anthropic-conventions.md).

- [red-team-review](.agents/skills/red-team-review/SKILL.md) — adversarial bug hunt of production code.
- [test-red-team](.agents/skills/test-red-team/SKILL.md) — adversarial audit of the test suite (tautologies, shim lies, coverage gaps).
- [mutation-red-team](.agents/skills/mutation-red-team/SKILL.md) — inject regressions, report which mutations the tests miss.
- [design-critique](.agents/skills/design-critique/SKILL.md) — Jony-Ive UI critique.
- [audit](.agents/skills/audit/SKILL.md) — bounded multi-user live audit + divergence analysis.

## Known deferred findings

Tradeoffs, not oversights:

- **No CAS on `chrome.storage.local` RMW.** Mitigated by `navigator.locks` on `LOCK.TICK`, not eliminated. Per-key lock is the real fix if it bites.
- **`lastAuthorSync` updates on forced syncs.** An alarm tick shortly after force-refresh skips its author-sync work (cadence gate). Gate measures work done, not intent.
- **Sidepanel `onStorageChanged` filters to `replies` and `config` only.** Timestamps, `backfillQueue`, `monitored`, `backfillSweepFloor` don't affect render output — ignoring them avoids ~500 IPC list-replies round-trips during a fullDrain.
- **fullDrain holds `LOCK.TICK` for the full queue.** At 500 items × 1.5s pacing = ~12.5min lock hold, blocking alarm-tick polling throughout. Rolling-cap risk at power-user scale. Releasing the lock mid-drain reintroduces the interleaving concerns the lock was added for (concurrent pollComments mutating `replies`, user-change clearing state mid-drain). Revisit if production telemetry shows Algolia 429s during fullDrain.
- **No Firebase recovery layer.** Relies entirely on Algolia `parent_id`. Sweep measured 99.99% live agreement, but if real-world usage turns up systematic Algolia index-lag misses, add a daily `/v0/item/<id>.json` cross-check.
- **No per-scan request budget.** Algolia responses are bounded (1000 hits/page) and `pollComments` makes exactly one request per tick, but a pathological `syncAuthor` with >1000 pages of author history + pagination could burn more than expected. Not currently implemented.
- **`__hnswered` ships in prod bundle.** SW scope only, not web-reachable.
- **`lastForceRefreshAt` doesn't survive SW suspension.** Spam-clicking through MV3 suspension bypasses the 10s refresh throttle.
- **`DEBUG` in [src/shared/debug.ts](src/shared/debug.ts)** — `false` in prod; flip to `true` for live diagnosis, revert before shipping.

## Noise

- IDE `@rollup/rollup-darwin-arm64` warning in .svelte files — Svelte language-server + npm optional-deps bug. CLI unaffected. Fix: `rm -rf node_modules pnpm-lock.yaml && pnpm install`.
- Markdown table-pipe lints in `README.md` — cosmetic.

## Naming

User-visible: **HNswered** (capital H, N). Internal IDs stay lowercase (npm name, `hnswered:` prefix, `__hnswered` hook, userDataDir temp prefix, Vite plugin). Alarm prefix is the only rename with upgrade cost.
