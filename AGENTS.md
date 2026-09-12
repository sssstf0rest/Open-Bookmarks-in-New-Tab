# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free Chrome Manifest V3 extension. `js/background.js`
handles bookmark rewriting, navigation, settings, and the local HTTP 204 response.
`popup.html`, `js/popup.js`, and `css/popup.css` implement the bilingual popup.
`manifest.json` declares permissions; `rules.json` redirects marked navigations
to `cancel.html`. Icons live in `icons/`, Node regression tests in `tests/`, and
the hosted redirect, privacy policy, and testing guide in `docs/`.
Release ZIPs are historical distribution artifacts, not the current prototype.
Never hand-edit `_metadata/generated_indexed_rulesets/`.

## Build, Test, and Development Commands

No build step or package installation is needed. Use Node.js 18 or newer:

```sh
node --test tests/*.test.cjs
node --check js/background.js
node --check js/popup.js
python3 -m json.tool manifest.json >/dev/null
python3 -m json.tool rules.json >/dev/null
git diff --check
```

These run mocked-worker regression tests, syntax checks, and whitespace checks.
For development, load this directory unpacked through `chrome://extensions` in
a disposable, unsigned-in profile. Reload after edits; pause/resume in the popup
when testing bookmark migration.

## Coding Style & Naming Conventions

Follow two-space indentation, double-quoted JavaScript strings, and semicolons.
Use `camelCase` for functions/variables and `UPPER_SNAKE_CASE` for constants.
Preserve existing CSS custom properties and BEM-style classes. Add popup strings
to both `I18N.en` and `I18N.zh`. No formatter or linter is configured.

## Testing Guidelines

Use Node's built-in test runner and name files `tests/*.test.cjs`. No coverage
threshold is enforced. Test the actual worker with mocked APIs and deterministic
event ordering. Add regression cases for navigation and settings changes.
Mocks do not prove Chrome behavior: follow `docs/no-download-testing.md` for
native bookmark clicks, folder opens, cold starts, LAN/Gmail, media playback,
and download UI. Record OS, browser version, and unverified cases explicitly.

## Commit & Pull Request Guidelines

History uses short descriptive subjects such as `fix saving name` and
`update manifest version`; Conventional Commits are optional. Keep commits focused.
PRs should explain changed behavior, linked issues, tests, and remaining browser
risks. Include screenshots for popup changes. Do not regenerate release archives
or bump the version until release validation is requested.

## Configuration & Safety

Bookmark URLs are modified in place: back them up and pause before uninstalling.
Preserve the HTML MIME type and synchronous fetch registration. Do not reintroduce
dummy downloads or global download-UI suppression. Treat planning files and older
architecture notes as historical; verify against current source.
