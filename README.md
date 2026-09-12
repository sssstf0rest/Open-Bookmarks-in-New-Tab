<p align="center">
  <img src="icons/icon-128.png" alt="Open Bookmarks in New Tab icon" width="128">
</p>

<h1 align="center">Open Bookmarks in New Tab</h1>

<p align="center">
  A Chrome extension that automatically opens bookmarks in a new tab instead of replacing your current page.
</p>

## Background

This project is inspired by the [Open Bookmarks in a New Tab](https://chromewebstore.google.com/detail/open-bookmarks-in-a-new-t/mcecogccjlcplcccpnejnldpijppkfil) extension. It adopts the same core technique (the `newtab@` URL prefix trick) with two improvements:

1. **Local, download-free navigation cancellation** — Marked navigations are redirected to a local endpoint that returns HTTP `204 No Content`. The extension no longer creates or cancels a dummy `empty.zip` download, eliminating that source of Save As dialogs and download animations. Existing special-domain bookmarks still use a GitHub Pages URL wrapper; see the limitations below.

2. **Smart empty-tab handling** — When the current tab is empty (Chrome's new tab page, `about:blank`, etc.), the bookmark opens **in that tab** instead of creating an unnecessary second tab. Native newly opened bookmark tabs can also be reused.

## How It Works

The extension uses the **"newtab@ prefix" trick** (explained in detail in [this article](https://dev.to/vitalets/open-bookmarks-in-a-new-tab-by-default-easier-said-than-done-a3n) by Vitaliy Potapov):

1. **Bookmark rewriting** — On install/enable, HTTP(S) bookmark URLs are marked, for example from `https://example.com` to `https://newtab@example.com`. The marker uses the URL userinfo field ([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.1)). Configured special domains, including Gmail and Outlook, use a redirect-page wrapper instead. Existing marked bookmarks are migrated when necessary.

2. **Local 204 response** — A `declarativeNetRequest` rule redirects marked main-frame requests to the extension's `cancel.html` endpoint. A synchronously registered service-worker handler returns a bodyless HTTP `204` with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-store`. This stops navigation without deliberately starting a download or replacing the source document.

3. **Destination opening** — `webNavigation.onBeforeNavigate` identifies the clean destination and exact source tab. After loading stored settings, it opens the destination with the requested focus and placement, or reuses a blank tab. Tab-specific handoffs prevent unrelated tabs from being used as the source.

4. **Compatibility fallback** — If interception is bypassed and the marked navigation commits, the extension can attempt `tabs.goBack()` after opening the destination. It never closes an existing source tab when restoration fails. If the primary event was missed, the committed URL is cleaned in place. These fallbacks cannot guarantee uninterrupted media.

5. **Cleanup on pause** — Turning the extension off **in its popup** restores bookmark URLs and disables the redirect rule. Pause before disabling or uninstalling through Chrome; Chrome does not provide a pre-uninstall cleanup event.

The background worker is organized into focused scripts under `js/worker/`. See [Architecture](docs/architecture.md) for responsibilities and compatibility requirements.

## Features

- **Download-free interception** — Local HTTP 204 cancellation; no dummy ZIP, downloads permission, or global download-UI suppression
- **Toggle on/off** — Pause the extension without uninstalling; bookmark URLs are restored
- **Focus control** — Choose whether newly created destination tabs receive focus
- **Tab placement** — Open tabs at the end of the source window's tab bar or immediately to the right
- **Blank-tab reuse** — Avoid unnecessary extra tabs when opening a bookmark from an empty page
- **Native background opening** — Preserve background behavior for native bookmark tabs opened with Cmd/Ctrl-click or middle-click
- **Automatic bookmark maintenance** — Mark new and edited bookmarks, with an editing delay to preserve save-dialog renaming
- **Bilingual popup** — Compact, dark-themed settings in English and Chinese

## Installation

### Chrome Web Store

Install the published version from the [Chrome Web Store](https://chromewebstore.google.com/detail/open-bookmarks-in-new-tab/kklcekgmidaafmelbbbmmgcfgfigghmo). The published version may differ from the current repository source.

### Manual (Developer Mode)

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. Click the extension's toolbar icon to configure it.

No build step is required to load the source. After editing or updating, reload the extension from the **same directory** to preserve its unpacked installation identity.

For testing, use a disposable Chrome profile without sign-in or sync. Do not run the store version and an unpacked copy against the same bookmarks.

### Development Checks and Build

Use Node.js 18 or newer. No dependency installation is required.

```sh
npm run check   # Validate syntax, manifest/rules and runtime resource references
npm test        # Run worker and packaging regression tests
npm run build   # Recreate dist/extension with runtime files only
```

For a separate packaged-build test, load `dist/extension` in the disposable profile. The build recreates that generated folder; do not edit files there. It excludes development files and does not create a release ZIP or publish the extension.

See [Repository Guidelines](AGENTS.md) and [Testing](docs/testing.md) for contributor instructions and browser acceptance checks.

## Known Limitations

- **Media playback depends on page behavior** — HTTP 204 avoids replacing the source document but may still trigger lifecycle handlers such as `beforeunload`. Uninterrupted playback on Spotify and other streaming sites is not guaranteed. If playback is affected, **pause the extension first**, then use **Cmd/Ctrl-click** or middle-click.
- **Special-domain wrappers and favicons** — Gmail, Outlook, and other configured domains use a GitHub Pages wrapper to handle browsers stripping the `newtab@` marker. Their favicons may differ from the destination site's icon. Working interception handles the request locally; if the helper page loads as a fallback, its URL includes the encoded bookmark destination and is sent to the hosting service.
- **Non-HTTP(S) bookmarks** — URLs such as `chrome://`, `edge://`, `about:`, and `file://` retain native behavior. HTTP(S) LAN addresses such as `http://192.168.1.1/` are handled as ordinary web bookmarks.
- **Bookmark URLs are modified** — Markers are visible in bookmark properties and may sync through Chrome. Pause in the popup before disabling or uninstalling to restore them.
- **New-bookmark editing delay** — Newly created bookmarks remain unmarked for about five seconds after their last edit, so clicking them during that interval may use native same-tab behavior.
- **Browser-specific compatibility** — Cold starts, folder opening, incognito, and media playback should be checked on each supported platform. If the `cancel.html` warning page becomes visible, the worker did not supply the expected 204 response; pause and report the browser version and reproduction steps.

## Permissions

| Permission | Reason |
|---|---|
| `bookmarks` | Read, mark, migrate, and restore bookmark URLs |
| `tabs` | Read the exact source tab and open/reuse destination tabs with the requested focus and placement |
| `storage` | Store preferences in Chrome sync storage and pending bookmark IDs in session storage |
| `declarativeNetRequest` | Redirect marked main-frame requests to the local 204 endpoint |
| `webNavigation` | Detect marked navigations and correlate commits or cancellations with their source tabs |
| `<all_urls>` (host) | Allow redirect rules to handle HTTP(S) bookmarks across websites |

The extension does **not** request `downloads`, `downloads.ui`, `alarms`, or `scripting`. It includes no analytics or developer-run data collection. See the [privacy policy](docs/privacy-policy.html) for Chrome synchronization and redirect-helper details.

## License

MIT
