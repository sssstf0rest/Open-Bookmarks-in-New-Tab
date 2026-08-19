# Open Bookmarks in New Tab

A dependency-free Chrome Manifest V3 extension that opens bookmark-bar and
bookmark-menu clicks in a new tab instead of replacing the current page.

## How It Works

1. **Reversible marker** — Enabled HTTP(S) bookmarks receive a final query
   marker containing a synchronized random installation-scoped 128-bit owner,
   a provenance flag, and a different 256-bit nonce for every bookmark. The
   original URL is preserved byte-for-byte.
2. **Local cancellation** — A dynamic `declarativeNetRequest` rule redirects
   only marked top-level navigations to the bundled `cancel.html` resource.
3. **No-content response** — The service worker serves that resource as an
   HTML-typed HTTP 204. Chrome keeps the source document loaded and starts no
   download.
4. **One destination owner** — `webNavigation.onBeforeNavigate` verifies the
   marked bookmark, removes its marker, and opens the clean destination once.
   Empty/new-tab pages are reused by exact tab ID.
5. **Restoration** — Pausing restores current-format bookmark URLs before the
   interception rule is disabled.

Version 2.4 migrates released `newtab@` bookmarks, unwraps the former
Gmail/Outlook GitHub Pages proxy, repairs repeated prefixes, and keeps a
size-limited local migration backup. The extension removes that backup on the first
extension startup at least 30 days after it was created.

Version 2.5 repairs bookmarks that earlier migrations left in a 2.3 shape,
never navigates a loaded source tab when a marked click cannot be matched to a
bookmark, reuses the tab Chrome itself opens for a Ctrl/⌘ or middle click, and
keeps the service worker resident so a click is not waiting on it to start.

## Features

- No `empty.zip`, download prompt, download bubble, or download-manager API
- Concurrent folder “Open all” handling with per-source tab recovery
- Gmail, Outlook, LAN IPv4/IPv6, ports, fragments, and Basic Auth support
- Same-window placement at the end or immediately right of the source
- Optional destination focus and automatic empty-tab reuse
- Transactional enable/disable and serialized bookmark maintenance
- English and Simplified Chinese popup

## Installation

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/open-bookmarks-in-new-tab/kklcekgmidaafmelbbbmmgcfgfigghmo),
or open `chrome://extensions/`, enable **Developer mode**, choose **Load
unpacked**, and select this repository. Chrome 151 or newer is required.

## Development and Validation

There is no build or dependency-install step.

```sh
node --check js/background.js
node --check js/url-utils.js
node --check js/popup.js
node tests/url-utils.test.js
node tests/background.test.js
python3 -m json.tool manifest.json >/dev/null
```

Reload the extension card after edits and inspect its service worker for
errors. Use a disposable Chrome profile because enabling the extension rewrites
HTTP(S) bookmarks.

## Known Limitations

- **Spotify and `beforeunload`:** Chrome fires a page's `beforeunload` handlers
  before the local 204 cancellation completes. The source document remains
  loaded, but Spotify may stop playback in that handler. Ctrl/⌘+Click or
  middle-click avoids same-tab navigation and is the reliable workaround.
- **Direct disable/uninstall:** Chrome gives an extension no cleanup event for
  a direct disable or uninstall. Pause from the popup first so bookmarks are
  restored. Re-enabling/reinstalling the same Web Store extension can recover
  current-format markers.
- **Internal URLs:** `chrome://`, `edge://`, `about:`, `file:`, data URLs, and
  JavaScript bookmarks are not modified.
- **Incognito:** Version 2.4 does not run in incognito windows. Pause from the
  popup before opening bookmarks there; otherwise Chrome treats the visible
  marker as an ordinary query parameter and may send it to the destination.
- **Visible marker:** While enabled, bookmark properties show the
  `__obnt_v4` query marker. It contains random ownership values, not browsing
  data, and is removed before the destination request.
- **Bookmark favicons:** Chrome stores a favicon against the exact page URL
  that committed. A marked bookmark URL never commits — cancelling it is what
  keeps the source page loaded — so Chrome has no icon recorded for it and the
  bookmarks bar falls back to a generic one. Pausing restores the original
  URLs and their icons. A bookmark that still shows its icon while the
  extension is enabled is one that is not being intercepted.
- **Legacy `newtab` username:** During a 2.3-or-earlier upgrade, a passwordless
  username exactly equal to `newtab` is indistinguishable from the released
  marker. Candidates are backed up locally before migration.
- **Mixed-version Chrome Sync:** Upgrade or pause 2.3 on every synchronized
  profile. Exact legacy Gmail/Outlook wrappers remain recoverable, but a new
  ordinary `newtab@` URL arriving after migration is preserved as possible
  Basic Auth data rather than guessed to be an extension marker.

## Permissions

| Permission | Purpose |
|---|---|
| `alarms` | Keep the worker resident while enabled so a click is not delayed by starting it |
| `bookmarks` | Add/remove reversible markers and migrate released formats |
| `tabs` | Open, focus, position, and recover the exact destination tab |
| `storage` | Sync preferences and the random marker owner; keep transition state and migration backups locally |
| `declarativeNetRequest` | Redirect only marked top-level requests to the local 204 resource |
| `webNavigation` | Detect the marked navigation and open its clean destination |
| HTTP(S) hosts | Let DNR and `webNavigation` match marked bookmarks on any web host |

The extension contains no analytics, remote code, or requests to a
developer-operated service. Clean destinations are requested normally. See the
[privacy policy](docs/privacy-policy.html) for details.

## License

[MIT](LICENSE)
