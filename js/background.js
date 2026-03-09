/**
 * =============================================================================
 * Open Bookmarks in New Tab — Background Service Worker
 * =============================================================================
 *
 * How it works (webNavigation interception):
 *
 * 1. DETECT — chrome.webNavigation.onCommitted fires for every top-level
 *    navigation. We check `transitionType === "auto_bookmark"` to identify
 *    navigations triggered by clicking a bookmark.
 *
 * 2. NEW TAB — The bookmark URL is opened in a new tab with the user's
 *    preferred focus and position settings.
 *
 * 3. RESTORE — The original tab is navigated back to its previous page
 *    via chrome.tabs.goBack(). If there's no history (e.g. the tab was a
 *    new-tab page), we load the bookmark there instead.
 *
 * No bookmark rewriting. No redirect rules. No dummy downloads.
 * Bookmarks stay completely clean and unmodified.
 *
 * Permissions:
 *   - webNavigation  → detect bookmark-triggered navigations
 *   - tabs           → open new tabs, query active tab, goBack()
 *   - storage        → persist user settings
 * =============================================================================
 */

// ─── Default Settings ────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: true,          // Extension active by default
  focusNewTab: true,      // Switch focus to the newly opened tab
  position: "end",        // Where to place the new tab: "end" | "right"
};

// ─── State ───────────────────────────────────────────────────────────────────
let settings = { ...DEFAULT_SETTINGS };

/**
 * Tracks recently created tabs so we can distinguish a normal bookmark click
 * (which navigates an EXISTING tab) from a Cmd+Click / middle-click bookmark
 * (which Chrome opens in a NEW tab — we should NOT intercept those).
 *
 * Key: tabId, Value: creation timestamp (Date.now())
 */
const recentlyCreatedTabs = new Map();

// ─── Settings Helpers ────────────────────────────────────────────────────────

/**
 * Loads user settings from chrome.storage.local, falling back to defaults.
 */
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get("settings");
    if (stored.settings) {
      settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Failed to load settings:", err);
  }
}

/**
 * Persists the current settings object to chrome.storage.local.
 */
async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings });
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Failed to save settings:", err);
  }
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the URL is a "blank" page where the bookmark should load
 * in-place rather than opening a new tab.
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
 * Returns true if the URL is an http(s) URL that we should intercept.
 * Internal URLs (chrome://, edge://, about:, etc.) are left alone.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isInterceptableUrl(url) {
  return /^https?:\/\//i.test(url);
}

// ─── Migration: Clean up old newtab@ prefixes ────────────────────────────────
// Users upgrading from v2 (the newtab@ prefix approach) may have bookmarks
// with the "newtab@" marker still in their URLs. We strip them on install.

const NEWTAB_PREFIX = "newtab@";

function hasOldPrefix(url) {
  return new RegExp(`^https?://${NEWTAB_PREFIX}`, "i").test(url);
}

function removeOldPrefix(url) {
  return url.replace(new RegExp(`^(https?://)${NEWTAB_PREFIX}`, "i"), "$1");
}

async function migrateOldBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    await migrateNodes(tree);
    console.log("[Bookmarks→NewTab] Migration: cleaned up old newtab@ prefixes.");
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Migration error:", err);
  }
}

async function migrateNodes(nodes) {
  for (const node of nodes) {
    if (node.children) {
      await migrateNodes(node.children);
    }
    if (node.url && hasOldPrefix(node.url)) {
      const cleanUrl = removeOldPrefix(node.url);
      try {
        await chrome.bookmarks.update(node.id, { url: cleanUrl });
      } catch (err) {
        console.warn("[Bookmarks→NewTab] Could not migrate bookmark:", node.title, err);
      }
    }
  }
}

// ─── Tab Tracking ────────────────────────────────────────────────────────────
// When the user Cmd+clicks or middle-clicks a bookmark, Chrome opens it
// directly in a new tab. The webNavigation.onCommitted event fires in that
// NEW tab with transitionType "auto_bookmark". We must NOT intercept this
// (it would open a duplicate tab and break the original).
//
// Strategy: track tab creation times. If onCommitted fires in a tab that
// was created very recently (< 2 seconds), it's a Cmd+Click / middle-click
// — skip interception.

chrome.tabs.onCreated.addListener((tab) => {
  recentlyCreatedTabs.set(tab.id, Date.now());
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  recentlyCreatedTabs.delete(tabId);
});

// ─── Core: webNavigation Interception ────────────────────────────────────────

/**
 * The heart of the extension. Listens for committed navigations with
 * transitionType "auto_bookmark" (i.e. the user clicked a bookmark).
 *
 * When detected:
 *   1. Open the bookmark URL in a new tab
 *   2. Restore the original tab via goBack() or leave it if it was empty
 */
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only handle top-level frame navigations
  if (details.frameId !== 0) return;

  // Only act when enabled
  if (!settings.enabled) return;

  // Only intercept bookmark-triggered navigations
  if (details.transitionType !== "auto_bookmark") return;

  const { url, tabId } = details;

  // Only intercept http(s) URLs — leave chrome://, file://, etc. alone
  if (!isInterceptableUrl(url)) return;

  // ── Skip if this is a Cmd+Click / middle-click ──────────────────────
  // These already open in a new tab — intercepting would create duplicates.
  const createdAt = recentlyCreatedTabs.get(tabId);
  if (createdAt && (Date.now() - createdAt) < 2000) {
    recentlyCreatedTabs.delete(tabId);
    return;
  }
  recentlyCreatedTabs.delete(tabId);

  // ── Determine how to handle the original tab ────────────────────────
  try {
    const tab = await chrome.tabs.get(tabId);

    // If the tab was a new-tab / blank page, just let the bookmark load
    // there — no need to open another tab.
    // We check the tab's previous URL from its navigation history.
    // Since onCommitted already fired, the tab is now showing the bookmark URL.
    // We need to check if there's a meaningful page to go back to.

    // Use a heuristic: try goBack(). If the tab had no prior history,
    // goBack() will fail (or navigate to an empty state). In that case,
    // we don't open a new tab — the bookmark just loads in the current tab.
    // But if there IS history, we open in a new tab and restore.

    // First, check if we can detect a "new tab" scenario.
    // When a user clicks a bookmark from a new-tab page, there may be
    // only one entry in the tab's history (the bookmark URL itself).
    // We detect this using chrome.history.state or by checking the
    // navigation transition qualifiers.

    // Simpler approach: try to get the tab info before navigation.
    // Since onCommitted already fired, we check if going back is meaningful
    // by looking at transitionQualifiers.
    const qualifiers = details.transitionQualifiers || [];
    const isFromAddressBar = qualifiers.includes("from_address_bar");

    // If the bookmark was clicked from the new-tab page's address/omnibox,
    // the tab likely has no meaningful prior page — let it load in place.
    if (isFromAddressBar) return;

    // ── Open URL in a new tab ───────────────────────────────────────
    const createOptions = {
      url: url,
      active: settings.focusNewTab,
    };

    if (settings.position === "right") {
      createOptions.index = tab.index + 1;
    }

    await chrome.tabs.create(createOptions);

    // ── Restore the original tab ────────────────────────────────────
    try {
      await chrome.tabs.goBack(tabId);
    } catch (backErr) {
      // goBack() failed — no history. Navigate to new-tab page.
      await chrome.tabs.update(tabId, { url: "chrome://newtab" });
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Error handling bookmark click:", err);
  }
});

// ─── Message Listener (Popup <-> Background Communication) ───────────────────

/**
 * Handles messages from the popup UI for reading/writing settings.
 *
 * Supported message types:
 *   - { type: "getSettings" }           → returns current settings
 *   - { type: "updateSettings", data }  → merges data into settings
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getSettings") {
    sendResponse({ settings });
    return true;
  }

  if (message.type === "updateSettings") {
    settings = { ...settings, ...message.data };
    saveSettings();
    sendResponse({ settings });
    return true;
  }

  return false;
});

// ─── Listen for storage changes (sync across popup & background) ─────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  }
});

// ─── Extension Lifecycle Events ──────────────────────────────────────────────

/**
 * Runs when the extension is installed or updated.
 * On update from v2: cleans up old newtab@ prefixes in bookmarks.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();

  // Migration: strip old newtab@ prefixes from bookmarks (v2 → v3 upgrade)
  if (details.reason === "update") {
    await migrateOldBookmarks();
  }

  console.log(
    `[Bookmarks→NewTab] Extension ${details.reason}. ` +
    `Enabled: ${settings.enabled}`
  );
});

// ─── Initialization (Service Worker Startup) ─────────────────────────────────

async function init() {
  await loadSettings();
}

init();
console.log("[Bookmarks→NewTab] Service worker initialized.");
