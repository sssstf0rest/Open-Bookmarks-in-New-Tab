# Architecture

## Runtime Boundary

The repository root remains an unpacked extension so existing local installations
keep their directory and identity. The optional build copies 17 explicitly listed
runtime files into `dist/extension`; tests, documentation, planning notes, tooling,
old archives, and Chrome-generated metadata are excluded.

There is no transpilation or runtime dependency. The classic service worker uses
synchronous `importScripts` with an explicit order. Do not convert those imports
to deferred/asynchronous loading: Chrome event listeners must be registered
during worker evaluation.

| File | Responsibility |
| --- | --- |
| `js/background.js` | Register exact local cancellation endpoint first; import worker scripts |
| `js/worker/config.js` | Bookmark marker, special-domain wrapper, defaults and ruleset ID |
| `js/worker/settings.js` | Settings state, initialization gate, Chrome sync storage |
| `js/worker/urls.js` | Mark/unmark/migrate URLs and identify reusable blank tabs |
| `js/worker/bookmarks.js` | Tree rewrites, edit listeners, delayed marking and pending recovery |
| `js/worker/navigation.js` | Tab-specific handoffs, destination opening and compatibility fallback |
| `js/worker/lifecycle.js` | Enable/pause, popup messaging, settings sync and startup reconciliation |

The worker scripts share one global scope. Cross-file functions and constants
are intentional; tests load the same scripts in the same order.

## Bookmark Navigation

1. Enable/install marks HTTP(S) bookmarks with `newtab@`. Existing special-domain
   wrappers and legacy marker migration are preserved.
2. `onBeforeNavigate` records the exact source tab before awaiting stored settings.
3. Static DNR redirects the marked main-frame request to local `cancel.html`.
4. The worker answers with a bodyless `204`, HTML content type and `no-store`.
   The endpoint does not open tabs or touch Chrome downloads.
5. The navigation handler opens the clean destination once, or reuses a blank/native
   newly created tab. Abort, later-navigation, and tab-removal events retire handoffs.

The packaged `cancel.html` is a diagnostic fallback: it should not render during
successful interception. If DNR is bypassed, the committed-navigation fallback
can attempt history restoration but never closes an existing source tab on failure.
This is not a guarantee against page lifecycle or media interruptions.

## Compatibility Contracts

- Keep `Content-Type: text/html; charset=utf-8` on the 204. Do not reintroduce a
  dummy download or rely on hiding download UI.
- Keep `docs/redirect.html` at its published URL: existing Gmail/Outlook bookmarks
  can reference it. Changing local HTML does not deploy GitHub Pages.
- Keep the bookmark editing delay and session-backed pending IDs; immediate
  rewriting can break renaming in Chrome's save dialog.
- Keep pause-time restoration. Disabling/uninstalling through Chrome does not
  provide a chance to restore bookmarks.
- Settings use `storage.sync`; pending bookmark work uses `storage.session`.

See [Testing](testing.md) for browser acceptance criteria and validation limits.
