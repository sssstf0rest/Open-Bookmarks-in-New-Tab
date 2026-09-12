# Task Plan: Repository Cleanup

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
