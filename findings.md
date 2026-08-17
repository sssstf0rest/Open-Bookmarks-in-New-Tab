# Chrome 151 Patch Findings

## Confirmed Baseline Defects
- `main` and `aug-bug-fix` have identical runtime blobs; the latter is the implementation branch.
- `onBeforeNavigate` and `downloads.onCreated` both open destinations.
- `DownloadItem` has no `tabId`; current deduplication cannot succeed.
- Concurrent folder downloads lose source identity, overwrite one active blank tab, and can trigger explicit tab removal.
- Gmail domain exceptions are incomplete and userinfo marking is brittle for Gmail/LAN URLs.
- Every click intentionally creates a 22-byte `empty.zip`; cancellation occurs after download creation.
- `setUiOptions()` silently fails because `downloads.ui` is undeclared and would be profile-global even if added.

## Verification Target
- Chrome 151.0.7922.138 on Apple Silicon, plus disposable current Chrome available locally.

## Prior Patch Review
- The rejected branch already combined a runtime-ID query marker, dynamic DNR rule, `cancel.html`, and a service-worker-generated typed 204.
- Its design is useful as a reference, but it must not be copied wholesale: the user observed a real failure and the browser probe must validate unpacked/packaged and cold-worker behavior first.
- The current patch will keep the URL utility API small and separately tested so cancellation/state logic can be changed without reworking migration.

## Architecture Adjustments for This Attempt
- Bookmark navigations must not enter the global settings/migration operation queue; folder clicks need concurrent per-source handling after initialization.
- The prior patch returned when `tabs.get(sourceTabId)` failed. This attempt must cache `tabs.onCreated` metadata briefly and create one dedicated replacement if a canceled initial tab disappears.
- Reuse is allowed only for the exact source tab with a blank committed URL; `pendingUrl` must be considered so concurrent handlers never converge on the active tab.
- Deduplication should use source tab plus marked URL/time, while bookmark/state transitions remain separately serialized.
- No generic `goBack()`, `tabs.remove()`, or current-active-tab fallback is allowed in navigation recovery.

## Final Architecture Findings
- A locally served, HTML-typed HTTP 204 preserves the source document and
  creates no download in Chrome 151, including after a true service-worker
  cold start. Chrome still dispatches `beforeunload`; Spotify behavior cannot
  be guaranteed, so Ctrl/Command-click remains documented.
- A public extension-ID marker is forgeable. Current markers therefore use a
  synchronized random 128-bit owner, an `m`/`p` provenance flag, and a unique
  random 256-bit nonce. Exact bookmark proof gates every new-tab action.
- `m` proves a released legacy prefix may be removed; `p` preserves legitimate
  raw bytes such as a Basic Auth username equal to `newtab`.
- Broad legacy interception is active only during journaled schema migration.
  Owner-specific current rules and an owner-specific exact-wrapper URL filter
  safely handle bookmarks rewrapped by a still-running 2.3 device.
- Chrome 151 rejects otherwise valid DNR regexes when their compiled RE2
  program exceeds 2 KB. Native-browser validation caught this; the shipped
  current-marker regex is deliberately low-memory.
