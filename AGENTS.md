# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free Chrome Manifest V3 extension. `js/background.js`
handles bookmark rewriting, navigation, downloads, and settings.
`popup.html`, `js/popup.js`, and `css/popup.css` implement the bilingual popup.
`manifest.json` declares permissions and resources; `rules.json` redirects
marked navigations to `empty.zip`. Icons live in `icons/`; `docs/` contains
the GitHub Pages redirect and privacy policy. Release ZIPs are distribution
artifacts, not editable source. Never hand-edit Chrome-generated
`_metadata/generated_indexed_rulesets/`.

## Build, Test, and Development Commands

There is no build step, package installation, or configured test runner.
Run these checks from the repository root:

```sh
node --check js/background.js
node --check js/popup.js
python3 -m json.tool manifest.json >/dev/null
python3 -m json.tool rules.json >/dev/null
git diff --check
```

These validate JavaScript syntax, JSON, and whitespace. For local development,
open `chrome://extensions`, enable Developer mode, and select **Load unpacked**
with this directory. Reload the extension after edits and inspect its service
worker console. Toggle off/on in the popup when testing full bookmark rewrites.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, double-quoted JavaScript strings,
and semicolons. Use `camelCase` for functions and variables and `UPPER_SNAKE_CASE`
for constants. Keep CSS custom properties and existing BEM-style classes
such as `toggle-row__hint`. Add popup strings to both `I18N.en` and `I18N.zh`
and connect them through `data-i18n`. No formatter or linter is configured.

## Testing Guidelines

No automated test framework, test naming convention, or coverage threshold is
currently established. Use a disposable Chrome profile with test bookmarks.
Verify single clicks, folder “Open all,” blank-tab reuse, focus and placement,
Gmail/Outlook, LAN URLs, bookmark renaming, and pause/resume restoration.
Check source-tab history, Spotify playback, and `chrome://downloads` for
regressions. Record browser version, OS, reproduction steps, and results.

## Commit & Pull Request Guidelines

History uses short descriptive subjects such as `fix saving name` and
`update manifest version`; Conventional Commits are not required. Keep commits
focused. PRs should explain the problem, changed behavior, validation, and
linked issues; include screenshots for popup changes.

## Configuration & Safety

Bookmark URLs are modified in place: back them up and pause before uninstalling.
Keep permission changes minimal and justify them. Treat planning files as
historical research; verify architecture against the current branch’s source.
