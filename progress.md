# Bookmark Folder Selector Progress

## 2026-10-15 — Chrome Web Store update package

- Inspected clean working tree, current manifest, package metadata, runtime allowlist, and build script. Manifest already 2.6.0; preserving it. Delegated an independent packaging-boundary audit.
- Aligned package.json to 2.6.0; check and all 57 tests pass. Built 17 runtime assets and created the 23,359-byte v2.6.0 ZIP. Verified CRC, exact allowlist, manifest at archive root, and byte equality against both source and build. No upload, publication, or commit performed.

## 2026-10-12 — Investigation and repair

- Read planning skill and repository guidance; session catchup has no additional context and initial working tree is clean.
- Inspected background registration, bookmark listeners, pending timers, lifecycle startup, manifest, and historical planning records.
- Delegated primary-source Chromium dialog research and an independent bookmark/test audit while tracing the implementation.
- Confirmed the original-URL lookup in Chromium's editor-opening and edit-saving paths. Audit also found recovery loses pending IDs early and async work can overwrite a later edit/pause.
- Delegated behavior-based queue regression tests and evidence-backed diagnosis/manual test documentation. Implementing the shared guarded queue in the worker.
- Added a shared timer, active-page guard, original-URL hints, complete queue recovery, event-driven retries, own-write filtering, and pause cancellation. Source validation passes. Existing 26 tests pass; new harness initially omitted onMoved and is being corrected.
- All 50 tests pass after harness correction and 24 bookmark regressions. Review fixed cold-start removal, optimized timer scheduling, and identified loading-event stale snapshots; a regression for the last case is being added.
- Updated README/architecture, a focused Chromium-backed investigation, native acceptance guide, and privacy-policy source. Native attempt could not target the isolated Chrome instance safely; no personal bookmark/UI changes made.
- Added loading-event invalidation and the 2,000-bookmark burst regression. Added once-per-session reconciliation with readiness persisted only after the complete tree is queued, covering browser restart and extension reload/disable. Ordinary worker wakeups retain the cheaper pending recovery path.
- Final verification: all 57 tests pass, npm run check passes, npm run build packages 17 allowlisted runtime files, and git diff --check passes. Two independent audits completed; no remaining actionable findings. Terminated only the isolated Chrome test process; native verification remains pending in the documented disposable-profile guide.
- Investigation and supported-cause repair complete locally. Version/204 registration/hosted helper unchanged. No commit, push, policy deployment, or release publication.

## 2026-09-13 — Pages queue diagnosis
- Inspected screenshot, Actions API, Pages source configuration and GitHub status. Latest run is queued, previous run succeeded. No remote writes or workflow cancellation performed.
- Confirmed no runner assigned and zero steps started. Compared queued commit to prior deployment: only package/planning edits. Both live hosted pages return 200 and match current source byte-for-byte. Diagnosis complete; stale run can be cancelled without needing a content redeploy. Exact runner scheduling cause remains unconfirmed.

## 2026-09-13 — GitHub release draft
- Read planning guidance, checked main status and existing GitHub releases. Preparing an unpublished v2.5.0 draft and existing verified ZIP attachment.
- Created draft v2.5.0 targeting remote main c512f280ecec0e3e47afa5e8e2c2510bbecfb8d3, with release notes and the 22,304-byte ZIP. All 17 archived files match that commit. Verified isDraft=true and uploaded asset digest matches local SHA-256. Nothing published or committed.
- Draft URL: https://github.com/sssstf0rest/Open-Bookmarks-in-New-Tab/releases/tag/untagged-a56e6cb3b3fc1ced7f05 . Notes saved in ignored dist/release-notes-v2.5.0.md.

## 2026-09-13 — Chrome Web Store package
- Read planning skill and current build tooling; confirmed main is clean and inspected existing version mismatch. Preparing a local upload archive only.
- Aligned package.json from 2.4.0 to existing manifest version 2.5.0. npm run check, all 26 tests, build and whitespace checks pass. No runtime edits.
- Created and verified dist/Open-Bookmarks-in-New-Tab-v2.5.0.zip: 17 files, 22,304 bytes, correct root manifest, CRC and byte comparisons passed. No upload, publication, commit, or push performed.

## 2026-09-12
- Read planning skill and contributor guidance; inspected tracked files, current worker, popup and test guide.
- Confirmed clean committed baseline `3e2f9c4`; no uncommitted user edits to preserve.
- Recorded the user's successful prototype test separately from unperformed platform-wide verification.
- Replaced long historical planning notes with current concise records; full prior records remain in Git history.
- Extracted six worker scripts while preserving runtime entry paths, function bodies and popup behavior. All 25 existing tests pass with the synchronous import harness.
- Removed two legacy ZIPs, generated ruleset, three duplicate CLAUDE files and stale release notes; recoverable at baseline commit.
- Added package scripts, asset validation, runtime-only build and packaging test. Consolidated docs and documented the user's successful test without claiming a full browser matrix.
- Verification complete: 26 tests pass, npm run check passes (17 runtime assets/13 JavaScript files), npm run build succeeds twice, git diff --check and local documentation-link checks pass.
- Compared extracted navigation, lifecycle, URL and bookmark code with baseline; behavior is unchanged (one comment corrected). Manifest, rules, cancel page and popup files are byte-identical to baseline.
- Build output is ignored at dist/extension. Removed files remain recoverable from Git commit 3e2f9c4; no changes committed/pushed and no browser data touched.
