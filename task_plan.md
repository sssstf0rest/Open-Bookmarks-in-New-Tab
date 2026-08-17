# Task Plan: Chrome Reliability and Security Fixes

## Goal
Create and publish a dedicated GitHub branch that fixes the confirmed audit defects and user-reported Chrome problems without touching the user's normal Chrome profile.

## Current Phase
Complete

## Phases

### Phase 1: Branch and Baseline
- [x] Create the fix branch from `origin/main`
- [x] Inventory every required fix and define acceptance criteria
- [x] Establish baseline static and isolated-browser behavior
- **Status:** complete

### Phase 2: Navigation Architecture and Bookmark Recovery
- [x] Remove duplicate-tab and dummy-download UI failures
- [x] Preserve the source document and audio context without reloading, closing, or navigating it backward
- [x] Handle LAN, credential-bearing, proxy-domain, empty-tab, and multi-window cases safely
- [x] Add migration/recovery for bookmarks rewritten by released versions
- **Status:** complete

### Phase 3: State, Lifecycle, UI, and Policy Fixes
- [x] Serialize settings/bookmark/ruleset transitions and cold-start initialization
- [x] Fix incognito/update/import/lifecycle/permission concerns
- [x] Fix popup state, language, disabled controls, and accessibility
- [x] Align redirect page, privacy policy, README, and publishing metadata with actual behavior
- **Status:** complete

### Phase 4: Verification
- [x] Run syntax, JSON, archive, and whitespace checks
- [x] Add and run focused automated logic tests
- [x] Validate core navigation behavior in a disposable Chrome profile
- [x] Record Spotify's `beforeunload` limitation explicitly
- **Status:** complete

### Phase 5: Publish Branch
- [x] Review the complete diff and exclude local planning artifacts
- [x] Commit only intentional project changes
- [x] Push the branch to GitHub with upstream tracking
- **Status:** complete

## Acceptance Criteria
- Exactly one destination opens for normal, LAN, and proxy-domain bookmarks.
- No visible or intercepted `empty.zip` download occurs.
- Starting a bookmark navigation does not reload, go back, or close an existing media tab.
- Previously rewritten bookmarks are safely recoverable and ordinary credential URLs are never mutated.
- Disabling, rapid toggling, cold starts, imports, updates, and multi-window navigation leave settings and bookmarks coherent.
- Hosted redirects reject non-HTTP(S) destinations and do not expose URL fragments unnecessarily.
- Popup state and both languages remain accurate and accessible.

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use `codex/fix-chrome-usage-issues` | Required desktop branch prefix and clear scope |
| Use only disposable Chrome profiles | Loading the released extension can rewrite real bookmarks |
| Do not open a PR unless separately requested | The user asked for a GitHub branch, not a pull request |
| Replace `empty.zip` with an extension-origin typed HTTP 204 response | Chrome 151 preserved the source and Web Audio; adding `Content-Type: text/html` prevented any download event/item |
| Use a unique v3 marker appended to the query string | Avoids ordinary credential collisions, round-trips the original URL byte-for-byte, and keeps fragments out of HTTP requests |
| Use a dynamic DNR rule | Avoids manifest-default rule reactivation after updates |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Combined experiment patch matched runner lines against `manifest.json` | 1 | Split the manifest and runner edits into correctly scoped file patches |
| Planning status patch omitted the Markdown status-list marker | 1 | Re-read the exact file context and applied a narrowly scoped patch |
| Findings patch targeted a non-existent heading | 1 | Re-read the file and patched the existing documentation/store section |
| Icon preview used `icon128.png` instead of the repository's `icon-128.png` | 1 | Listed `icons/` and used the exact tracked filename |
| Combined split-incognito patch used the wrong test-harness event context | 1 | Split runtime, utility, and test-harness edits into separately verified patches |
| A VM-origin settings object failed strict prototype equality | 1 | Compared its JSON-safe clone so the test checks values across realms |
| Multi-bookmark migration test assumed traversal order | 1 | Asserted backup membership instead of depending on stack order |
| Disposable v2.3→v2.4 profile did not report migration completion | 1 | Preserved the disposable profile and inspected worker state/logs before changing code |
| Timed-out migration harness kept its disposable Chrome profile locked | 1 | Terminated the yielded test session before reopening that exact temporary profile |
| Flag-loaded unpacked extension did not emit a new worker after `runtime.reload()` | 1 | Relied on the state-less v2.3 VM regression test; kept browser verification focused on supported current-runtime behavior |
| Playwright could not click the visually hidden switch input directly | 1 | Exercised the visible associated label, matching real popup interaction |
| Explicit `git add -u` named deletions that were already staged and absent from the worktree | 1 | Confirmed the deletions were already in the index and validated the complete staged file list |
| Direct HTTPS access to the DNS-selected `github.com` endpoint timed out | 2 | Detected the active local system proxy and used it only for the authenticated push |
| Git credential retrieval stalled through the proxy | 1 | Passed the existing GitHub CLI token through an ephemeral process environment; no credential was printed or written to disk |
| Endpoint probe used zsh's read-only `status` variable | 1 | Retried with task-specific variable names |
| Planning completion script was not executable | 1 | Invoked the same read-only checker explicitly with `bash` |

## Notes
- `AGENTS.md` is a pre-existing requested contributor guide and may be included if it remains intentional.
- `task_plan.md`, `findings.md`, and `progress.md` are local working-memory artifacts and should not be staged.
