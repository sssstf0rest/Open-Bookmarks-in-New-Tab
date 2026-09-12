# Repository Guidelines

## Project Structure & Module Organization

This dependency-free Chrome Manifest V3 extension loads directly from the
repository root. `js/background.js` registers the local HTML-typed HTTP 204
handler, then synchronously loads `js/worker/` scripts for configuration,
settings, URL helpers, bookmarks, navigation, and lifecycle.

`popup.html`, `js/popup.js`, and `css/popup.css` implement the bilingual UI;
icons live in `icons/`. `manifest.json`, `rules.json`, and `cancel.html`
define extension resources. `tests/` contains regression tests; `scripts/`
contains build/check tooling. Keep the hosted redirect and privacy policy
at their existing `docs/` paths.

## Build, Test, and Development Commands

Use Node.js 18 or newer. No package installation is required.

```sh
npm run check
npm test
npm run build
git diff --check
```

`check` validates JavaScript syntax, JSON, permissions, and packaged references.
`test` runs Node's built-in test runner. `build` recreates `dist/extension`
with only allowlisted runtime assets; it does not produce a release ZIP.
Update `scripts/project.mjs` when adding runtime files.

Load the source directory unpacked in a disposable Chrome profile. Reload after
edits; keep the same directory to preserve the installation identity. Never edit
generated `dist/` or `_metadata/` files.

## Coding Style & Naming Conventions

Use two-space indentation, double-quoted JavaScript strings, and semicolons.
Use `camelCase` for functions/variables and `UPPER_SNAKE_CASE` for constants.
Worker scripts share a classic-worker global scope: preserve explicit load order
and avoid duplicate bindings. Preserve CSS naming and add popup translations
to both language maps. No formatter or linter is configured.

## Testing Guidelines

Name tests `tests/*.test.cjs`; no coverage threshold is enforced. Test actual
worker code and synchronous imports using mocked Chrome APIs. Packaging tests
verify exact file contents and exclude development artifacts.
Mocks cannot establish native browser behavior: follow `docs/testing.md` for
download UI, cold starts, folder opens, LAN/Gmail, and media playback.
Distinguish user-reported validation from directly observed results.

## Commit & Pull Request Guidelines

History uses short descriptive subjects; Conventional Commits are optional.
Keep commits focused. PRs should explain changed behavior, linked issues,
verification, and remaining browser risks. Include screenshots for UI changes.
Do not commit generated packages or bump versions without release scope.

## Safety

Preserve the 204 MIME type, synchronous registration, existing bookmark migration,
and hosted helper URL. Pause before uninstalling to restore bookmarks.
Use the three root planning files for complex work; keep them concise.
