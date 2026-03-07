# Open Bookmarks in New Tab

A Chrome extension that automatically opens bookmarks in a **new tab** instead of replacing your current page.

## Background

This project is inspired by the [Open Bookmarks in a New Tab](https://chromewebstore.google.com/detail/open-bookmarks-in-a-new-t/mcecogccjlcplcccpnejnldpijppkfil) extension. It adopts the same core technique (the `newtab@` URL prefix trick) while addressing two issues found in the original:

1. **No external redirects** — The original extension redirects bookmark requests through `bookmarks-evz.pages.dev`. This extension keeps everything local by redirecting to a bundled `empty.zip` file within the extension itself. Your bookmark traffic never touches a third-party server.

2. **Smart empty-tab handling** — When the current tab is empty (Chrome's new tab page, `about:blank`, etc.), the bookmark opens **in that tab** instead of creating an unnecessary second tab.

## How It Works

The extension uses the **"newtab@ prefix" trick** (explained in detail in [this article](https://dev.to/vitalets/open-bookmarks-in-a-new-tab-by-default-easier-said-than-done-a3n) by Vitaliy Potapov):

1. **Bookmark rewriting** — On install/enable, every bookmark URL is rewritten from `https://example.com` to `https://newtab@example.com`. The `newtab@` part uses the URL userinfo field ([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.1)), which browsers and servers ignore — favicons and titles are preserved.

2. **Redirect rule** — A `declarativeNetRequest` rule intercepts any main-frame request containing `newtab@` and redirects it to a dummy `empty.zip` file bundled with the extension. This triggers a download instead of a page navigation, so **the current tab is never touched**.

3. **Download interception** — The `downloads` API catches the dummy download the instant it starts, cancels it (no file saved, no download bar), extracts the original URL, and opens it in a new tab. If the current tab is an empty/new-tab page, the bookmark loads there instead.

4. **Fallback handler** — On browsers where the redirect rule doesn't fire (e.g. some Edge configurations), a `webNavigation` listener catches the `newtab@` URL and handles it gracefully using `window.stop()` + `history.back()` to minimise disruption to the original page.

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

- **Media playback interruption** — On some pages with active media (e.g. Spotify Web Player), opening a bookmark may briefly interrupt playback. This occurs when the browser's redirect rule doesn't fire fast enough and the fallback handler has to restore the page via `history.back()`. Most pages recover from bfcache, but some single-page apps may reload.
- **Internal URLs** (`chrome://`, `edge://`, `about:`) cannot carry the `newtab@` prefix — these bookmarks retain their default click behavior. You can still Ctrl+Click or middle-click them to open in a new tab.
- **Bookmark URLs are modified** — The `newtab@` prefix is visible if you inspect bookmark properties. Disabling the extension restores all URLs to their original form.
- **Service worker keep-alive** — A 30-second alarm keeps the service worker alive so the download listener is always ready. This is a Chrome Manifest V3 limitation.

## Permissions

| Permission              | Reason                                                    |
|-------------------------|-----------------------------------------------------------|
| `bookmarks`             | Read and rewrite bookmark URLs with the `newtab@` prefix  |
| `tabs`                  | Open new tabs, query active tab for placement             |
| `storage`               | Persist user settings across sessions                     |
| `downloads`             | Intercept and cancel the dummy `empty.zip` download       |
| `declarativeNetRequest` | Redirect `newtab@` URLs to `empty.zip`                    |
| `alarms`                | Keep-alive timer for the service worker                   |
| `webNavigation`         | Fallback handler when the redirect rule doesn't fire      |
| `scripting`             | Inject `window.stop()` + `history.back()` for restoration |
| `<all_urls>` (host)     | Required by declarativeNetRequest and scripting APIs      |

## License

MIT
