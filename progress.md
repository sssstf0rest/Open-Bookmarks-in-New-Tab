# Progress Log

## Session: 2026-08-17 — Version 2.4.0 Reliability Patch

### Phase 1: Baseline and Regression Harness
- **Status:** complete
- User confirmed the diagnosis, target Chrome version, release version, and implementation plan.
- Read the required planning workflow and initialized task working memory.
- Read the Playwright workflow and confirmed `npx` is available.
- Delegated independent URL-migration tests, background regression harness, and disposable-Chrome cancellation proof.
- Reviewed the previous 2.4.0 attempt only as a failure reference; browser evidence is required before reuse.
- Identified two changes beyond the previous attempt: concurrent per-tab navigation handling and cached source metadata/replacement when a newly created canceled tab disappears.
- Added URL transformation and background regression suites without touching production runtime files.
- Captured the 2.3.0 baseline: one click produced two destination actions; three concurrent bookmarks produced six; Gmail/LAN each opened twice; committed fallback mutated history; no typed 204 handler existed; and download artifacts remained packaged.

### Phase 2: Single-Owner Navigation Architecture
- **Status:** complete
- URL marker utilities now use a random installation-scoped
  owner/provenance/nonce capability and preserve the pre-marker URL
  byte-for-byte.
- Added deterministic edge coverage for marker ownership, event deduplication,
  placement/focus, closing windows, bounded creation retries, and grouped
  replacement tabs. The 17-test background suite passed five repeated runs.

## Test Results
| Test | Result |
|------|--------|
| Duplicate focus-off baseline | fails: 2 destination actions for 1 click |
| Folder “Open all” baseline | fails: 6 destination actions for 3 clicks |
| Gmail/LAN baseline | fails: 4 destination actions for 2 clicks |
| Download-free package baseline | fails: download artifacts/APIs still present |
| Expanded background regression suite | passes: 17/17 across five repeated runs |

### Upgrade-hardening regression work

- Extended the background harness for sync/local storage assertions, quota
  failures, deterministic cryptographic randomness, frozen bookmark writes,
  and simulated cold-worker restarts.
- Added eight behavior-level regressions for synchronized settings, random
  per-bookmark v4 nonces, v3/legacy migration, transition-time clicks, backup
  failure tolerance, legacy-rule startup order, operation resumption, and
  direct re-enable reconciliation.
- After the v4 production rewrite landed, all 26 background regressions passed
  in five consecutive runs. The updated URL utility suite also passed 19/19.
- One combined `rg` diagnostic had an unmatched shell quote; it was replaced
  with newline-separated, single-quoted patterns and then passed.

### Phases 3–4: Download-Free Runtime and Authenticated Migration
- **Status:** complete
- Replaced the `empty.zip` download race with a bundled cancellation resource
  served as an HTML-typed 204; removed downloads, alarms, static rules, active
  tab fallback, committed-history repair, and destructive source removal.
- Added resumable bookmark transitions, bounded migration backup, canonical
  synchronized settings, secret rotation, exact source snapshots, transient
  source replacement, and tab-group restoration.
- Hardened markers to `owner32_[mp]_nonce64`, with migration-only broad legacy
  handling and byte-exact Basic Auth preservation.
- Updated manifest to 2.4.0/Chrome 151, popup accessibility/localization,
  README, privacy policy, recovery page, embedded Web Store policy, and license.

### Phase 5: Release Verification
- **Status:** complete
- Final deterministic results: 25/25 URL tests and 40/40 background tests;
  the background suite passed five consecutive runs.
- Exact Chrome 151 warm validation passed: one loaded source plus three folder
  sources produced four clean destinations once, all three blank sources were
  reused, source identity/time origin stayed unchanged, pagehide remained 0,
  and downloads/errors remained 0.
- Native Chrome rejected the first long legacy-wrapper regex for compiled RE2
  memory. Replacing it with an owner-scoped URL filter passed the same smoke
  test and kept the broad legacy rule absent after migration.
- A true cold-worker Chrome 151 run passed after a 45-second zero-client gap:
  the worker restarted in 34 ms, one loaded source and three concurrent blank
  sources opened four clean destinations exactly once, and no downloads,
  marker requests, or worker errors occurred.
- Exact Chrome Basic Auth coverage preserved credentials byte-for-byte and
  opened one authenticated destination. Spotify probing confirmed the typed
  204 keeps the document and Web Audio loaded, though Chrome still dispatches
  `beforeunload`; the README documents Ctrl/⌘+Click or middle-click as the
  reliable Spotify workaround.
- Rebuilt and visually checked all Web Store images with qualified HTTP(S)
  claims, synchronized the packaged privacy policy, and passed ZIP integrity.
- Committed as `938a57b`, pushed `aug-bug-fix`, and opened draft pull request
  #6 against `main`.
