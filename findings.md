# Chrome Reliability Fix Findings

## 2026-09-12 macOS popup investigation

### Follow-up evidence
- User reports Windows also has Ask where to save enabled; preference difference does not explain the platform difference.
- Mac now verified at 153.0.8010.37. With prompting disabled, download animation still appears but empty.zip is absent from destination folder. This is consistent with cancellation working after the UI starts; no native event trace collected yet.
- Earlier preference workaround is insufficient for the requested no-visible-download behavior.
- Direct 152.0.7977.83→153.0.8010.37 comparison: mac file dialog, download_bubble_ui_controller.cc, and download_display_controller.cc unchanged. DownloadUIController changes security metrics and initial-navigation web-app closure, not the shared desktop UI gate. File picker adds request initiator to authority derivation. Download API adds ShouldExport filtering when looking up a download (under review).
- Correction after reading the full function: DownloadUIController::OnDownloadUpdated passes its target-path gate for canceled items, but returns for CANCELLED at lines 282–284 before OnNewDownloadReady. Cancellation itself does not initiate the started-animation notification through this path.
- Confirmed stronger animation mechanism in Chrome 153 download_toolbar_ui_controller.cc: UpdateDownloadIcon sets has_pending_download_started_animation_ and queues ShowPendingDownloadStartedAnimation. The latter checks animation eligibility/visible contents/button, but no DownloadItem state or existence. An already-queued animation can play after cancel+erase. DownloadItemModel animation eligibility excludes save-page packages and trusted extension-install downloads, not ordinary ZIP files served by an extension.
- Chrome 153 download API lookup adds ShouldExport filtering for temporary/INTERNAL_API downloads; no evidence this classifies the ordinary navigation-triggered empty.zip or explains a Mac-only regression. Do not claim API breakage.
- Compared download_toolbar_ui_controller.cc across 151.0.7922.138, 152.0.7977.83, and 153.0.8010.37: animation queue and playback functions unchanged. 151→152 other changes are include/destructor/profile refactors and offline-item initialization; 152→153 changes browser accessor/constructor handling. No identified new animation behavior explains onset.
- Windows native file picker also just clears its listener on ListenerDestroyed; no evidence of a Windows-specific guaranteed cancellation advantage. Platform/profile scheduling remains a hypothesis requiring matched runtime traces, not a confirmed OS bug.
- Animation source: https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/browser/ui/views/download/bubble/download_toolbar_ui_controller.cc#511 and #833.
- Tried obsolete download_toolbar_button_view.cc path (404); using current download_toolbar_ui_controller.cc next.

- Current branch download-popup-fix uses the released static empty.zip DNR architecture.
- Installed /Applications/Google Chrome.app version: 152.0.7977.83.
- Occupied source uses tabs.create; blank committed source uses tabs.update with the clean URL, which can supersede the marked navigation before download creation.
- Download cancellation and erasure happen after onCreated. UI suppression calls setUiOptions without downloads.ui and swallows the error.
- Requested popup type and unaffected Windows version from user; not yet known.
- Mac Default profile is last-used; Preferences has download.prompt_for_download=true and download_bubble.partial_view_enabled=false. This strongly points toward a save-location dialog, pending user confirmation.
- The installed Web Store extension is 2.4.0 with empty.zip; Chrome release announcement dates 152.0.7977.82/.83 to September 3, 2026. The installed Info.plist mtime is September 9 (not proof of first relaunch).
- Web retrieval of exact Chromium 152 source/log failed; attempt direct source retrieval before attributing a change to Chrome.
- User confirmed native macOS Save As dialog; unaffected Windows version is 153.0.8010.36 (newer than installed Mac).
- Direct Gitiles TEXT retrieval succeeded. Compared 151.0.7922.138 with 152.0.7977.83: download_file_picker.cc, extensions/api/downloads/downloads_api.cc, and select_file_dialog_mac.mm are byte-identical. download_target_determiner.cc differs only in Android incognito handling. This rules out a direct change in these four files, not changes elsewhere or field trials.
- Chrome 152 DownloadTargetDeterminer checks IN_PROGRESS before requesting confirmation and selects PREFERENCE when PromptForDownload() is true. Cancellation arriving later cannot guarantee that no dialog has been initiated.
- Installed Web Store background.js is byte-identical to repository background.js.
- DownloadFilePicker in Chrome 152 handles FileSelected/FileSelectionCanceled by deleting itself, but OnDownloadDestroyed only clears download_item_. It does not close the picker when its DownloadItem is erased; this explains why an already-started dialog can outlive cancellation/history cleanup.
- Diagnosis: confirmed unsafe architecture plus enabled save-location preference; observed behavior is consistent with prompt creation beating async cancellation. No event trace/A-B run collected, so the precise recent timing trigger is unproven. Windows preferences and previous Mac version are unavailable.
- Immediate diagnostic/workaround: manually toggle Ask where to save each file OFF in chrome://settings/downloads and retry, then restore preferred setting. This affects all downloads and does not repair the underlying race.
- Candidate durable fix: avoid creating DownloadItem entirely, e.g. local HTML-typed 204 cancellation; prior experiments are historical and require fresh Chrome 152/153 native-dialog validation. Adding downloads.ui is not a fix for the native save dialog and globally changes browser download UI.
- Sources: https://chromereleases.googleblog.com/2026/09/stable-channel-update-for-desktop_01882797386.html ; https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.83/chrome/browser/download/download_target_determiner.cc ; https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.83/chrome/browser/download/download_file_picker.cc ; https://developer.chrome.com/docs/extensions/reference/api/downloads .

Earlier findings below describe prior work and must not be assumed current.

## Required Fix Inventory

### Browser-confirmed defects
- Duplicate targets: `downloads.onCreated` uses nonexistent `DownloadItem.tabId`, so its fallback opens a second target.
- Uninstall persistence: Chrome has no pre-uninstall cleanup event; released `newtab@` and hosted-proxy bookmark URLs remain after removal.
- Redirect vulnerability: `docs/redirect.html` accepts `javascript:` and arbitrary cross-origin destinations.
- Credential corruption: injecting `newtab@` into authority components strips a legitimate username or creates a repeated-prefix loop.
- Popup state: changing language after pausing restores the enabled label; document language and disabled-control semantics are stale.
- `downloads.setUiOptions` rejects because `downloads.ui` is undeclared.

### User-reported defects
- Clicking a rewritten bookmark can display an `empty.zip` download window or trigger a third-party download manager.
- LAN bookmarks such as `http://192.168.x.x` can open two targets.
- Initiating a bookmark from a playing Spotify page interrupts playback until reload, while YouTube/Bilibili may continue.

### Reproduced timing/platform risks
- Popup messages acknowledge before bookmark and DNR transitions finish; overlapping toggles leave mixed state.
- State-dependent listeners can run with default enabled state before async storage initialization.
- `handledTabs` is volatile and overwritten by multiple navigations in one tab.
- `onCommitted` can misclassify a normal source because `pendingUrl` is usually unavailable after commit.
- `tabs.create` without `windowId` can target the wrong focused window.
- Manifest-default static rules can reactivate after an update while stored settings remain paused.
- Default spanning mode cannot redirect incognito web navigation to the extension resource.
- Per-bookmark import writes are unnecessarily expensive.
- A 30-second no-op alarm is not a reliable lifecycle mechanism.

### Documentation/store risks
- The live privacy policy says local storage while settings use `storage.sync`.
- Special-domain wrapping puts full destinations, including fragments, in a GitHub Pages query.
- Store/README claims that the current page is never interrupted are stronger than actual behavior.
- `<all_urls>`, downloads, alarms, and the public ZIP expose more surface than desirable.
- The publishing ZIP contained the old policy and four images with stale absolute claims; the main screenshot rendered missing-glyph boxes in the browser chrome. All four assets were regenerated with HTTP(S)-specific, no-download wording and the final policy was embedded byte-for-byte.

## Architecture Questions
- Chrome exposes bookmark creation/edit events but no native bookmark-click event.
- Any automatic solution must recognize a navigation marker and prevent that marker navigation from replacing the source document.
- The released download redirect preserves most source documents but inherently creates a download event and can still disturb media-page lifecycle.
- Candidate replacements must be tested for: source-document preservation, no error page, no visible download, LAN support, empty-tab reuse, and store-compatible permissions.

## Architecture Research
- The current Bookmarks API documents create/change/import/move/remove events but no click/activation event, so the extension cannot observe a bookmark-bar click directly.
- DNR can synchronously block or redirect a main-frame request, but an ordinary block may commit an `ERR_BLOCKED_BY_CLIENT` page and an extension-page redirect normally replaces the source document. Both require browser verification before use.
- `chrome.tabs` has no stop-navigation method. A candidate renderer-side cancellation uses a preloaded content script or `chrome.scripting.executeScript` to call `window.stop()` during `webNavigation.onBeforeNavigate`; timing and restricted-page behavior must be measured.
- A disposable Chrome experiment now compares DNR block, extension-page redirect, message-based `window.stop()`, and script-injection combinations while tracking lifecycle events and a running Web Audio context.
- Disposable Chrome 151 results: DNR `block` commits `chrome-error://chromewebdata/`; a normal extension-page redirect replaces the source; renderer `window.stop()` from `onBeforeNavigate` is too late to prevent either outcome.
- Extension service workers can intercept package-resource fetches. Redirecting the marker to a web-accessible extension path whose fetch handler returns HTTP 204 preserved the exact source document, its timer, and a running Web Audio context while opening one destination.
- Without a MIME type, Chrome classified the extension-scheme 204 as an interrupted zero-byte download (`SERVER_BAD_CONTENT`). Adding `Content-Type: text/html; charset=utf-8` changed the result to an aborted no-content navigation with **no** page download event and **no** `chrome.downloads` item. This satisfies the no-download architecture requirement locally.
- The 204 attempt still fires the source page's `beforeunload` event, so a Spotify-specific verification remains necessary; generic Web Audio stayed `running`.
- Dynamic DNR rules are preferable to the manifest-enabled static ruleset: they persist across extension updates and can be reconciled to the locally stored enabled state.
- A final query marker is stronger than another userinfo marker. Chrome 151 matched it for ordinary, LAN, fragment, and Basic Auth URLs; the worker removed it byte-for-byte before opening the destination. This eliminates special-domain proxies, preserves credentials/favicons, and avoids the repeated-prefix loop.
- The production marker value uses `chrome.runtime.id`, making accidental collisions negligible and allowing synced Web Store bookmarks to work across devices that share the stable store extension ID.
- The production handler verifies that the exact marked URL exists in the bookmark tree. A crafted web link with the public marker is cleaned and honored in the same tab instead of being forced into a new tab.
- Chrome cannot run bookmark cleanup after direct uninstall. The new query marker is reversible on pause/reinstall and usually harmless if left behind, but query-sensitive/signed URLs can still be affected after removal; documentation and uninstall guidance must remain explicit.
- Legacy migration backs up every recognized `newtab@` candidate locally, unwraps the old GitHub query proxy, and repairs repeated encoded `newtab%40` prefixes while preserving the remaining Basic Auth username/password.
- Production Chrome 151 validation passed for a credential-bearing local destination: source document/timer/Web Audio stayed active, one clean destination opened in the same window, the marker never reached the server, no download event fired, and pause/resume restored and re-marked the URL with zero/one dynamic rules respectively.
- Spotify cannot be safely guaranteed for native bookmark clicks. Chrome fires site `beforeunload` handlers before the service worker signal; Spotify registers multiple such handlers. A controlled Spotify-class handler still suspended audio under 204. Deferring handlers for 150 ms worked experimentally but broke real unload confirmation semantics and has no bounded cold-worker latency, so that invasive monkeypatch must not ship by default.

## Evidence Sources
- Local source and disposable Chrome 151 profiles.
- Chrome extension documentation for Bookmarks, DNR, Downloads, Runtime, Storage, Tabs, WebNavigation, web-accessible resources, and service-worker lifecycle.
- GitHub issues #4 and #5 plus the three additional user reports in this task.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Treat media preservation as an architecture acceptance test | Patching duplicate correlation alone would not fix Spotify interruption |
| Prefer eliminating the dummy download over hiding its UI | UI suppression is profile-wide and third-party managers can still intercept downloads |
| Adopt a typed extension-origin 204 cancellation resource | It is local, preserves the renderer, and creates no download item in Chrome 151 |
| Use a final runtime-ID query marker | It survives credential stripping, round-trips exact URLs, and removes the hosted proxy data flow |
| Retain legacy backups for at most 30 days and cap them at 2 MB | Limits credential/token exposure while accommodating large bookmark collections; oversized migrations stop before any bookmark write |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Findings patch targeted a heading name that differed from the file | Re-read the file and patched the existing documentation/store section |
