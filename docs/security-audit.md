# HNswered security audit prompt

Paste the section below into any coding assistant (Claude Code, Cursor,
Copilot chat, Cody, or a raw Claude / GPT API call) with this repository
as the working tree. The assistant will audit HNswered against the
invariants that matter for *this* extension and report findings.

---

You are reviewing the HNswered Chrome MV3 extension in the current working
directory. Audit it against the threat model below. Assume you can read any
file in the repo. Report findings as: severity (high / med / low),
`file:line`, and why it matters for *this* extension. Skip style nits and
generic hardening advice.

## Invariants to verify

1. **Read-only HN.** Grep for any non-`GET` to
   `hacker-news.firebaseio.com` or `news.ycombinator.com`. The extension
   must never `POST`, `PUT`, `DELETE`, or authenticate. Any write path is
   a high-severity finding.

2. **Permissions minimalism.** `manifest.json` should request only
   `storage`, `alarms`, `sidePanel`, and host access to
   `hacker-news.firebaseio.com` plus Algolia. Flag `<all_urls>`, `tabs`,
   `scripting`, `cookies`, `webRequest`, or unexpected `host_permissions`.

3. **No HTML injection from HN content.** The side panel renders
   untrusted comment bodies. Confirm reply text is only interpolated as
   Svelte text (`{value}`), never `{@html}`, `innerHTML`, `outerHTML`,
   `document.write`, or `eval` / `new Function`.

4. **Storage hygiene.** Enumerate what lands in `chrome.storage.local`.
   Flag anything resembling a token, cookie, password, OAuth artifact, or
   PII beyond the user-configured HN username.

5. **No external exfil.** The only outbound hosts should be the two HN
   data sources. Flag any other `fetch`, `XMLHttpRequest`, `WebSocket`,
   `navigator.sendBeacon`, or dynamic import from a URL.

6. **SW-scope leakage.** `self.__hnswered` is deliberately exposed in the
   service worker (documented in `AGENTS.md`). Confirm it is NOT reachable
   from content-script or page scope and carries no secrets.

7. **Supply chain.** Check `package.json` and `pnpm-lock.yaml` for
   `postinstall` / `preinstall` scripts, typosquat-shaped deps, and
   anything added since the last tagged release that looks out of place.

8. **Build output parity.** `dist/` is committed. Spot-check that `dist/`
   does not contain code absent from `src/` (e.g. injected analytics,
   telemetry, or an unexpected remote-config fetch).

## Deliverable

A findings list, highest severity first. For each: which invariant it
violates, the `file:line` evidence, and a one-sentence fix suggestion. If
an invariant holds, say so explicitly — silent omission is not useful.
