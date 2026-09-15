# Repository Cleanup Findings

## Pages queue investigation — 2026-09-13
- Latest Pages workflow 34713882106 is queued at cde81752d0a5a802050c9aabe9c2bc1ecc131049, created 2026-09-12 19:20:19 UTC. Prior run 34712194807 succeeded at c512f280ecec0e3e47afa5e8e2c2510bbecfb8d3.
- Pages uses GitHub's legacy branch publishing from main:/docs. Screenshot says Waiting for a runner; no evidence of a code-level build hang.
- GitHub Status currently lists Actions and Pages operational, with no incidents reported September 12–13. This does not rule out a repository-specific queue problem. Source: https://www.githubstatus.com/ .
- Build job 103607420489 has status queued, runner_id/runner_name null and steps empty: no build execution has begun. Prior deployment finished successfully at 2026-09-12 18:47:17 UTC.
- Queued commit changes only package.json and three planning files, not docs/. Live privacy-policy.html and redirect.html both return HTTP 200 and match queued-commit source byte-for-byte; last-modified is 2026-09-12 18:47:12 UTC.
- Conclusion: stalled runner allocation/scheduling, exact infrastructure/account cause unproven. Existing hosted pages are current; no evidence of a project build error. Recommend cancelling stale run, optionally rerun once to verify scheduling recovery; no action taken remotely.

## GitHub release draft — 2026-09-13
- Latest existing release is v2.4.0; no v2.5.0 draft appears in the release list. Current main runtime manifest is 2.5.0.
- Local changes are the packaging metadata fix and planning records; do not commit them implicitly. Verify packaged runtime against the selected remote commit before attaching it to a draft.
- Remote main advanced by a README-only commit to c512f280ecec0e3e47afa5e8e2c2510bbecfb8d3; use that explicit release target. No existing v2.5.0 tag was found. ZIP SHA-256 remains the verified packaging hash.

## Release packaging — 2026-09-13
- Current main is clean; manifest version is already 2.5.0, while package.json remained 2.4.0. Align only development package metadata so the existing version-consistency check passes.
- Build allowlist contains 17 runtime files. ZIP must contain manifest.json at its root, with no outer extension directory, metadata, planning files, tests, tooling, or old ZIPs.
- Confirmed official packaging/update guidance: https://developer.chrome.com/docs/webstore/prepare and https://developer.chrome.com/docs/webstore/update . Actual published version was not checked in the dashboard; archive retains the user's existing 2.5.0 manifest version.
- Created dist/Open-Bookmarks-in-New-Tab-v2.5.0.zip (22,304 bytes), exactly 17 runtime files. All archived files match source and build byte-for-byte; unzip CRC checks pass; root manifest version is 2.5.0.
- SHA-256: fa916cad9068158c3bf13b0ceb4d2a515ca95db51bedbe629df1e30486898ea3.

- Baseline: clean branch `codex/no-download-navigation`, commit `3e2f9c4`, already tracking origin.
- User confirmed the HTTP 204 prototype works. Preserve its implementation rather than redesigning the marker or navigation algorithm.
- Runtime: manifest/rules, cancel page, background worker, popup HTML/JS/CSS, and icons. Hosted `docs/redirect.html` is still needed for existing special-domain bookmark wrappers; privacy policy is also retained at its published path.
- Obsolete tracked files: two old distribution ZIPs, Chrome-generated `_metadata/generated_indexed_rulesets/_ruleset1`, duplicate CLAUDE context files, and release notes describing the removed ZIP mechanism. All are recoverable from baseline Git history.
- Existing background worker has clear boundaries: configuration, settings, URL helpers, bookmark maintenance, navigation handoff, lifecycle. Extract these synchronously without changing function bodies or source entry paths.
- Keep runtime dependency-free. Build output should contain only explicitly listed runtime assets; ignore generated output and Chrome metadata.
- Worker extraction preserves all function bodies and the existing navigation algorithm; only one inaccurate uninstall comment changed. Fetch cancellation remains in the entry script before synchronous imports.
- Added explicit 17-file runtime allowlist, dependency-free syntax/resource checks, a clean build command and byte-for-byte packaging test. Existing 25 worker tests pass after adapting their loader; packaging test also passes.
- Deleted obsolete tracked artifacts and redundant guidance. Kept published docs paths and replaced research-era documentation with current architecture/testing instructions.
- Corrected remaining stale privacy prose claiming storage.local/no network transfers, since current code uses Chrome sync and hosted wrapper fallback. The helper's runtime code is unchanged; its outdated empty.zip comment now describes 204.
