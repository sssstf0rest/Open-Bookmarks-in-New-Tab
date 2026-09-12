<p align="center">
  <img src="icons/icon-128.png" alt="Open Bookmarks in New Tab icon" width="128">
</p>

<h1 align="center">Open Bookmarks in New Tab</h1>

<p align="center">
  A Chrome extension that automatically opens bookmarks in a new tab instead of replacing your current page.
</p>

<!--
# Open Bookmarks in New Tab

A Chrome extension that automatically opens bookmarks in a **new tab** instead of replacing your current page.
-->

## Background

> **Experimental branch:** `codex/no-download-navigation` replaces the dummy
> download with a local HTML-typed HTTP 204. Automated logic tests pass; real
> Chrome 153/macOS and Windows validation is still pending. The checked-in release
> ZIPs contain the old extension. Test the source directory, not those archives.
> See [the testing guide](docs/no-download-testing.md).

This project is inspired by the [Open Bookmarks in a New Tab](https://chromewebstore.google.com/detail/open-bookmarks-in-a-new-t/mcecogccjlcplcccpnejnldpijppkfil) extension. It adopts the same core technique (the `newtab@` URL prefix trick) while addressing two issues found in the original:

1. **Local navigation cancellation** — The original extension redirects bookmark requests through `bookmarks-evz.pages.dev`. This prototype stops marked navigations using a local HTTP 204 response. Existing Gmail/Outlook and other special-domain bookmark wrappers still use a GitHub Pages URL; those wrappers are unchanged.

2. **Smart empty-tab handling** — When the current tab is empty (Chrome's new tab page, `about:blank`, etc.), the bookmark opens **in that tab** instead of creating an unnecessary second tab.

## How It Works

The extension uses the **"newtab@ prefix" trick** (explained in detail in [this article](https://dev.to/vitalets/open-bookmarks-in-a-new-tab-by-default-easier-said-than-done-a3n) by Vitaliy Potapov):

1. **Bookmark rewriting** — On install/enable, every bookmark URL is rewritten from `https://example.com` to `https://newtab@example.com`. The `newtab@` part uses the URL userinfo field ([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.1)), which browsers and servers ignore — favicons and titles are preserved.

2. **Non-download response** — A `declarativeNetRequest` rule redirects marked main-frame requests to `cancel.html`. A synchronously registered service-worker fetch handler responds with an empty HTTP `204`, `Content-Type: text/html; charset=utf-8`, and `Cache-Control: no-store`. This is intended to preserve the source document without creating a download.

3. **One navigation handler** — `webNavigation.onBeforeNavigate` opens the clean destination using the exact source tab and stored focus/placement settings. Blank pages and native newly opened tabs are reused. There is no download listener or download-history cleanup.

4. **Compatibility fallback** — If interception is bypassed and the source actually commits, a correlated handoff can attempt `tabs.goBack()`. It never closes the source on failure. If the primary event was missed, the committed marker is cleaned in place. These fallbacks cannot guarantee uninterrupted media.

5. **Cleanup on disable** — When toggled off, all bookmark URLs are restored to their original form (prefix stripped).

## Features

- **Toggle on/off** — Pause the extension without uninstalling (bookmarks are automatically restored)
- **Focus control** — Choose whether the new tab gets focus
- **Tab placement** — Open new tabs at the end of the tab bar or right next to the current tab
- **Auto-prefix** — Bookmarks added or edited while the extension is active are automatically prefixed
- **Dark-themed popup** — Clean, compact settings UI

## Installation

### Chrome Web Store

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/open-bookmarks-in-new-tab/kklcekgmidaafmelbbbmmgcfgfigghmo).

### Manual (Developer Mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar — click it to configure

## Known Limitations

- **Media playback needs browser testing** — A 204 can preserve the source document but may still trigger page lifecycle handlers such as `beforeunload`. Spotify continuity is not established by the automated tests. **Workaround:** pause the extension in its popup first, then use Cmd/Ctrl-click or middle-click.
- **Missing favicons for Gmail and Outlook bookmarks** — Bookmarks pointing to Gmail (`mail.google.com`) and Outlook (`outlook.live.com`, `outlook.office.com`, etc.) are wrapped through a redirect page proxy because Chrome strips the `newtab@` prefix from these high-security domains. As a result, the bookmark's favicon/thumbnail will show the redirect page's icon instead of the original site's icon.
- **Internal URLs** (`chrome://`, `edge://`, `about:`) cannot carry the `newtab@` prefix — these bookmarks retain their default click behavior. You can still Ctrl+Click or middle-click them to open in a new tab.
- **Bookmark URLs are modified** — The `newtab@` prefix is visible in bookmark properties. Pause in the popup to restore URLs before disabling or uninstalling; Chrome does not provide a pre-uninstall cleanup event.
- **Compatibility is experimental** — Cold worker starts, native bookmark clicks, folder opens, incognito, and Chrome 153 behavior need real-browser validation. If the visible `cancel.html` warning appears, the worker did not supply the 204; pause and report it.

## Development Checks

No build or package installation is needed. With Node.js 18 or newer:

```sh
node --test tests/*.test.cjs
node --check js/background.js
node --check js/popup.js
git diff --check
```

The Node tests mock Chrome APIs and exercise response headers, tab handoffs,
settings, and bookmark restoration. They do not simulate Chrome's download UI.

## Permissions

| Permission              | Reason                                                    |
|-------------------------|-----------------------------------------------------------|
| `bookmarks`             | Read and rewrite bookmark URLs with the `newtab@` prefix  |
| `tabs`                  | Open/reuse tabs and read the exact source tab for placement |
| `storage`               | Persist user settings across sessions                     |
| `declarativeNetRequest` | Redirect marked navigations to the local 204 endpoint     |
| `webNavigation`         | Detect and correlate marked navigations                  |
| `<all_urls>` (host)     | Required for declarativeNetRequest redirects             |

## License

MIT
