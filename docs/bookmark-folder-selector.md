# Native Bookmark Folder Selector Investigation

## Assessment

The 2026-10-12 feedback describes “Choose another folder” doing nothing after
using the extension, with temporary recovery after restarting Chrome. The source
contains a URL-rewriting race that can prevent this folder editor from opening
and discard native save-bubble edits. This supports repairing the extension; it
does not establish the feedback's proposed UI-thread deadlock or explain every
reported instance of a persistent freeze.

The extension has no content scripts and does not access a native folder-selector
DOM element. It changes bookmark URLs through `chrome.bookmarks`. The Incognito
comparison is useful feedback, but differs in browser context and extension
configuration; it is not a controlled enabled/paused comparison by itself.

## Original Behavior and Chromium Evidence

Before this repair, a new bookmark was rewritten five seconds after creation.
Changes received during that interval restarted the timer, but time passing was
the only proof of completion. Existing URL edits were rewritten immediately,
startup immediately drained pending IDs, and enable/install migration bypassed
the new-bookmark timer.

Chromium revision `10ea04ff21714a3d35ec61364847890aacccde4e` supplies the mechanism:

- [Folder combo construction](https://github.com/chromium/chromium/blob/10ea04ff21714a3d35ec61364847890aacccde4e/chrome/browser/ui/bookmarks/recently_used_folders_combo_model.cc#L90)
  places “Choose another folder” last. Its bookmark-change observer does not
  repair the save bubble's bookmark association (lines 225–226).
- [The native bubble delegate](https://github.com/chromium/chromium/blob/10ea04ff21714a3d35ec61364847890aacccde4e/chrome/browser/ui/views/bookmarks/bookmark_bubble_view.cc#L345)
  handles that final option by calling `ShowEditor()`. This method retrieves the
  node using the original page URL and opens the tree editor only if lookup
  succeeds. `ApplyEdits()` likewise returns without saving title/folder changes
  when that lookup fails (lines 345–403).
- [Bookmark URL mutation](https://github.com/chromium/chromium/blob/10ea04ff21714a3d35ec61364847890aacccde4e/components/bookmarks/browser/bookmark_model.cc#L754)
  replaces the node's URL-index entry. The lookup searches nodes for the supplied
  URL and returns null when none remain (lines 940–956).

Consequently, changing `https://example.test/page` to its marked/wrapped form
while the bubble still holds the clean URL removes its lookup target. The user
can leave the bubble open indefinitely without producing bookmark-change events:
Chrome applies its pending edits when committing/closing the dialog.

The public [bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks)
offers creation, change, movement, removal, and import events, with no native
save-bubble visibility/closure event. Increasing the delay cannot guarantee that
rewriting happens after editing.

## Repair and Tradeoff

All enabled URL rewrites use the shared pending queue. Before writing, the worker
checks selected tabs in every window, considering committed and pending URLs as
well as fully unprefixed equivalents. A matching page postpones the write;
failure to read tab state also postpones it. Creation, URL edits, bulk migration,
and session recovery follow the same rule.

This is a conservative proxy for native editing. Chromium [closes the save
bubble when its tab deactivates or detaches](https://github.com/chromium/chromium/blob/10ea04ff21714a3d35ec61364847890aacccde4e/chrome/browser/ui/views/bookmarks/bookmark_bubble_view.cc#L420).
Tab activation, URL updates, and removal retry pending work after a fresh
five-second settling interval. Structured session records survive worker sleep;
legacy pending-ID lists are also accepted. There is no polling while a selected
page prevents marking.

[Chrome clears session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas)
when the browser restarts or the extension is disabled, reloaded, or updated.
Once per fresh extension session, a guarded tree scan rediscovers
clean bookmarks whose pending records were cleared. The session-ready flag is
saved only after the entire tree has been queued; normal worker wakeups recover
the saved queue without repeating that scan.

A newly saved bookmark can remain clean after the user closes the bubble if the
page stays selected. Its normal-click behavior becomes the extension's new-tab
behavior only after the page is no longer selected in any window and marking
completes. This deliberately favors preserving native edits over prompt marking.

## Evidence Limits and Verification

This assessment comes from repository code and current upstream Chromium source.
The user's exact Chrome build is unknown, and the native persistent freeze has
not yet been independently reproduced. A missing native lookup is an identifiable
failure path; it is not proof that background JavaScript deadlocks Chrome's UI.

A disposable Chrome 154.0.8037.98 instance was launched for native testing, but
the available UI tool selected the existing personal Chrome instance and could
not safely target the separate test process. No native bookmark actions were
performed, so this attempt provides no native-dialog verification.

Automated regressions verify queue timing, selected-page protection, recovery,
and migration behavior against the actual worker with mocked Chrome APIs. Native
folder opening, rendering, and worker suspension require the disposable-profile
tests in [Testing](testing.md). Keep directly observed browser results distinct
from user reports and mocked regression results.
