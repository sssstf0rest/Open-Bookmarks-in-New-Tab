/**
 * Open Bookmarks in New Tab — Background Service Worker
 *
 * Bookmarks retain the released newtab@ marker and special-domain wrappers.
 * DNR redirects marked main-frame requests to cancel.html. The fetch listener
 * returns a local, HTML-typed HTTP 204, stopping navigation without a download.
 * onBeforeNavigate opens the clean destination using the exact source tab.
 *
 * A 204 avoids replacing the document, but cannot prevent beforeunload handlers.
 * Pause restores bookmark URLs; Chrome provides no pre-uninstall cleanup event.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** The marker username injected into bookmark URLs */
const NEWTAB_PREFIX = "newtab@";

/** Exact local endpoint used only to stop marked navigations. */
const CANCEL_URL = chrome.runtime.getURL("cancel.html");

/** ID of the static declarativeNetRequest ruleset declared in manifest.json */
const RULESET_ID = "newtab_redirect";

// Register synchronously at worker evaluation, before settings/init awaits.
// Never fetch remotely or open a tab here: onBeforeNavigate owns the handoff.
// The explicit HTML MIME type is essential; an untyped extension response can
// enter Chrome's download pipeline even with status 204.
self.addEventListener("fetch", (event) => {
  if (event.request.url !== CANCEL_URL || event.request.method !== "GET") return;
  event.respondWith(new Response(null, {
    status: 204,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  }));
});

/**
 * Redirect page hosted on GitHub Pages.
 * Used as a proxy for bookmarks on domains where Chrome silently strips
 * the newtab@ userinfo (e.g. Google, Microsoft). The bookmark URL is
 * encoded in the ?url= query parameter:
 *   https://newtab@<REDIRECT_PAGE>?url=https%3A%2F%2Fmail.google.com%2F...
 *
 * Because this domain is NOT on Chrome's credential-stripping list,
 * newtab@ stays intact and declarativeNetRequest can match it.
 */
const REDIRECT_PAGE_BASE =
  "https://sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/redirect.html";

/**
 * Domains where Chrome's network stack silently strips the newtab@
 * userinfo before the request reaches declarativeNetRequest.
 * For these domains, bookmarks are wrapped via the redirect page.
 */
const CREDENTIAL_STRIPPED_DOMAINS = [
  "mail.google.com",         // Gmail
  "gmail.com",               // Gmail
  "www.gmail.com",           // Gmail
  "outlook.cloud.microsoft", // Outlook (new domain)
  "outlook.live.com",        // Outlook (personal)
  "outlook.office.com",      // Outlook (work)
  "outlook.office365.com",   // Outlook (365)
  "baidu.com",               // Baidu (Edge browser strips newtab@; covers left tab otherwise)
];

// ─── Default Settings ────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: true,          // Extension active by default
  focusNewTab: true,      // Switch focus to the newly opened tab
  position: "end",        // Where to place the new tab: "end" | "right"
};

// ─── State ───────────────────────────────────────────────────────────────────
let settings = { ...DEFAULT_SETTINGS };

/**
 * One handoff per source tab, never per destination URL. Different tabs may
 * legitimately open the same bookmark, including a folder with repeated URLs.
 * Entries are registered before any await and checked by object identity.
 */
const handledTabs = new Map();
const HANDOFF_TTL_MS = 10000;

/**
 * Resolves once init() has loaded the real settings from storage.
 *
 * `settings` starts as DEFAULT_SETTINGS (enabled: true), and init() replaces it
 * asynchronously. Any listener that acts on settings.enabled before that read
 * lands is working from a guess — and on a cold service worker start, that is
 * exactly when listeners fire. The visible bug: pause the extension, let the
 * worker sleep, then add a bookmark. The worker wakes, sees the default
 * enabled: true, and marks the new bookmark even though the user paused.
 *
 * Bookmark mutations and navigation decisions await this gate. Navigation
 * records its handoff first so events arriving during the read are correlated.
 */
let markSettingsReady;
const settingsReady = new Promise((resolve) => {
  markSettingsReady = resolve;
});

// ─── Settings Helpers ────────────────────────────────────────────────────────

/**
 * Loads user settings from chrome.storage.sync, falling back to defaults.
 */
async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get("settings");
    if (stored.settings) {
      settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Failed to load settings:", err);
  }
}

/**
 * Persists the current settings object to chrome.storage.sync.
 */
async function saveSettings() {
  try {
    await chrome.storage.sync.set({ settings });
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Failed to save settings:", err);
  }
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the URL can have the newtab@ prefix added.
 * Only http:// and https:// URLs support the userinfo field.
 * Internal URLs (chrome://, edge://, about:, javascript:, data:, file://)
 * are excluded.
 *
 * @param {string} url
 * @returns {boolean}
 */
function canPrefixUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * Returns true if the URL's domain is on the credential-stripping list.
 * For these domains, Chrome removes the newtab@ userinfo before the
 * request reaches declarativeNetRequest, so we must use the redirect
 * page proxy instead.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isCredentialStrippedDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CREDENTIAL_STRIPPED_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL is a redirect-page-wrapped bookmark.
 *   https://newtab@sssstf0rest.github.io/.../redirect.html?url=...
 *
 * @param {string} url  The URL to check (with or without newtab@ prefix).
 * @returns {boolean}
 */
function isRedirectPageUrl(url) {
  // Strip newtab@ if present, then check against REDIRECT_PAGE_BASE
  const stripped = url.replace(
    new RegExp(`^(https?://)${escapeRegex(NEWTAB_PREFIX)}`, "i"),
    "$1"
  );
  return stripped.startsWith(REDIRECT_PAGE_BASE);
}

/**
 * Strips every layer of the newtab@ marker, including the redirect-page wrapper.
 *
 * removePrefix() peels one layer. Older builds could double-prefix a bookmark
 * (https://newtab@newtab@example.com), so migration peels until stable rather
 * than leaving a half-marked URL behind. The iteration cap is a safety stop —
 * removePrefix always shrinks the string, so it cannot legitimately loop.
 *
 * @param {string} url
 * @returns {string}  The URL with no marker left on it.
 */
function fullyUnprefix(url) {
  let clean = url;
  for (let i = 0; i < 5 && hasPrefix(clean); i++) {
    const next = removePrefix(clean);
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

/**
 * Brings a bookmark URL up to the CURRENT marking scheme.
 *
 * addPrefix() alone cannot do this: it returns early on anything that already
 * carries the marker, so a bookmark stored under an older scheme keeps that
 * scheme forever. In particular, adding a domain to CREDENTIAL_STRIPPED_DOMAINS
 * never converted existing bookmarks — a bookmark saved as
 * https://newtab@gmail.com/ stayed that way even after gmail.com joined the
 * list, which is why the same bookmark misbehaved for some users and not others.
 *
 * Unmarking and re-marking converges in both directions: it wraps a bookmark
 * whose domain was ADDED to the list, and unwraps one whose domain was REMOVED.
 * It is idempotent, so it is safe to run on every enable.
 *
 * @param {string} url  The stored bookmark URL, marked or not.
 * @returns {string}    The URL as the current scheme would write it.
 */
function migrateUrl(url) {
  if (!canPrefixUrl(url)) return url;

  const unwrapped = fullyUnprefix(url);

  // Guard: a proxy-wrapped bookmark whose ?url= payload cannot be recovered
  // (hand-edited, truncated) would be destroyed by a round trip — unwrapping
  // yields the redirect page itself rather than the real destination. Leave
  // those exactly as they are. Same for a payload that is not http(s).
  if (isRedirectPageUrl(unwrapped) || !canPrefixUrl(unwrapped)) return url;

  return addPrefix(unwrapped);
}

/**
 * Adds the "newtab@" prefix to a URL.
 *
 * For normal domains:
 *   https://example.com → https://newtab@example.com
 *
 * For credential-stripped domains (Google, Microsoft, etc.):
 *   https://mail.google.com/... →
 *   https://newtab@sssstf0rest.github.io/.../redirect.html?url=https%3A%2F%2Fmail.google.com%2F...
 *
 * If the URL already has the prefix or is not http(s), returns it unchanged.
 *
 * @param {string} url  The original bookmark URL.
 * @returns {string}    The prefixed URL.
 */
function addPrefix(url) {
  if (!canPrefixUrl(url)) return url;
  if (hasPrefix(url)) return url;

  if (isCredentialStrippedDomain(url)) {
    // Wrap in the redirect page with the real URL as a query parameter.
    // newtab@ is applied to the redirect page domain (which Chrome won't strip).
    return `https://${NEWTAB_PREFIX}${REDIRECT_PAGE_BASE.replace(/^https?:\/\//, "")}?url=${encodeURIComponent(url)}`;
  }

  // Simple prefix — insert "newtab@" right after the "://" scheme separator
  return url.replace(/^(https?:\/\/)/i, `$1${NEWTAB_PREFIX}`);
}

/**
 * Removes the "newtab@" prefix from a URL and unwraps redirect-page URLs.
 *
 * Simple case:
 *   https://newtab@example.com → https://example.com
 *
 * Redirect-page case:
 *   https://newtab@.../redirect.html?url=https%3A%2F%2Fmail.google.com%2F...
 *   → https://mail.google.com/...
 *
 * @param {string} url  The prefixed URL.
 * @returns {string}    The cleaned URL.
 */
function removePrefix(url) {
  if (!hasPrefix(url)) return url;

  // Strip the newtab@ marker first
  const stripped = url.replace(
    new RegExp(`^(https?://)${escapeRegex(NEWTAB_PREFIX)}`, "i"),
    "$1"
  );

  // If this is a redirect-page URL, extract the real URL from ?url= param.
  // The payload is only trusted when it is http(s): this value is handed
  // straight to chrome.tabs.create/update, and a bookmark hand-edited to carry
  // a javascript: or data: payload must not be opened. Anything else falls
  // through to the redirect page itself, which is inert.
  if (stripped.startsWith(REDIRECT_PAGE_BASE)) {
    try {
      const parsed = new URL(stripped);
      const realUrl = parsed.searchParams.get("url");
      if (realUrl && canPrefixUrl(realUrl)) return realUrl;
    } catch {
      // Fall through to return the stripped URL
    }
  }

  return stripped;
}

/**
 * Returns true if the URL already contains the newtab@ prefix.
 *
 * @param {string} url
 * @returns {boolean}
 */
function hasPrefix(url) {
  return new RegExp(`^https?://${escapeRegex(NEWTAB_PREFIX)}`, "i").test(url);
}

/**
 * Escapes special regex characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the URL is an empty / new-tab page.
 * When the user clicks a bookmark from such a page, we load the bookmark
 * in that tab instead of opening a new one.
 *
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isNewTabPage(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower === "" ||
    lower === "about:blank" ||
    lower.startsWith("chrome://newtab") ||
    lower.startsWith("chrome://new-tab-page") ||
    lower.startsWith("edge://newtab")
  );
}

/**
 * A 204 does not create the download that previously doomed newly opened tabs.
 * Reuse committed blank pages, or an uncommitted tab for this navigation.
 * Never treat an unavailable Tab.url as evidence that an existing tab is blank.
 */
function isReusableBlankTab(tab, markedUrl) {
  if (!tab) return false;
  if (tab.url === "") {
    // The 204 may already have cleared pendingUrl before tabs.get resolves.
    return !tab.pendingUrl || tab.pendingUrl === markedUrl ||
      tab.pendingUrl === CANCEL_URL;
  }
  return typeof tab.url === "string" && isNewTabPage(tab.url);
}

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
 * Called when the extension is disabled or uninstalled.
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

// ─── Navigation Handoff ──────────────────────────────────────────────────────

/**
 * Open exactly one destination, preserving native background-tab behavior.
 * State is recorded before tabs.update because its commit can precede resolution.
 */
async function openInNewTab(cleanUrl, sourceTabId, handoff) {
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    if (handledTabs.get(sourceTabId) !== handoff) return false;

    if (!settings.enabled || isReusableBlankTab(sourceTab, handoff.markedUrl)) {
      handoff.reused = true;
      await chrome.tabs.update(sourceTabId, { url: cleanUrl });
      return true;
    }

    const createOptions = {
      url: cleanUrl,
      active: sourceTab.active === false ? false : settings.focusNewTab,
      windowId: sourceTab.windowId,
    };
    if (settings.position === "right") {
      createOptions.index = sourceTab.index + 1;
    }
    await chrome.tabs.create(createOptions);
    return true;
  } catch (err) {
    // Do not guess another active tab, close the source, or retry into duplicates.
    console.warn("[Bookmarks→NewTab] Error opening bookmark:", err);
    return false;
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  // A later user navigation supersedes the old handoff, even when unmarked.
  // Server redirects continue the navigation without a new onBeforeNavigate.
  handledTabs.delete(details.tabId);
  if (!hasPrefix(details.url)) return;
  const cleanUrl = removePrefix(details.url);
  if (!cleanUrl) return;

  const handoff = {
    markedUrl: details.url,
    cleanUrl,
    reused: false,
    aborted: false,
    settled: false,
    opening: null,
  };
  handledTabs.set(details.tabId, handoff);
  setTimeout(() => {
    if (handledTabs.get(details.tabId) === handoff) {
      handledTabs.delete(details.tabId);
    }
  }, HANDOFF_TTL_MS);

  handoff.opening = (async () => {
    await settingsReady;
    const opened = await openInNewTab(cleanUrl, details.tabId, handoff);
    handoff.settled = true;
    if ((!opened || handoff.reused || handoff.aborted) &&
        handledTabs.get(details.tabId) === handoff) {
      handledTabs.delete(details.tabId);
    }
    return opened;
  })();
  return handoff.opening;
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  const handoff = handledTabs.get(details.tabId);
  if (!handoff || (details.url !== handoff.markedUrl &&
      details.url !== CANCEL_URL)) return;

  // ERR_ABORTED is expected for 204. Do not cancel the destination opening:
  // the response may arrive before tabs.get completes on a cold worker.
  handoff.aborted = true;
  if (handoff.settled) handledTabs.delete(details.tabId);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const handoff = handledTabs.get(details.tabId);
  if (!handoff) {
    // If interception was missed, clean this tab rather than guessing its
    // previous state and opening another copy or closing an unrelated tab.
    if (hasPrefix(details.url)) {
      const cleanUrl = removePrefix(details.url);
      if (cleanUrl) {
        await chrome.tabs.update(details.tabId, { url: cleanUrl }).catch(() => {});
      }
    }
    return;
  }

  // 204 normally never commits. This is only a compatibility fallback when
  // DNR is bypassed (e.g. a browser strips userinfo before matching the rule).
  const opened = await handoff.opening;
  if (handledTabs.get(details.tabId) !== handoff) return;
  handledTabs.delete(details.tabId);
  if (!opened || handoff.reused || handoff.aborted) return;

  try {
    await chrome.tabs.goBack(details.tabId);
  } catch (err) {
    // Failure must not close an existing page or replace it with chrome://newtab.
    console.warn("[Bookmarks→NewTab] Could not restore source tab:", err);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handledTabs.delete(tabId);
});

// ─── Enable / Disable Logic ─────────────────────────────────────────────────

/**
 * Activates the extension: prefixes all bookmarks and enables the
 * declarativeNetRequest redirect rule.
 */
async function enableExtension() {
  // Enable the redirect rule
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [RULESET_ID],
  });

  // Add prefix to all bookmarks
  await prefixAllBookmarks();
}

/**
 * Deactivates the extension: strips the prefix from all bookmarks and
 * disables the redirect rule.
 */
async function disableExtension() {
  // Remove prefix from all bookmarks first (so they work normally)
  await unprefixAllBookmarks();

  // Disable the redirect rule
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    disableRulesetIds: [RULESET_ID],
  });

  handledTabs.clear();
}

// ─── Message Listener (Popup ↔ Background Communication) ────────────────────

/**
 * Handles messages from the popup UI for reading/writing settings.
 *
 * Supported message types:
 *   - { type: "getSettings" }           → returns current settings
 *   - { type: "updateSettings", data }  → merges data into settings and
 *                                          triggers enable/disable if the
 *                                          "enabled" flag changed
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getSettings") {
    sendResponse({ settings });
    return true;
  }

  if (message.type === "updateSettings") {
    const previousEnabled = settings.enabled;
    settings = { ...settings, ...message.data };
    saveSettings();

    // If the enabled state changed, toggle bookmark prefixing
    if ("enabled" in message.data && message.data.enabled !== previousEnabled) {
      if (message.data.enabled) {
        enableExtension();
      } else {
        disableExtension();
      }
    }

    sendResponse({ settings });
    return true;
  }

  return false;
});

// ─── Listen for storage changes (sync across popup & background) ─────────────
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes.settings) {
    // Wait for the stored settings before comparing. On a cold worker the
    // in-memory value is still DEFAULT_SETTINGS (enabled: true), so a synced
    // enabled:true would look like "no transition" and the enable would be
    // skipped — leaving the ruleset off and the bookmarks unmarked.
    await settingsReady;

    const previousEnabled = settings.enabled;
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };

    // If the enabled state changed (e.g. toggled from another device),
    // apply the change on this device too.
    if (settings.enabled !== previousEnabled) {
      if (settings.enabled) {
        enableExtension();
      } else {
        disableExtension();
      }
    }
  }
});

// ─── Extension Lifecycle Events ──────────────────────────────────────────────

/**
 * Runs when the extension is installed or updated.
 * On fresh install: prefix all bookmarks.
 * On update: re-prefix to catch any bookmarks added while the extension
 *            was not running.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();

  if (settings.enabled) {
    await enableExtension();
  }

  console.log(
    `[Bookmarks→NewTab] Extension ${details.reason}. ` +
    `Enabled: ${settings.enabled}`
  );
});

// ─── Initialization (Service Worker Startup) ─────────────────────────────────
// Listeners are registered synchronously; no periodic keep-alive is required.

/**
 * Brings the declarativeNetRequest ruleset in line with the stored setting.
 *
 * The static ruleset's enabled state is persisted PER PROFILE by Chrome, but it
 * was only ever written on an enable/disable transition — never checked at
 * startup. Bookmark markers, by contrast, travel between machines through
 * Chrome bookmark sync, because the marker lives in the bookmark URL itself.
 *
 * So a profile could end up holding fully marked, synced bookmarks while its
 * ruleset sat disabled. The rule then never matches, no 204 is returned,
 * and the source tab visibly navigates and gets restored instead —
 * the extension appears to "work" while behaving completely differently from
 * the machine the bookmarks came from.
 *
 * Reconciling on every worker start makes the two states converge on their own.
 */
async function reconcileRuleset() {
  try {
    const enabledRulesets =
      await chrome.declarativeNetRequest.getEnabledRulesets();
    const ruleIsOn = enabledRulesets.includes(RULESET_ID);

    if (settings.enabled && !ruleIsOn) {
      console.warn(
        "[Bookmarks→NewTab] Ruleset was disabled but settings say enabled — re-enabling."
      );
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [RULESET_ID],
      });
    } else if (!settings.enabled && ruleIsOn) {
      console.warn(
        "[Bookmarks→NewTab] Ruleset was enabled but settings say paused — disabling."
      );
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: [RULESET_ID],
      });
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Could not reconcile ruleset:", err);
  }
}

async function init() {
  // finally, not a plain call: if the settings read ever throws, the gate must
  // still open. A permanently-pending settingsReady would hang every bookmark
  // listener for the life of the worker.
  try {
    await loadSettings();
  } finally {
    // Release the bookmark-mutating listeners now that settings are real.
    // Done before the awaits below so a queued bookmark event is not held up
    // by ruleset reconciliation.
    markSettingsReady();
  }

  // Mark anything whose settle timer died with the previous worker.
  await drainPendingBookmarkMarks();

  // Make sure the redirect rule matches the stored enabled state. Cheap (one
  // read, a write only on drift). Navigation can already be in flight here;
  // this reconciliation is not a guarantee that the first request was redirected.
  await reconcileRuleset();
}

init();
console.log("[Bookmarks→NewTab] Service worker initialized.");
