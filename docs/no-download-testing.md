# Non-download Navigation Prototype

Branch: `codex/no-download-navigation`, based on main `bd975e4`.
Version remains `2.4.0` during exploration; this is not a new store release.

## Scope and Current Evidence

The prototype replaces the packaged ZIP with a local, bodyless HTTP 204 response.
It retains `newtab@`, special-domain wrappers, popup settings, and bookmark
migration. Explicit HTML content type is required; do not remove it. The fetch
handler is registered before asynchronous initialization and never opens tabs.

Download permission, cancellation/erasure, and the no-op alarm are removed.
Native new tabs are reused rather than relying on Chrome's download teardown.
Navigation state is tab-specific and cleared on abort, later navigation, or tab
removal. The fallback no longer closes an existing source tab on history failure.

`node --test tests/*.test.cjs` tests the actual worker inside a mocked Chrome
environment. Passing these tests does **not** verify browser MIME classification,
native dialogs, service-worker waking, document preservation, or music playback.
No Chrome 153 browser validation has been performed for this prototype yet.

## Safe Manual Setup

1. Create a disposable Chrome profile **without signing in or enabling sync**.
   Do not install this prototype alongside the store version in the same profile.
2. In `chrome://extensions`, enable Developer mode and Load unpacked using the
   repository source directory. Existing release ZIPs are old and must not be used.
3. Add only test bookmarks. Allow at least five seconds after creation for marking;
   check bookmark properties or pause/resume in the popup to force migration.
4. Set “Ask where to save each file before downloading” **on**. Leave it on for
   the first test pass, then repeat with it off in this disposable profile only.
5. Record the exact OS and Chrome version. Initial targets: macOS ARM
   `153.0.8010.37` and Windows `153.0.8010.36`.

## Acceptance Matrix

| Scenario | Required result |
| --- | --- |
| Occupied page, ordinary bookmark click | Exactly one destination; source document and history unchanged |
| Focus setting on/off; placement end/right; two windows | Correct window, position and focus |
| New-tab page and `about:blank` | Reuse current tab |
| Cmd/Ctrl-click, middle-click, folder “Open all” | No extra blank tabs, duplicates or disappearing tabs |
| Folder with repeated destinations | One tab per bookmark, not one per unique URL |
| Gmail/Outlook wrappers; controlled LAN bookmark | One clean destination; no duplicate or lost source |
| Same bookmark clicked repeatedly; later unrelated navigation | Each intended click handled; no stale back-navigation |
| Spotify, YouTube, Bilibili while playing | Record any interruption or refresh requirement; do not assume success |
| Pause/resume and reload | Markers restore/reapply; stored focus and position respected |
| Incognito (if enabled) | Check separately; compatibility is not established |

For each normal-navigation case require **zero** Save As dialogs, download
animations, or entries in `chrome://downloads`. Also verify a real download still
works normally; this extension should no longer intercept any download.

Repeat occupied-tab tests at least 50 times per download-preference setting.
Perform both warm-worker and cold-worker trials: close the worker inspector,
wait at least 60 seconds, and confirm inactivity in `chrome://extensions` before
clicking. Keeping DevTools attached can prevent suspension and hide cold-start
bugs. Use actual bookmark-bar/menu clicks, not only `tabs.update()` simulations.

## Failure and Rollback

If `cancel.html` becomes visible, a download appears, tabs disappear, or music
stops, record the case, browser version, preference setting, and worker state.
Pause in the extension popup before removing the prototype. Your normal profile
and the original branches remain untouched. Do not ship this branch until the
matrix has been checked on both platforms.

For automated browser testing, Chrome DevTools MCP must expose its extension
tools: add `--categoryExtensions` to its existing server arguments and restart
the MCP server/client. Do not change a personal Chrome profile to work around
missing test tooling.
