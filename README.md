# Open Bookmarks in New Tab

A lightweight Chrome extension that opens HTTP(S) bookmarks in a new tab,
with configurable focus and placement and automatic reuse of blank tabs.

The current implementation stops marked navigations with a **local HTTP 204
response**, not a dummy download. The user has confirmed this resolves their
reported macOS download popup. Broader platform/media checks remain documented
in [Testing](docs/testing.md); this branch is not a published store update.

## Use

Load this repository through **chrome://extensions → Developer mode → Load
unpacked**, or install the published version from the
[Chrome Web Store](https://chromewebstore.google.com/detail/open-bookmarks-in-new-tab/kklcekgmidaafmelbbbmmgcfgfigghmo).
The published version may differ from this branch.

Keep using the same unpacked directory when reloading an existing installation.
For a separate test installation, use an unsigned-in disposable Chrome profile
without the store extension. Never run two copies against the same bookmarks.

The popup supports English/Chinese, pause/resume, focus control, and placement
at the end of the tab strip or immediately to the right.

**Pause in the popup before disabling or uninstalling.** This restores bookmark
URLs. Chrome does not provide a pre-uninstall cleanup event.

## Development

Node.js 18+ is needed for development commands. No dependencies or installation
step are required; the extension itself uses only browser APIs.

```sh
npm run check   # Validate syntax, manifest/rules and runtime resource references
npm test        # Run worker and packaging regression tests
npm run build   # Recreate dist/extension with runtime files only
```

Load `dist/extension` for an isolated packaged-build test. The build recreates
that generated folder: do not edit files there. It does not create a ZIP,
publish a release, or modify the source manifest version.

## Repository Layout

- `manifest.json`, `rules.json`, `cancel.html`: extension configuration and cancellation endpoint.
- `js/background.js`: synchronous 204 handler and worker entry point.
- `js/worker/`: configuration, settings, URL handling, bookmarks, navigation, lifecycle.
- `popup.html`, `js/popup.js`, `css/popup.css`, `icons/`: popup UI and assets.
- `tests/`, `scripts/`: dependency-free verification and build tooling.
- `docs/`: architecture, testing, hosted redirect and privacy policy.

See [Architecture](docs/architecture.md) and [Repository Guidelines](AGENTS.md).
Generated Chrome metadata and build output are ignored. Historical release
archives and investigation logs are available in Git history.

## Compatibility and Permissions

Bookmarks retain the existing `newtab@` marker. Gmail/Outlook and other configured
domains still use the hosted redirect wrapper; removing that helper would break
existing bookmarks. Non-HTTP(S) bookmarks retain native browser behavior.
New bookmarks are marked after a short editing delay to preserve save-dialog renaming.

A 204 avoids replacing the source document but may still trigger page lifecycle
handlers. Spotify continuity and incognito compatibility require separate tests.
If problems occur, pause the extension and use Cmd/Ctrl-click.

Permissions are limited to `bookmarks`, `tabs`, `storage`,
`declarativeNetRequest`, `webNavigation`, and `<all_urls>` host access.
There is no downloads permission, global download-UI suppression, or keep-alive
alarm. Settings use Chrome sync storage; see the [privacy policy](docs/privacy-policy.html).

## Background

Inspired by [Open Bookmarks in a New Tab](https://chromewebstore.google.com/detail/open-bookmarks-in-a-new-t/mcecogccjlcplcccpnejnldpijppkfil)
and Vitaliy Potapov's [description of the bookmark-prefix technique](https://dev.to/vitalets/open-bookmarks-in-a-new-tab-by-default-easier-said-than-done-a3n).

## License

MIT
