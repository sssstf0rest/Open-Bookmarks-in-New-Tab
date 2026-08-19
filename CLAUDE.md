# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A dependency-free Chrome Manifest V3 extension (`minimum_chrome_version: 151`,
`incognito: not_allowed`) that opens HTTP(S) bookmarks in a new tab while the
source page stays loaded. There is no npm, no bundler, and no third-party code:
the repository root *is* the unpacked extension.

One bookmark click produces exactly one destination tab through this pipeline:

1. While enabled, each eligible bookmark URL carries a final
   `__obnt_v4=<owner>_<m|p>_<nonce>` query marker — 32 hex chars of
   installation-scoped owner, an `m`/`p` provenance flag, and a fresh 64 hex
   char (256-bit) nonce per bookmark. The pre-marker URL is preserved
   byte-for-byte (no re-serialization, so credentials, escapes, IPv6 spelling,
   and empty query delimiters survive).
2. A dynamic `declarativeNetRequest` rule redirects only marked `main_frame`
   requests to the bundled `cancel.html`.
3. The worker's `fetch` handler answers that exact extension URL with a
   body-less, HTML-typed HTTP 204. Chrome aborts the navigation, keeps the
   source document, and creates no download.
4. `webNavigation.onBeforeNavigate` verifies the marked URL against an exact
   bookmark, unwraps the marker, and creates or reuses one destination tab.
5. Pausing from the popup restores original bookmark URLs *before* the
   interception rules are removed.

## Development

No build or install step. Validate before loading in Chrome:

```sh
node --check js/background.js
node --check js/url-utils.js
node --check js/popup.js
node tests/url-utils.test.js
node tests/background.test.js
python3 -m json.tool manifest.json >/dev/null
```

Current expectation: 25 URL tests and 45 background regression tests pass.

**Running one test.** Neither suite takes a filter flag; both runners iterate a
hand-written array at the bottom of the file (`cases` in
[tests/url-utils.test.js](tests/url-utils.test.js), `tests` in
[tests/background.test.js](tests/background.test.js)). Temporarily narrow that
array to isolate a case, then revert. `OBNT_TEST_ROOT=/path/to/checkout node
tests/background.test.js` runs the suite against a different working copy.

**Test harness.** [tests/background.test.js](tests/background.test.js) loads
`js/background.js` into a `node:vm` sandbox via `createHarness()`, with a
hand-written `chrome` mock, deterministic `crypto.getRandomValues`, and a no-op
`setTimeout`. Consequences when changing the worker:

- Any newly used `chrome.*` API must be added to the mock, or every test throws.
- Nothing scheduled through `setTimeout` ever fires; sequencing must come from
  awaited promises.
- `testPackageContainsNoDownloadMechanism` asserts packaging invariants —
  manifest version string, absence of the `downloads`/`alarms` permissions and
  of `chrome.downloads`/`chrome.alarms` in the source, and absence of
  `empty.zip`, `rules.json`, and `_metadata/`. A version bump or permission
  change must be mirrored there.

**Interactive check** (Chrome 151 or newer): `chrome://extensions/` → Developer
mode → "Load unpacked" → this folder; click the refresh icon after edits and
inspect the service worker for errors. Use a disposable profile — enabling
rewrites real bookmarks.

## Architecture

**[js/background.js](js/background.js)** is the service worker and holds nearly
all logic. All listeners are registered synchronously at top level; startup runs
`prepareInterception()` (settings, marker ownership, DNR rules) into
`interceptionReadyPromise`, then reconciles bookmarks through `maintenanceTail`.

**Two independent lanes — keep them separate.**

- *Maintenance lane*: everything that mutates bookmarks or settings goes through
  `queueMaintenance()` / `maintenanceTail` (settings messages, `bookmarks`
  create/change, import, `storage.onChanged`, install/startup). Serialized so
  concurrent transitions cannot interleave.
- *Navigation lane*: `webNavigation.onBeforeNavigate` deliberately bypasses that
  queue. It awaits only `interceptionReadyPromise` and dedupes on
  `(tabId, url, timeStamp)` via `claimNavigation()`, so a folder "Open all"
  handles clicks concurrently. Never route navigation through
  `queueMaintenance`, and never do bulk bookmark work in the navigation path.

**[js/url-utils.js](js/url-utils.js)** holds every reversible URL transform
(mark, read, unwrap, legacy recovery, DNR regex construction). It is the only
part covered by pure unit tests, so keep it side-effect free and both
browser-global and CommonJS compatible (`module.exports` / `globalThis.BookmarkUrl`).

**[js/popup.js](js/popup.js)**, [popup.html](popup.html), and
[css/popup.css](css/popup.css) are the bilingual (EN / zh-CN) settings UI. The
popup talks to the worker only through `getSettings` and `updateSettings`
messages; `updateSettings` is transactional and rolls back to the previous
settings if the bookmark rewrite fails.

**Marker provenance** decides how far an unwrap may go:

- `m` (migrated) — the extension owns the bytes inside, so a released legacy
  layer (`newtab@…`, the GitHub Pages wrapper) may also be recovered.
- `p` (preserve) — a hard unwrap barrier. Everything inside is user data, e.g. a
  legitimate Basic Auth username that happens to equal `newtab`.

**Storage keys**

| Area | Key | Contents |
|---|---|---|
| sync | `settings` | `enabled`, `focusNewTab`, `position` (`"end"` \| `"right"`) — canonical |
| sync | `syncStateV4` | current/previous marker owners, legacy-compat history, `legacyProvenanceProven` latch |
| sync | `lang` | popup language (`"en"` \| `"zh"`), owned by the popup |
| local | `runtimeState` | `bookmarkFormatVersion` (currently 6), `bookmarkState`, resumable `pendingOperation`, one-shot `legacyResidueChecked` |
| local | `legacyMigrationBackupV2` | size-capped (2 MB) migration backup, removed 30 days after creation |
| session | `sessionReadyV6` | set once reconciliation has run this browser session |

**Dynamic DNR rule IDs** are fixed and must not be reused: 1–4 current owners
(current + accepted previous), 5 unreleased draft-v4, 6 public v3, 7 broad
legacy `newtab@`, 8–11 owner-scoped legacy GitHub Pages wrapper.

## Key Constraints

- Bookmark URLs are modified in place. Pause from the popup to restore them
  before directly disabling or uninstalling; Chrome gives no cleanup event.
- A marked URL never commits, so Chrome records no favicon for it and the
  bookmarks bar shows a generic icon. An intercepted bookmark cannot keep its
  icon while the query marker is in use; one that still shows an icon is one
  that is not being intercepted.
- Never navigate a source tab that holds a committed document. A marked click
  that cannot be matched to a bookmark opens a new tab instead; only a tab with
  nothing committed may be reused. Chrome canonicalizes both what it stores and
  what `webNavigation` reports, so bookmark matching compares canonical URLs
  and falls back to a nonce lookup rather than a byte-exact string test.
- The retired GitHub Pages wrapper must never become a destination: since 2.4
  that page no longer forwards, so `readLegacyRedirectTarget` is resolved both
  when repairing bookmarks and again on the navigation path.
- Released 2.3 residue is repaired on evidence, not on history. Unambiguous
  evidence (the exact wrapper, a repeated or encoded prefix, a prefix in front
  of real credentials) latches `legacyProvenanceProven`, which then authorizes
  stripping a lone `newtab@`. Without that latch a lone `newtab@` stays inside
  a `p` capability, because it is indistinguishable from a Basic Auth username.
- Only HTTP(S) bookmarks are marked. `chrome://`, `file:`, `data:`, and
  JavaScript bookmarks stay untouched, as do `unmodifiable` nodes.
- A marker counts only when it is exactly 32 hex owner chars, `_m_` or `_p_`,
  64 hex nonce chars, **and** the final query parameter. Anything else is page
  data. Keep DNR rules owner-specific; do not broaden their scope.
- Every new-tab action requires exact-bookmark proof
  (`exactBookmarkExists`) plus an accepted owner. A leaked or crafted marker
  must never gain new-tab behavior.
- `webNavigation` is the sole owner of destination creation. Do not add a second
  navigation or download listener for the same click, and never recover with
  generic `goBack()`, `tabs.remove()`, or an active-tab fallback — reuse is
  allowed only for the exact source tab when it is blank.
- Chrome 151 rejects DNR regexes whose compiled RE2 program exceeds 2 KB (a
  `{64}` repetition is enough). Keep `regexFilter` patterns low-memory, use
  `urlFilter` for long fixed patterns, and let `assertRuleRegexSupported()` gate
  every rule.
- Do not rewrite a 2.3-era wrapper into its direct destination while a
  synchronized 2.3 device may still run: it re-wraps immediately and the two
  devices rewrite each other forever. Authenticate the wrapper instead and
  unwrap locally.
- MV3 workers stop between events. Persist transition state in `runtimeState`
  and keep bookmark rewrites resumable and idempotent; re-read each bookmark
  immediately before writing so a concurrent user/sync edit is not lost.
- Popup width is fixed at 320px per Chrome popup constraints; CSS uses a dark
  theme with custom properties defined in `:root`.
- The worker answers the cancellation itself, so a shut down worker keeps the
  source page in a pending navigation until it boots. The `alarms` keep-alive
  exists only for that; keep the click path free of storage writes and ruleset
  rewrites (`ruleFingerprint`, the `storedSyncStateJson` dirty check).

## Conventions

Two-space indentation, semicolons, double-quoted strings, `camelCase` functions
and variables, `UPPER_SNAKE_CASE` constants. Keep the JSDoc and the "why"
comments around navigation, marker, and migration logic — they encode browser
behavior that is expensive to rediscover. CSS uses BEM-style classes
(`.toggle-row__hint--off`); HTML IDs and classes are kebab-case; keep semantic
elements, ARIA attributes, and the paired English/Chinese strings in `I18N` in
sync.

Commits use short imperative subjects (`fix duplicate bookmark tab handling`).
PRs should state the Chrome version and manual checks performed, and explicitly
call out permission, bookmark-mutation, or privacy-policy changes.

Behavior changes must be reflected in [README.md](README.md),
[docs/privacy-policy.html](docs/privacy-policy.html), and the copy of that
policy inside `chrome-web-store-publishing-kit.zip`.
[docs/redirect.html](docs/redirect.html) is the GitHub Pages page that 2.3 and
earlier used as a proxy; it now only offers legacy recovery and must keep
handling a `?url=` parameter.

## Repository Notes

- [AGENTS.md](AGENTS.md) is the Codex-maintained sibling of this file. Its style,
  commit, and security guidance is current, but its "Project Structure" and
  "Build" sections still describe the pre-2.4 download design (`rules.json`,
  `_metadata/generated_indexed_rulesets/`, `empty.zip`), which no longer exists.
  Update both files when the workflow changes.
- [findings.md](findings.md), [task_plan.md](task_plan.md), and
  [progress.md](progress.md) are tracked working notes from the 2.4.0 Chrome 151
  patch; they record why the download-based design was replaced.

<claude-mem-context>
# Recent Activity

<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->

*No recent activity*
</claude-mem-context>
