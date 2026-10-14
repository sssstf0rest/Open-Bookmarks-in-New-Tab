# Browser and Regression Testing

The current source uses local HTTP 204 navigation cancellation. Version remains
`2.5.0`; local repairs do not publish a new store release.

## Scope and Current Evidence

The extension replaces the old dummy download with a local, bodyless HTTP 204 response.
It retains `newtab@`, special-domain wrappers, popup settings, and bookmark
migration. Explicit HTML content type is required; do not remove it. The fetch
handler is registered before asynchronous initialization and never opens tabs.

Download permission, cancellation/erasure, and the no-op alarm are removed.
Native new tabs are reused rather than relying on Chrome's download teardown.
Navigation state is tab-specific and cleared on abort, later navigation, or tab
removal. The fallback no longer closes an existing source tab on history failure.

`npm test` tests the actual worker and its synchronous imports inside a mocked Chrome
environment. Passing these tests does **not** verify browser MIME classification,
native dialogs, service-worker waking, document preservation, or music playback.
On 2026-09-12 the user reported that the prototype works perfectly, resolving their
reported macOS issue. This is user-reported validation, not an independently run
acceptance matrix. The structural cleanup preserves that implementation; reload
and smoke-test it after updating. Cross-platform/media coverage remains pending.

## Safe Manual Setup

1. Create a disposable Chrome profile **without signing in or enabling sync**.
   Do not install this prototype alongside the store version in the same profile.
2. In `chrome://extensions`, enable Developer mode and Load unpacked using the
   repository source directory. Alternatively, run `npm run build` and load
   `dist/extension` in this separate test profile. Do not switch directories for
   an existing installation or run both copies together.
3. Add only test bookmarks. A newly saved bookmark stays unmarked while its page
   is selected in any window. Switch to another tab, navigate away, or close the
   page, then allow at least five seconds for marking. Check its stored URL in
   the bookmark manager. Resume also respects this editing protection.
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

## Native Bookmark Save Dialog

The folder-selector repair addresses a supported URL-lookup race. The reported
persistent freeze has not yet been independently reproduced in native Chrome.
See [the investigation](bookmark-folder-selector.md) for source evidence and
limits. Worker mocks cannot establish whether a native dialog opens or freezes.

Use one disposable, normal Chrome profile for the enabled/paused comparison;
pause through the extension popup so stored URLs are restored. Incognito changes
several conditions and does not by itself isolate the extension as the cause.
Record Chrome version, OS, extension state, worker state, and actual results.

On the original source, before applying the repair:

1. Open a unique HTTP(S) test page, press Cmd/Ctrl+D, and keep the native bookmark
   bubble open for more than five seconds. If Chrome presents a simplified save
   flow, open its editing controls before waiting.
2. Open the Folder dropdown and select “Choose another folder.” Record whether
   the folder tree opens; also test a changed name, a recent-folder selection,
   and the bubble's Remove action on separate test bookmarks.
3. Repeat immediately with the popup paused, using fresh test URLs/bookmarks.
   Compare results in this same profile. A failure appearing only after the
   enabled URL rewrite supports the race; record any longer-lived freeze
   separately rather than treating it as established by this test.

On the repaired source, require all of the following:

| Scenario | Required result |
| --- | --- |
| Bubble open longer than five seconds, including 60 seconds | Stored URL stays clean; “Choose another folder” opens the native folder tree |
| Rename, choose a recent folder, choose a different folder in the tree | Saved title and parent folder match the user's choices |
| Remove from the bubble while pending | Bookmark is removed; pending work does not recreate it |
| Switch tab, navigate away, or close the source page | Bookmark is marked after at least five seconds without another edit or matching selected page |
| Same page selected in a second window | Protection continues until no window has that page selected, including windows without focus |
| Ordinary URL and special-domain wrapper URL | Both preserve editing, then migrate to the current scheme |
| Pause and resume while the source page is selected | URL stays clean until the page is no longer selected and the settling interval completes |

For a cold-worker case, save a bookmark and leave its page selected. Close the
worker inspector, wait at least 60 seconds, and confirm the worker is inactive.
Wake it with another browser event while the source page remains selected;
restored pending work must leave the URL clean. Then switch/navigate/close the
source and verify marking after the settling interval. Repeat using a bookmark
created while the worker was already inactive.

Also save a bookmark while its page stays selected, then quit and restart the
disposable browser. Session storage is cleared on browser restart. The fresh
session scan must rediscover that clean bookmark, keep it clean while selected,
and mark it after leaving the page and the settling interval. Test extension
disable/re-enable in the disposable profile as a second session-reset case.

Repeat save/edit/folder/remove trials with fresh URLs at least 20 times, across
two windows and with both warm and sleeping workers. After marking, verify
ordinary clicks still open exactly one new tab and preserve the source page.
Record observed native results separately from automated regression results.

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
