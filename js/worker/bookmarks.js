// ─── Bookmark Rewriting ──────────────────────────────────────────────────────

/**
 * Recursively walks the entire bookmark tree and applies a transform function
 * to every bookmark node that has a URL (i.e. not a folder).
 *
 * @param {function(string): string} transformFn  URL → URL transform.
 */
async function walkAndTransformBookmarks(transformFn) {
  const tree = await chrome.bookmarks.getTree();
  await walkNodes(tree, transformFn);
}

/**
 * Recursively processes bookmark tree nodes.
 *
 * @param {Array} nodes       Array of BookmarkTreeNode objects.
 * @param {function} transformFn  URL → URL transform.
 */
async function walkNodes(nodes, transformFn) {
  for (const node of nodes) {
    // If the node has children, recurse into them (it's a folder)
    if (node.children) {
      await walkNodes(node.children, transformFn);
    }

    // If the node has a URL, apply the transform
    if (node.url) {
      const newUrl = transformFn(node.url);
      if (newUrl !== node.url) {
        try {
          await chrome.bookmarks.update(node.id, { url: newUrl });
        } catch (err) {
          // Some bookmarks may be read-only (e.g. managed by policy)
          console.warn(
            "[Bookmarks→NewTab] Could not update bookmark:",
            node.title,
            err
          );
        }
      }
    }
  }
}

/**
 * Marks ALL bookmarks with the CURRENT scheme.
 * Called when the extension is installed, updated, or enabled.
 *
 * Uses migrateUrl rather than addPrefix so an already-marked bookmark is
 * re-marked under today's CREDENTIAL_STRIPPED_DOMAINS instead of being skipped.
 * walkNodes only writes when the URL actually changes, so this costs no extra
 * bookmark writes on a run where nothing needs migrating.
 */
async function prefixAllBookmarks() {
  console.log("[Bookmarks→NewTab] Marking all bookmarks with current scheme…");
  await walkAndTransformBookmarks(migrateUrl);
  console.log("[Bookmarks→NewTab] All bookmarks marked.");
}

/**
 * Removes the newtab@ prefix from ALL bookmarks.
 * Called when the user pauses the extension in its popup.
 */
async function unprefixAllBookmarks() {
  console.log("[Bookmarks→NewTab] Removing prefix from all bookmarks…");
  // fullyUnprefix, not removePrefix: a bookmark an older build double-marked
  // would otherwise be left half-marked and still broken after pausing.
  await walkAndTransformBookmarks(fullyUnprefix);
  console.log("[Bookmarks→NewTab] Prefix removed from all bookmarks.");
}

// ─── Bookmark Change Listeners ───────────────────────────────────────────────
// When the user creates or edits a bookmark while the extension is enabled,
// we need to add the prefix to the new URL automatically.

/**
 * When a new bookmark is created, add the prefix if the extension is enabled.
 */
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  await settingsReady; // never mark a bookmark based on a guessed enabled state
  if (!settings.enabled) return;
  if (!bookmark.url) return; // It's a folder

  // Deliberately NOT marked here — see scheduleBookmarkMark.
  scheduleBookmarkMark(id);
});

/**
 * When a bookmark URL is changed, ensure the prefix is present if enabled.
 * This handles the case where the user edits a bookmark URL manually.
 */
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  // Still settling? Then the user is actively editing this bookmark — most
  // likely renaming it in the save bubble, which fires onChanged when it
  // commits. Push the marking further out and let them finish. Checked before
  // the await so a burst of edits cannot slip past while settings load.
  if (pendingBookmarkMarks.has(id)) {
    scheduleBookmarkMark(id);
    return;
  }

  await settingsReady; // never mark a bookmark based on a guessed enabled state
  if (!settings.enabled) return;
  if (!changeInfo.url) return;

  // Avoid infinite loop: only update if the prefix is missing
  if (!hasPrefix(changeInfo.url) && canPrefixUrl(changeInfo.url)) {
    const prefixed = addPrefix(changeInfo.url);
    try {
      await chrome.bookmarks.update(id, { url: prefixed });
    } catch (err) {
      console.warn("[Bookmarks→NewTab] Could not re-prefix bookmark:", err);
    }
  }
});

// ─── Deferred Marking of New Bookmarks ───────────────────────────────────────
// Chrome's "Bookmark added" bubble (Ctrl/Cmd+D) does not hold a pointer to the
// bookmark it created. When it commits, it looks the node up BY THE PAGE'S URL
// (GetMostRecentlyAddedUserNodeForURL). Marking the bookmark immediately on
// creation changes that URL to https://newtab@… , so the bubble's lookup finds
// nothing and the rename the user typed is silently discarded — the bookmark
// keeps its original title. Renaming later via right-click → Edit works,
// because that dialog edits the node by id.
//
// So: leave a new bookmark completely alone until it stops changing, then mark
// it. The cost is that a brand-new bookmark opens in the current tab for a few
// seconds. That is nearly free in practice — you have just bookmarked the page
// you are already looking at — and it is much better than losing the rename.

/**
 * How long a newly created bookmark must go unchanged before we mark it.
 * Any edit restarts the clock, so a slow rename keeps pushing it out.
 * Tune here if the bubble is being cut off.
 */
const NEW_BOOKMARK_SETTLE_MS = 5000;

/** Bookmark id → pending timeout handle. */
const pendingBookmarkMarks = new Map();

/** storage.session key mirroring pendingBookmarkMarks' ids. */
const PENDING_MARKS_KEY = "pendingBookmarkMarks";

/**
 * Mirrors the pending ids into session storage.
 *
 * setTimeout does not survive service-worker termination, and a bookmark that
 * silently never gets marked is a worse bug than the one this fixes. init()
 * drains whatever is left here on the next worker start.
 */
function persistPendingMarks() {
  return chrome.storage.session
    .set({ [PENDING_MARKS_KEY]: [...pendingBookmarkMarks.keys()] })
    .catch(() => {
      // Session storage unavailable — the in-memory timer still covers the
      // normal case.
    });
}

/**
 * (Re)starts the settle timer for a bookmark. Called on creation and again on
 * every change while it is still pending.
 *
 * @param {string} id  Bookmark id.
 */
function scheduleBookmarkMark(id) {
  const existing = pendingBookmarkMarks.get(id);
  if (existing !== undefined) clearTimeout(existing);

  pendingBookmarkMarks.set(
    id,
    setTimeout(() => markBookmarkNow(id), NEW_BOOKMARK_SETTLE_MS)
  );
  persistPendingMarks();
}

/**
 * Applies the current marking scheme to a bookmark that has finished settling.
 *
 * Re-reads the bookmark rather than trusting the URL captured at creation: the
 * user may have edited the URL during the settle window, and the whole point of
 * waiting is that the node can still change.
 *
 * @param {string} id  Bookmark id.
 */
async function markBookmarkNow(id) {
  const existing = pendingBookmarkMarks.get(id);
  if (existing !== undefined) clearTimeout(existing);
  // Clear BEFORE writing: our own update fires onChanged, and that must fall
  // through to the normal path instead of rescheduling this forever.
  pendingBookmarkMarks.delete(id);
  persistPendingMarks();

  await settingsReady;
  if (!settings.enabled) return;

  try {
    const [node] = await chrome.bookmarks.get(id);
    if (!node || !node.url) return;

    const marked = migrateUrl(node.url);
    if (marked !== node.url) {
      await chrome.bookmarks.update(id, { url: marked });
    }
  } catch (err) {
    // Removed during the settle window, or read-only (policy-managed).
    console.warn("[Bookmarks→NewTab] Could not mark new bookmark:", err);
  }
}

/**
 * Marks any bookmark whose settle timer was lost to a worker restart.
 * Called from init().
 */
async function drainPendingBookmarkMarks() {
  let ids;
  try {
    const stored = await chrome.storage.session.get(PENDING_MARKS_KEY);
    ids = stored?.[PENDING_MARKS_KEY];
  } catch (err) {
    return;
  }
  if (!Array.isArray(ids) || ids.length === 0) return;

  console.log(
    `[Bookmarks→NewTab] Marking ${ids.length} bookmark(s) left pending by a worker restart.`
  );
  for (const id of ids) {
    await markBookmarkNow(id);
  }
}
