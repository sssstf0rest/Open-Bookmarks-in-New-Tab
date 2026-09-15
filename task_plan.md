# Task Plan: Repository Cleanup

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
