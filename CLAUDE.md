# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3, v2.3.2) that opens bookmarks in a new tab without navigating the current page. There is no bookmark-click event in the Chrome APIs, so the extension rewrites bookmark URLs with a marker, intercepts the resulting navigation, and opens the real URL itself.

## Branch Topology — read this first

`main-branch-folk` is a fork of `main` with identical history (currently v2.3.2, `newtab@` marker + typed-204 cancellation). Two architectures exist in this repo, and mixing them up is the most likely way to get lost:

| Branch | Version | Marker | Cancellation |
|---|---|---|---|
| `main-branch-folk` (this one) | 2.3.2 | `newtab@` userinfo + GitHub Pages proxy for some domains | service-worker typed HTTP 204 (`cancel.html`); `empty.zip` kept as rollback |
| `main` | 2.3.0 | same marker | dummy `empty.zip` download, cancelled |
| `codex/fix-chrome-usage-issues`, `aug-bug-fix` | 2.4–2.5.0 | trailing `?<runtime-id>=…` query param | service-worker-generated typed HTTP 204 (`cancel.html`), no download at all |

`task_plan.md`, `findings.md`, and `progress.md` at the repo root describe the **query-marker rewrite**, not the code on this branch. Treat them as a research log and design rationale (they record Chrome-151 experiments comparing DNR block, extension-page redirect, `window.stop()`, and 204 cancellation), not as documentation of the current source. Same for any `js/url-utils.js` or `tests/` references — those exist only on `aug-bug-fix`.

## Development

No build step and no test suite on this branch — plain HTML/CSS/JS loaded directly by Chrome.

1. `chrome://extensions/` → enable Developer mode
2. **Load unpacked** → select this folder
3. After editing, click the refresh icon on the extension card. Reloading re-runs `init()` but not `onInstalled`, so bookmark re-prefixing does not happen on reload — toggle the extension off/on in the popup to force a full rewrite.
4. Service-worker logs (`[Bookmarks→NewTab] …`) appear under the "service worker" link on the extension card, not the page console.

Verifying changes means watching real bookmark clicks: check that exactly one destination tab opens, that the source tab is untouched, and that no download appears in `chrome://downloads`.

## How the navigation is cancelled — the typed 204

Nothing can stop Chrome starting the navigation when a bookmark is clicked, so the marker navigation has to be made to resolve to *not a page*. The DNR rule ([rules.json](rules.json)) redirects it to `cancel.html`, and the service worker's top-level `fetch` handler answers that request with a body-less, HTML-typed **HTTP 204**. Chrome treats a typed 204 as an aborted no-content navigation: the source tab keeps its document and **no `DownloadItem` is created**.

Three things about this are load-bearing:

- **The `Content-Type` header is not decoration.** Without it Chrome classifies the response as an interrupted zero-byte download (`SERVER_BAD_CONTENT`), which is the behaviour this replaced.
- **No download means uncommitted tabs survive.** Chrome closes a tab whose navigation resolves to a download while it has nothing committed — `web_contents->Close()` in `download_ui_controller.cc`, gated on `NavigationController::IsInitialNavigation()`. That is what used to destroy a still-loading bookmark tab when the next bookmark was clicked, and what made a Cmd+Click tab vanish. With no `DownloadItem`, that path is never reached. Note the old `downloads.cancel()` did not help: `CANCELLED` is precisely the state that lets control *fall through* to `Close()`.
- **The worker is now on the critical path.** Chrome used to serve the redirect target from the bundle with no worker involved. Now a terminated worker must boot before the navigation can be aborted, and the source page sits in a pending navigation until it does. That is why the keep-alive alarm matters more than it used to, not less.

`downloads.onCreated` is retained for one release as a fallback: if some Chrome build turns the 204 into a download anyway, it still cancels it and logs a warning, degrading to the old behaviour rather than stranding the user. **A silent service-worker console means the 204 is working.** `empty.zip` stays web-accessible so reverting `rules.json` to `/empty.zip` is a complete rollback.

## Interception Chain

Three listeners race on every bookmark click; understanding their ordering is essential:

1. **`webNavigation.onBeforeNavigate`** ([js/background.js:830](js/background.js:830)) — the **primary** path. Fires before the declarativeNetRequest redirect, so it opens the destination tab immediately rather than waiting for the download round-trip. It records `details.tabId` in `handledTabs` **synchronously before any `await`**, so the other two listeners can see the entry. Do not move that `set` below an await.
2. **`downloads.onCreated`** — legacy safety net only; with the typed 204 it should never fire. If it does, it cancels and erases the download and logs a warning. **It has no tab identity** (`DownloadItem` carries none), so it correlates on the destination URL via `recentlyOpenedUrls` and, when it does fall back, calls `openInNewTab` with no tab id so a new tab is created rather than an existing one guessed at.
3. **`webNavigation.onCommitted`** — restore path. Handles the two cases where the source tab actually navigated: the prefix survived to commit (Edge, timing), or Chrome stripped the prefix before DNR could match. Restores via `restoreSourceTab`.

### `restoreSourceTab` — never destroy a tab that has something in it

Both restore branches funnel through one helper. Order: `tabs.goBack()` if there is history; otherwise, if the tab is in `openedTabs` (a destination tab of ours that had not finished loading), **re-navigate it to the URL it was loading**; only a tab with neither history nor a destination of its own is removed.

This exists because the old `goBack → tabs.remove` chain destroyed the user's still-loading tab whenever the marker was stripped (Gmail/Outlook/Baidu/Edge) — *we* closed it, not Chrome.

Both restore branches also require `isBookmarkNavigation(details)` — `transitionType` of `auto_bookmark` or `typed`. Without that check the branches matched on tab id alone for the whole 10s TTL, so with `focusNewTab` off, clicking a bookmark and then any link on the source page made that tab jump backwards a page. A link click commits as `link`, which is what separates them.

### Two handoff maps — `handledTabs` and `recentlyOpenedUrls`

The three listeners share state through two maps, both written **synchronously in `onBeforeNavigate` before any `await`** and both expiring after `HANDOFF_TTL_MS` (10s):

- **`handledTabs`** (`Map<tabId, {cleanUrl, reused, seq}>`) — read by `onCommitted`, which knows the tab id.
- **`recentlyOpenedUrls`** (`Map<cleanUrl, seq>`) — read by `downloads.onCreated`, which does **not** know the tab id and never can. `DownloadItem` has no `tabId` field, so the URL is the only thing both listeners can see. The download listener extracts `cleanUrl` *before* `cancel`/`erase` so its dedup decision reflects state as of `onBeforeNavigate`, not several IPC hops later. `onCommitted`'s full fallback also consults this map before creating a tab — that was the third duplicate-tab source.

Keying the download path on `tabId` is what produced duplicate tabs on every click; don't reintroduce it.

`seq` is a monotonic stamp and each expiry timer deletes **only** the entry carrying its own `seq`. Without it, clicking the same tab (or the same URL) twice inside the 10s TTL let the first click's timer evict the second click's entry, dropping `onCommitted` into the full-fallback path.

### `handledTabs` and the `reused` flag

`handledTabs` (`Map<tabId, {cleanUrl, reused, seq}>`, [js/background.js:158](js/background.js:158)) is the deduplication state, cleared after 10s. `reused: true` means `openInNewTab` navigated the **source** tab directly because it was an empty/new-tab page ([`isReusableBlankTab`](js/background.js:492)). When `reused` is set, `onCommitted` must **not** restore the tab — the commit is the intended destination, and its final URL may legitimately differ from `cleanUrl` after server-side redirects (`chat.openai.com` → `chatgpt.com`, `baidu.com` → `www.baidu.com`). Breaking this check makes destination tabs close themselves.

## Credential-Stripped Domains

Chrome's network stack silently strips the `newtab@` userinfo on certain high-security domains before DNR sees the request, so the rule never matches. `CREDENTIAL_STRIPPED_DOMAINS` ([js/background.js:90](js/background.js:90) — Gmail, Outlook, Baidu) routes those bookmarks through a GitHub Pages proxy instead:

```
https://newtab@sssstf0rest.github.io/…/redirect.html?url=<encoded original>
```

`REDIRECT_PAGE_BASE` is served from [docs/redirect.html](docs/redirect.html) via GitHub Pages. **The constant and the deployed page are coupled** — changing one without the other silently breaks every Gmail/Outlook bookmark. `removePrefix` unwraps the `?url=` parameter back to the real URL, and `redirect.html` self-redirects after 1.5s so bookmarks still work when the extension is disabled. Cost: these bookmarks show the proxy's favicon, not the site's.

Changing this list **does** migrate existing bookmarks, as of 2.3.1. `prefixAllBookmarks` transforms with `migrateUrl` ([js/background.js:346](js/background.js:346)), not `addPrefix` — `addPrefix` returns early on anything already marked, so before this a bookmark saved as `https://newtab@gmail.com/` kept that form forever even after `gmail.com` joined the list. That is why the same Gmail bookmark misbehaved for some users and not others: only a manual pause/resume converted it.

`migrateUrl` unmarks and re-marks, so it converges in both directions — it wraps a bookmark whose domain was **added** to the list and unwraps one whose domain was **removed** (the list has shrunk historically; `youtube.com`, `google.com`, `open.spotify.com` were all on it once). It is idempotent, and `walkNodes` only writes when the URL actually changes, so a no-op run costs no bookmark writes.

Two URL shapes are deliberately left untouched: a proxy-wrapped bookmark whose `?url=` payload cannot be recovered (unwrapping would yield the redirect page itself), and one whose payload is not `http(s)`.

**The `?url=` payload is untrusted input.** It rides in a bookmark, so it syncs between machines and can be edited by hand or by another extension. Both consumers validate it: `removePrefix` returns the payload only when it is `http(s)` (it is handed straight to `tabs.create`), and `redirect.html` parses it with `new URL(raw)` — **no base argument**, so a relative or protocol-relative payload like `//evil.com` throws instead of resolving against the proxy origin — then requires `http:`/`https:` before touching `location.replace` or the `<a href>`. Both were live sinks: assigning a `javascript:` URL to `location.replace` executes it in the GitHub Pages origin.

Editing [docs/redirect.html](docs/redirect.html) only takes effect once it is **pushed and GitHub Pages redeploys** — the checked-in file and the served page are separate things.

## Settings

Stored in **`chrome.storage.sync`** under key `"settings"` (not `local` — the privacy policy's "local storage" wording is stale):

- `enabled` (bool) — toggles bookmark prefixing and the DNR ruleset together. `init()` calls `reconcileRuleset()` ([js/background.js:1348](js/background.js:1348)) on every worker start to force those two back into agreement: the static ruleset's enabled state is persisted **per profile**, while bookmark markers travel **between** machines via bookmark sync (the marker is part of the URL). Without reconciliation a profile could hold fully marked, synced bookmarks with the ruleset disabled — the rule never matches, no download is created, and the source tab visibly navigates and gets restored instead. This also covers a static ruleset reverting to its manifest default after an update while the user has the extension paused.
- `focusNewTab` (bool)
- `position` (`"end"` | `"right"`)

The popup talks to the worker through `getSettings` / `updateSettings` messages ([js/background.js:1246](js/background.js:1246)). A separate `storage.onChanged` listener ([js/background.js:1274](js/background.js:1274)) re-applies enable/disable when settings sync from another device — so a toggle can trigger a full bookmark rewrite without any local user action.

Popup language (`lang`, EN/ZH) is stored separately in `storage.sync`. Popup strings live in the `I18N` object in [js/popup.js](js/popup.js) and are applied to `[data-i18n]` elements; any new popup text needs both a `data-i18n` attribute and entries in **both** language maps.

## Key Constraints and Known Traps

- **`settingsReady` gates only the bookmark-mutating listeners — never add it to `onBeforeNavigate`.** `settings` starts as `DEFAULT_SETTINGS` (`enabled: true`) and `init()` replaces it asynchronously, so on a cold worker a listener can act on a guessed enabled state (visible bug: pause, let the worker sleep, add a bookmark — it gets marked anyway). `bookmarks.onCreated`, `bookmarks.onChanged`, and `storage.onChanged` await it. The navigation and download listeners deliberately do **not**: their real guard is `hasPrefix()`, which is already false when paused, and awaiting would destroy `onBeforeNavigate`'s synchronous handoff write. `init()` resolves the gate in a `finally`, so a failed settings read cannot hang every bookmark listener for the life of the worker.
- **`isOurDownload` must not claim a download on referrer alone.** This listener cancels *and erases* whatever it claims, so a false positive silently destroys a download the user wanted — any real file started from a page reached through the proxy still carries `newtab@` in its referrer. Claiming is based on the download's own URL (`DownloadItem.url` is the pre-redirect marker, `finalUrl` is our `cancel.html` (or legacy `empty.zip`)); the referrer is only a last-resort way to recover the destination *after* the download is already claimed.
- **A newly created bookmark is NOT marked immediately — never "optimise" that away.** Chrome's Ctrl/Cmd+D bubble holds no pointer to the bookmark it created; on commit it looks the node up **by the page's URL** (`GetMostRecentlyAddedUserNodeForURL`). Marking on `onCreated` changes that URL to `https://newtab@…`, the lookup finds nothing, and any rename the user typed in the bubble is silently discarded — the bookmark keeps its original title. (Renaming afterwards via right-click → Edit works, because that dialog edits by node id, which is what makes the bug look inconsistent.) `scheduleBookmarkMark` therefore waits `NEW_BOOKMARK_SETTLE_MS` (10s) of no changes before marking, and every `onChanged` on a still-pending bookmark restarts the clock. `setTimeout` does not survive worker termination, so pending ids are mirrored into `chrome.storage.session` and `init()` drains them — a bookmark that silently never gets marked would be worse than the bug being fixed.
- **Bookmark URLs are mutated in place.** Enable prefixes every http(s) bookmark; disable strips them. Chrome fires no pre-uninstall event, so uninstalling while enabled leaves prefixed URLs behind permanently.
- **`chrome.bookmarks.onChanged` can loop.** It only re-prefixes when the prefix is absent ([js/background.js:594](js/background.js:594)); removing that guard causes an infinite update cycle.
- **`DownloadItem` has no `tabId`** — the download listener can never identify its own tab. Fixed by URL-keyed dedup (see above); the old `downloadItem.tabId` check was dead code that duplicated a tab on every click. **Never guess the tab with `tabs.query({active:true})`** — that is why `openInNewTab` deliberately has no active-tab fallback ([js/background.js:764](js/background.js:764)). Guessing produced the duplicate when `focusNewTab` was off, and collapsed "Open all bookmarks" onto a single tab when it was on.
- **Only reuse a tab that has COMMITTED a new-tab page** — `isReusableBlankTab` ([js/background.js:492](js/background.js:492)). This is the single most important invariant on this branch, and the reason is not tidiness:
  - A tab with **no committed URL** (`tab.url === ""`) is one Chrome created *for this navigation* — Cmd/Ctrl+click, middle-click, "Open all bookmarks". Its only navigation is the `newtab@` marker, which DNR turns into a download, and **Chrome discards a tab whose sole navigation became a download**. That teardown reliably beats the extension's `tabs.get` → `tabs.update` round-trips, so navigating such a tab hands the user a tab that vanishes. Create a new tab and let Chrome discard the doomed one.
  - A tab **with** a committed document (including `chrome://newtab`) survives the download, so reusing it is safe.
  - Do not "improve" this by consulting `pendingUrl` to reuse a tab loading our own marker. That was tried and it made Cmd+Click open a tab that immediately disappeared, and left "Open all bookmarks" with no tabs at all.
- `isNewTabPage` keeps its permissive `!url → true` behaviour because `onCommitted`'s fallback still depends on it; the strict check lives only in `isReusableBlankTab`.
- **`downloads.setUiOptions` silently fails.** The call at [js/background.js:1246](js/background.js:1246) needs the `"downloads.ui"` permission, which the manifest does not declare — it rejects and is swallowed. Adding the permission also suppresses download UI profile-wide, which is why the newer architecture eliminates the download entirely instead.
- **Only `http(s)` URLs can carry the prefix.** `chrome://`, `edge://`, `about:`, `file://` bookmarks keep default behavior.
- **Media on the source page can still be interrupted.** Chrome begins tearing down the renderer before extension code runs; Spotify is the reliable reproducer. This is inherent to MV3 and was not solved on this branch.
- **Service worker keep-alive** is a 30s no-op alarm ([js/background.js:1186](js/background.js:1186)). It is now on the critical path: the `fetch` handler answers the redirect target, so a terminated worker must boot before the marker navigation can be aborted. Unreliable by design — treat boot latency, not correctness, as the failure mode.
- **README drift:** the permissions table lists `scripting` and describes a `window.stop()` + `history.back()` fallback. Neither exists in the manifest or the code on this branch.

## Generated / Non-Source Files

- `_metadata/generated_indexed_rulesets/` — Chrome-generated DNR index, committed but never hand-edited
- `empty.zip` — former redirect target, no longer used. Kept web-accessible for one release so reverting `rules.json` to `/empty.zip` is a complete one-line rollback.
- `cancel.html` — current redirect target; normally never rendered, because the fetch handler answers it with a 204
- `chrome-web-store-publishing-kit.zip` — store submission assets
- `docs/` — GitHub Pages site (redirect proxy + privacy policy)
- `css/CLAUDE.md`, `js/CLAUDE.md` — claude-mem auto-generated context only, no human guidance

<claude-mem-context>
# Recent Activity

<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->

*No recent activity*
</claude-mem-context>