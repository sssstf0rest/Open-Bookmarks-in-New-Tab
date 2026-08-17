# Repository Guidelines

## Project Structure & Module Organization

This repository is a dependency-free Chrome Manifest V3 extension. `manifest.json` defines permissions, the service worker, popup, and declarative ruleset. Core bookmark rewriting, download interception, tab placement, and settings live in `js/background.js`; popup state and EN/ZH strings live in `js/popup.js`. The interface is split between `popup.html` and `css/popup.css`. Edit redirect behavior in `rules.json`; `_metadata/generated_indexed_rulesets/_ruleset1` is generated output. Keep icons in `icons/`, public privacy/redirect pages in `docs/`, and store collateral in `chrome-web-store-publishing-kit.zip`.

## Build, Validation, and Local Development

There is no install or build step. Validate changes with:

```sh
node --check js/background.js
node --check js/popup.js
python3 -m json.tool manifest.json >/dev/null
python3 -m json.tool rules.json >/dev/null
```

For local testing, open `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select the repository root. Refresh the extension card after edits and inspect its service worker for errors. Use a disposable Chrome profile when possible because enabling the extension rewrites HTTP(S) bookmarks.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and double-quoted JavaScript strings. Name functions and variables with `camelCase`; use `UPPER_SNAKE_CASE` for constants. Preserve JSDoc and focused comments around non-obvious navigation logic. CSS uses custom properties and BEM-style classes such as `.toggle-row__hint--off`. HTML IDs and classes use kebab-case. Keep semantic elements, ARIA attributes, and matching English/Chinese UI strings intact.

## Testing Guidelines

No automated test framework or coverage threshold exists. Run all validation commands, then manually verify that enabling prefixes HTTP(S) bookmarks, disabling restores them, empty tabs are reused, focus and position settings work, and Gmail/Outlook proxy bookmarks open correctly. Confirm internal URLs such as `chrome://` remain unchanged and no dummy download persists.

## Commit & Pull Request Guidelines

History uses short, informal subjects; prefer a precise imperative subject such as `fix duplicate bookmark tab handling` over `update`. Pull requests should summarize user-visible behavior, link relevant issues, state the Chrome version and manual checks performed, and include screenshots for popup changes. Explicitly call out permission, `rules.json`, bookmark-mutation, or privacy-policy changes.

## Security & Configuration

Keep bookmark mutations reversible and redirect matching narrowly scoped. Justify new permissions, external requests, or data flows, and update `README.md` plus `docs/privacy-policy.html` when behavior changes.
