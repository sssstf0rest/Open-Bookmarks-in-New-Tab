# Repository Cleanup Findings

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
