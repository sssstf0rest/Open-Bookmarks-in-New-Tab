// ─── Bookmark Rewriting ──────────────────────────────────────────────────────

/**
 * Recursively walks the entire bookmark tree and applies a transform function
 * to every bookmark node that has a URL (i.e. not a folder).
 *
 * @param {function(string): string} transformFn  URL → URL transform.
 */
async function walkAndTransformBookmarks(transformFn, deferMarking = false) {
  const tree = await chrome.bookmarks.getTree();
  await walkNodes(tree, transformFn, deferMarking);
}

/**
 * Recursively processes bookmark tree nodes.
 *
 * @param {Array} nodes       Array of BookmarkTreeNode objects.
 * @param {function} transformFn  URL → URL transform.
 */
async function walkNodes(nodes, transformFn, deferMarking = false) {
  for (const node of nodes) {
    // If the node has children, recurse into them (it's a folder)
    if (node.children) {
      await walkNodes(node.children, transformFn, deferMarking);
    }

    // If the node has a URL, apply the transform
    if (node.url) {
      const newUrl = transformFn(node.url);
      if (newUrl !== node.url) {
        if (deferMarking) {
          if (!settings.enabled) return;
          scheduleBookmarkMark(node.id, node.url);
          continue;
        }
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
 * Called when the extension is installed, updated, enabled, or starts a fresh
 * extension session after session storage has been cleared.
 *
 * Uses migrateUrl rather than addPrefix so an already-marked bookmark is
 * re-marked under today's CREDENTIAL_STRIPPED_DOMAINS instead of being skipped.
 * Only changed URLs are queued. The same editor guard applies to migration as
 * to creation, so install/update/resume cannot cut off an open save bubble.
 */
async function prefixAllBookmarks() {
  await settingsReady;
  await pendingMarksReady;
  if (!settings.enabled) return;
  console.log("[Bookmarks→NewTab] Queuing bookmarks for the current scheme…");
  await walkAndTransformBookmarks(migrateUrl, true);
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

  await pendingMarksReady;
  if (settings.enabled) scheduleBookmarkMark(id, bookmark.url);
});

/**
 * When a bookmark URL is changed, ensure the prefix is present if enabled.
 * This handles the case where the user edits a bookmark URL manually.
 */
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  // Our marking writes emit onChanged too. Do not schedule another write.
  if (changeInfo.url && bookmarkMarkWrites.get(id) === changeInfo.url) return;

  // Invalidate a read already in flight before awaiting settings/recovery.
  if (pendingBookmarkMarks.has(id)) {
    scheduleBookmarkMark(id, changeInfo.url);
    return;
  }

  await settingsReady; // never mark a bookmark based on a guessed enabled state
  await pendingMarksReady;
  if (!settings.enabled) return;
  if (!changeInfo.url) return;

  if (!hasPrefix(changeInfo.url) && canPrefixUrl(changeInfo.url)) {
    scheduleBookmarkMark(id, changeInfo.url);
  }
});

chrome.bookmarks.onMoved.addListener((id) => {
  if (pendingBookmarkMarks.has(id)) scheduleBookmarkMark(id);
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  // This event itself can wake the worker. Do not persist an empty map over
  // saved work before init has restored the complete queue.
  await pendingMarksReady;
  function removePending(node) {
    pendingBookmarkMarks.delete(node.id);
    for (const child of node.children || []) removePending(child);
  }
  removePending(removeInfo.node);
  persistPendingMarks();
  armBookmarkMarkTimer();
});

// ─── Editor-Safe Bookmark Marking ────────────────────────────────────────────
// The native save bubble looks up its bookmark by the ORIGINAL PAGE URL when
// saving edits AND opening "Choose another folder". A quiet timer cannot tell
// whether that bubble has closed. Chrome exposes no bubble-close event, so keep
// URLs unchanged while a matching page is selected in any window. Tab activity
// retries deferred work; there is no periodic polling or worker keep-alive.
const NEW_BOOKMARK_SETTLE_MS = 5000;
const PENDING_MARKS_KEY = "pendingBookmarkMarks";
const BOOKMARK_SESSION_READY_KEY = "bookmarkSessionReady";

/** Bookmark id → { urls: Set of original URLs, readyAt: time or null }. */
const pendingBookmarkMarks = new Map();
const bookmarkMarkWrites = new Map();
let bookmarkMarkTimer;
let bookmarkMarkDeadline = Infinity;
let processingBookmarkMarks;
let pendingMarksPersistScheduled = false;
let pendingMarksPersistence = Promise.resolve();
let bookmarkSessionReady = false;

// Recover the complete saved queue before a new event can overwrite storage.
let resolvePendingMarksReady;
const pendingMarksReady = new Promise((resolve) => {
  resolvePendingMarksReady = resolve;
});

/** Coalesce bursts and serialize storage writes so old snapshots cannot win. */
function persistPendingMarks() {
  if (!pendingMarksPersistScheduled) {
    pendingMarksPersistScheduled = true;
    pendingMarksPersistence = pendingMarksPersistence.then(async () => {
      pendingMarksPersistScheduled = false;
      const records = [...pendingBookmarkMarks].map(([id, entry]) => ({
        id, urls: [...entry.urls],
      }));
      await chrome.storage.session.set({
        [PENDING_MARKS_KEY]: records,
        [BOOKMARK_SESSION_READY_KEY]: bookmarkSessionReady,
      });
    }).catch(() => {
      // In-memory work still operates if session storage is unavailable.
    });
  }
  return pendingMarksPersistence;
}

/** Adding a bookmark should not rescan the entire pending collection. */
function requestBookmarkMarkTimer(readyAt) {
  if (readyAt >= bookmarkMarkDeadline) return;
  if (bookmarkMarkTimer !== undefined) clearTimeout(bookmarkMarkTimer);
  bookmarkMarkDeadline = readyAt;
  bookmarkMarkTimer = setTimeout(() => {
    bookmarkMarkTimer = undefined;
    bookmarkMarkDeadline = Infinity;
    processPendingBookmarkMarks();
  }, Math.max(0, readyAt - Date.now()));
}

/** One timer for the batch, with blocked entries waiting only for tab events. */
function armBookmarkMarkTimer() {
  if (bookmarkMarkTimer !== undefined) clearTimeout(bookmarkMarkTimer);
  bookmarkMarkTimer = undefined;
  bookmarkMarkDeadline = Infinity;
  let next = Infinity;
  for (const entry of pendingBookmarkMarks.values()) {
    if (entry.readyAt !== null) next = Math.min(next, entry.readyAt);
  }
  if (next !== Infinity) requestBookmarkMarkTimer(next);
}

/** A new entry identity invalidates any older async read for this bookmark. */
function scheduleBookmarkMark(id, url) {
  const urls = new Set(pendingBookmarkMarks.get(id)?.urls);
  if (typeof url === "string") urls.add(url);
  const entry = { urls, readyAt: Date.now() + NEW_BOOKMARK_SETTLE_MS };
  pendingBookmarkMarks.set(id, entry);
  persistPendingMarks();
  requestBookmarkMarkTimer(entry.readyAt);
}

function bookmarkPageUrl(url) {
  try {
    return new URL(fullyUnprefix(url)).href;
  } catch {
    return url;
  }
}

function bookmarkPageIsActive(node, entry, activeTabs) {
  const urls = new Set([...entry.urls, node.url].map(bookmarkPageUrl));
  return activeTabs.some((tab) => {
    // An unavailable URL is not evidence that this window's bubble is closed.
    if (typeof tab.url !== "string" && typeof tab.pendingUrl !== "string") {
      return true;
    }
    return [tab.url, tab.pendingUrl].some((url) =>
      typeof url === "string" && urls.has(bookmarkPageUrl(url))
    );
  });
}

async function markBookmarkNow(id, entry, activeTabs) {
  try {
    const [node] = await chrome.bookmarks.get(id);
    if (!settings.enabled || pendingBookmarkMarks.get(id) !== entry) return;
    if (!node?.url || node.unmodifiable) {
      pendingBookmarkMarks.delete(id);
      return;
    }

    const marked = migrateUrl(node.url);
    if (marked === node.url) {
      pendingBookmarkMarks.delete(id);
      return;
    }
    if (bookmarkPageIsActive(node, entry, activeTabs)) return;

    bookmarkMarkWrites.set(id, marked);
    try {
      await chrome.bookmarks.update(id, { url: marked });
    } finally {
      bookmarkMarkWrites.delete(id);
    }
    if (pendingBookmarkMarks.get(id) === entry) pendingBookmarkMarks.delete(id);
  } catch (err) {
    // Keep the entry for a later tab event/restart if a read or write fails.
    console.warn("[Bookmarks→NewTab] Could not mark bookmark:", err);
  }
}

function processPendingBookmarkMarks() {
  if (processingBookmarkMarks) return processingBookmarkMarks;
  processingBookmarkMarks = (async () => {
    await settingsReady;
    await pendingMarksReady;
    if (!settings.enabled) return;

    const due = [...pendingBookmarkMarks].filter(([, entry]) =>
      entry.readyAt !== null && entry.readyAt <= Date.now()
    );
    if (due.length === 0) return;
    // A failed query must defer, just like a possibly open bubble. One query
    // per batch avoids repeatedly enumerating tabs for imports/migration.
    for (const [, entry] of due) entry.readyAt = null;
    let activeTabs;
    try {
      activeTabs = await chrome.tabs.query({ active: true });
    } catch (err) {
      console.warn("[Bookmarks→NewTab] Could not check active bookmark pages:", err);
      return;
    }
    for (const [id, entry] of due) {
      if (pendingBookmarkMarks.get(id) === entry && settings.enabled) {
        await markBookmarkNow(id, entry, activeTabs);
      }
    }
  })().finally(() => {
    processingBookmarkMarks = null;
    persistPendingMarks();
    armBookmarkMarkTimer();
  });
  return processingBookmarkMarks;
}

function retryPendingBookmarkMarks() {
  for (const id of pendingBookmarkMarks.keys()) scheduleBookmarkMark(id);
}

// Register synchronously. Check all windows, not just the last focused one.
chrome.tabs.onActivated.addListener(retryPendingBookmarkMarks);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined || changeInfo.status !== undefined) {
    retryPendingBookmarkMarks();
  }
});
chrome.tabs.onRemoved.addListener(retryPendingBookmarkMarks);

/** Cancel before restoring URLs, including writes that have already started. */
async function cancelPendingBookmarkMarks() {
  pendingBookmarkMarks.clear();
  armBookmarkMarkTimer();
  persistPendingMarks();
  if (processingBookmarkMarks) await processingBookmarkMarks;
}

/** Restore the entire queue and give it a fresh guarded settling interval. */
async function drainPendingBookmarkMarks() {
  try {
    const stored = await chrome.storage.session.get([
      PENDING_MARKS_KEY, BOOKMARK_SESSION_READY_KEY,
    ]);
    bookmarkSessionReady = stored?.[BOOKMARK_SESSION_READY_KEY] === true;
    const records = stored?.[PENDING_MARKS_KEY];
    if (!settings.enabled || !Array.isArray(records)) return;
    for (const record of records) {
      // Legacy builds persisted only IDs. Keep those pending on upgrade too.
      const id = typeof record === "string" ? record : record?.id;
      if (typeof id !== "string") continue;
      const urls = Array.isArray(record?.urls) ? record.urls : [];
      scheduleBookmarkMark(id);
      for (const url of urls) {
        if (typeof url === "string") pendingBookmarkMarks.get(id).urls.add(url);
      }
    }
  } catch (err) {
    // Session storage can be unavailable; fresh events still work in memory.
  } finally {
    resolvePendingMarksReady();
    persistPendingMarks();
  }
}

/**
 * Session storage is cleared by browser restart/extension disable. Rediscover
 * clean bookmarks once per session, through the same editor guard. Persist the
 * ready flag only after the full tree is queued so an interrupted scan retries.
 */
async function reconcileBookmarkSession() {
  if (bookmarkSessionReady) return;
  if (settings.enabled) await prefixAllBookmarks();
  bookmarkSessionReady = true;
  await persistPendingMarks();
}
