# Task Plan: Bookmark Folder Selector Investigation

## Active update packaging — 2026-10-15

Create a Chrome Web Store upload ZIP from the current source. Manifest already
uses 2.6.0; preserve it and align package.json from 2.5.0.
- [x] Confirm runtime boundary, align metadata, and run project checks/tests.
- [x] Build and ZIP only allowlisted runtime assets with manifest.json at root.
- [x] Verify ZIP integrity, exact contents, source equality, and version; deliver path.

Output: dist/Open-Bookmarks-in-New-Tab-v2.6.0.zip, 17 runtime files,
23,359 bytes. Check, all 57 tests, build, ZIP CRC/exact contents/source equality,
and whitespace checks pass. Native UI verification remains as previously documented.

Local packaging is authorized. Preserve current runtime implementation; no upload,
publication, source commit, or additional version bump is requested.

## Active investigation — 2026-10-12

Goal: assess the reported native Chrome folder selector failure, fix supported extension causes, and distinguish automated evidence from native-browser verification.

- [x] Trace bookmark mutations and confirm Chromium dialog behavior from primary sources.
- [x] Implement a bounded, restart-safe repair preserving URL migration and synchronous worker registration.
- [x] Add regression coverage and native-dialog reproduction instructions.
- [x] Run check, tests, build, and whitespace validation; review and report limitations.

Constraints: preserve the HTML-typed 204 response, hosted helper URL, existing migration, and version. Use a disposable profile for any browser writes; no publication or personal bookmark mutations.

Decision: replace time-only marking with a shared, session-backed queue protected by matching active tabs in every window. Re-arm recovered work; preserve original URL hints and invalidate stale async work. Native dialog closure has no public API, so document the delay until leaving the page.

## Current investigation errors
- First combined test run: 26 existing tests passed; 19 new tests failed because their harness omitted the new `bookmarks.onMoved` event. Corrected; final 57 tests pass.
- Native verification attempt could not safely target the isolated Chrome process; no bookmark actions were performed. Test process terminated; native persistent freeze remains unverified.

## Active investigation outcome

Supported URL-identity race repaired locally. All 57 tests pass (31 bookmark regressions plus 26 existing tests); check, build (17 runtime assets), and whitespace validation pass. Independent review has no remaining actionable findings. Native acceptance steps are documented, but not claimed as observed. Newly saved bookmarks remain unmarked while a matching page is selected; leaving it triggers guarded marking after five seconds. No version bump, commit, push, or publication.

## Active Pages diagnosis — 2026-09-13
- [x] Inspect stalled workflow and preceding successful deployment.
- [x] Check runner allocation, changed files and live hosted pages.
- [x] Explain impact and recommend next steps; do not cancel/rerun without a request.

Screenshot and GitHub API show workflow 34713882106 queued, not actively building. Investigation only.

## Active GitHub draft — 2026-09-13

User requested a GitHub release draft. Create an unpublished v2.5.0 draft with notes and the previously verified ZIP; no source commit/push or public release.
- [x] Confirm repository, current version, existing releases and archive.
- [x] Verify release target against archive; prepare notes describing actual changes and limitations.
- [x] Create draft, attach ZIP, verify draft status and asset; return URL.

## Active release packaging — 2026-09-13

Generate a Chrome Web Store upload ZIP from current main, without uploading or publishing it.
- [x] Inspect source and packaging boundary: manifest already uses 2.5.0; package.json still uses 2.4.0.
- [x] Align package metadata to the existing manifest version, run checks/tests, build runtime folder.
- [x] Create a new 2.5.0 ZIP, verify integrity/content/version and provide its path.

The release request authorizes local packaging; earlier cleanup-only constraints below are historical. Preserve runtime code, exclude generated Chrome metadata, and do not commit/push/upload.

## Goal
Reorganize the user-confirmed working HTTP 204 extension without changing bookmark behavior. Continue on `codex/no-download-navigation` from committed baseline `3e2f9c4`.

## Phases
- [x] Inventory files and confirm clean baseline; identify runtime dependencies.
- [x] Split the background worker into focused, synchronously loaded scripts.
- [x] Remove obsolete release ZIPs, generated ruleset, duplicate guidance and old release notes.
- [x] Consolidate current docs; add dependency-free check/build commands and packaging tests.
- [x] Run regression, source-reference, build-content and whitespace checks.

## Outcome
Cleanup complete locally. All 26 tests pass; build, syntax/resource validation,
documentation links and whitespace checks pass. Baseline comparisons confirm
navigation/lifecycle/URL function bodies, popup, manifest, rules, and cancellation
page are unchanged. No commit, push, release or personal-browser mutation.

## Constraints
Preserve manifest entry paths, bookmark formats, redirect helper URL, version, popup behavior, and 204 MIME/headers. Do not alter personal Chrome data, publish, or regenerate store archives. Git baseline preserves removed tracked files. Keep these three concise planning files as required by repository instructions; old research remains in Git history.

## Evidence
User reports the 204 prototype works perfectly. This is user verification, not a completed cross-platform browser matrix. MCP browser extension tooling remains unavailable; this cleanup uses automated checks and mechanical behavior-preserving extraction.

## Errors
Initial planning-file replacement patch used duplicate targets and was rejected before editing. Corrected to a single update per file.
