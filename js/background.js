/**
 * =============================================================================
 * Open Bookmarks in New Tab — Background Service Worker
 * =============================================================================
 *
 * How it works (the "newtab@" prefix trick):
 *
 * 1. BOOKMARK REWRITING — On install / enable, every bookmark URL is rewritten
 *    from  https://example.com  →  https://newtab@example.com
 *    The "newtab@" part exploits the URL userinfo field (RFC 3986 §3.2.1).
 *    Browsers ignore it for display and most servers ignore it entirely,
 *    so favicons and titles are preserved.
 *
 * 2. REDIRECT RULE — A declarativeNetRequest rule (rules.json) matches any
 *    main_frame request whose URL contains "newtab@" and redirects it to
 *    the extension's own empty.zip file. This triggers a download instead
 *    of a page navigation, so the current tab is NEVER touched.
 *
 * 3. DOWNLOAD INTERCEPTION — The chrome.downloads API catches the dummy
 *    empty.zip download as soon as it starts. We immediately cancel it
 *    (no file is saved, no download bar flash) and extract the *original*
 *    bookmark URL from the download's referrer / URL chain.
 *
 * 4. NEW TAB — The cleaned URL (without "newtab@") is opened in a new tab
 *    with the user's preferred focus and position settings.
 *
 * 5. DISABLE / UNINSTALL — When the extension is toggled off or uninstalled,
 *    all bookmark URLs are restored to their original form (prefix stripped).
 *
 * Result: The current tab is completely undisturbed — no reload, no flash,
 *         no bfcache dependency. YouTube keeps playing.
 *
 * Permissions:
 *   - bookmarks             → read & rewrite bookmark URLs
 *   - tabs                  → open new tabs, query active tab
 *   - storage               → persist user settings
 *   - downloads             → intercept & cancel dummy downloads
 *   - declarativeNetRequest → redirect newtab@ URLs to empty.zip
 *   - alarms                → keep service worker alive for download listener
 *   - host_permissions <all_urls> → needed by declarativeNetRequest redirect
 * =============================================================================
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** The marker username injected into bookmark URLs */
const NEWTAB_PREFIX = "newtab@";

/** Path to the dummy file that declarativeNetRequest redirects to */
const EMPTY_ZIP_FILENAME = "empty.zip";

/** Interval (minutes) for the keep-alive alarm */
const KEEPALIVE_INTERVAL_MIN = 0.5;

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
  "mail.google.com",        // Gmail
  "outlook.cloud.microsoft", // Outlook (new domain)
  "outlook.live.com",        // Outlook (personal)
  "outlook.office.com",      // Outlook (work)
  "outlook.office365.com",   // Outlook (365)
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
 * Tracks tab IDs that have already been handled by the webNavigation
 * onBeforeNavigate listener. This prevents the downloads.onCreated listener
 * from opening a duplicate tab for the same bookmark click.
 */
const handledTabs = new Map(); // tabId → cleanUrl

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

  // If this is a redirect-page URL, extract the real URL from ?url= param
  if (stripped.startsWith(REDIRECT_PAGE_BASE)) {
    try {
      const parsed = new URL(stripped);
      const realUrl = parsed.searchParams.get("url");
      if (realUrl) return realUrl;
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
 * Adds the newtab@ prefix to ALL bookmarks.
 * Called when the extension is installed or enabled.
 */
async function prefixAllBookmarks() {
  console.log("[Bookmarks→NewTab] Adding prefix to all bookmarks…");
  await walkAndTransformBookmarks(addPrefix);
  console.log("[Bookmarks→NewTab] Prefix added to all bookmarks.");
}

/**
 * Removes the newtab@ prefix from ALL bookmarks.
 * Called when the extension is disabled or uninstalled.
 */
async function unprefixAllBookmarks() {
  console.log("[Bookmarks→NewTab] Removing prefix from all bookmarks…");
  await walkAndTransformBookmarks(removePrefix);
  console.log("[Bookmarks→NewTab] Prefix removed from all bookmarks.");
}

// ─── Bookmark Change Listeners ───────────────────────────────────────────────
// When the user creates or edits a bookmark while the extension is enabled,
// we need to add the prefix to the new URL automatically.

/**
 * When a new bookmark is created, add the prefix if the extension is enabled.
 */
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!settings.enabled) return;
  if (!bookmark.url) return; // It's a folder

  const prefixed = addPrefix(bookmark.url);
  if (prefixed !== bookmark.url) {
    try {
      await chrome.bookmarks.update(id, { url: prefixed });
    } catch (err) {
      console.warn("[Bookmarks→NewTab] Could not prefix new bookmark:", err);
    }
  }
});

/**
 * When a bookmark URL is changed, ensure the prefix is present if enabled.
 * This handles the case where the user edits a bookmark URL manually.
 */
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
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

// ─── Open URL Helper ─────────────────────────────────────────────────────────

/**
 * Opens a clean (prefix-stripped) URL in a new tab, or reuses the active tab
 * if it's an empty / new-tab page. Respects user settings for focus and
 * tab position.
 *
 * @param {string} cleanUrl  The destination URL (without newtab@ prefix).
 */
async function openInNewTab(cleanUrl) {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab && isNewTabPage(activeTab.url)) {
      // Reuse the empty tab — navigate it to the bookmark URL
      await chrome.tabs.update(activeTab.id, { url: cleanUrl });
    } else {
      // Normal case — open in a new tab
      let createOptions = {
        url: cleanUrl,
        active: settings.focusNewTab,
      };

      // Determine tab placement
      if (settings.position === "right" && activeTab) {
        createOptions.index = activeTab.index + 1;
      }
      // "end" is the default — Chrome appends to the end of the tab bar

      await chrome.tabs.create(createOptions);
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Error opening new tab:", err);
  }
}

// ─── Primary Interceptor: webNavigation.onBeforeNavigate ─────────────────────
// This fires BEFORE the declarativeNetRequest redirect, so we can open the
// new tab immediately without waiting for the download round-trip.
// The download will still be created and cancelled, but even if cancellation
// is slow (e.g. service worker cold start), the user already has their tab.

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only act on top-level frame navigations
  if (details.frameId !== 0) return;
  if (!settings.enabled) return;
  if (!hasPrefix(details.url)) return;

  const cleanUrl = removePrefix(details.url);
  if (!cleanUrl) return;

  // Mark this tab as handled so the download listener skips it
  handledTabs.set(details.tabId, cleanUrl);

  // Clean up the entry after 10 seconds to avoid memory leaks
  setTimeout(() => handledTabs.delete(details.tabId), 10000);

  // Open the real URL in a new tab immediately
  await openInNewTab(cleanUrl);
});

// ─── Download Interception (Safety Net) ──────────────────────────────────────
// The declarativeNetRequest rule still redirects newtab@ URLs to empty.zip,
// creating a dummy download. This listener cancels it and erases it from
// history. It also serves as a fallback to open the URL if the
// webNavigation listener didn't fire (edge cases).

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const emptyZipUrl = chrome.runtime.getURL(EMPTY_ZIP_FILENAME);

  // ── Detect whether this download belongs to us ─────────────────────
  const urlHasPrefix      = hasPrefix(downloadItem.url || "");
  const finalUrlIsZip     = (downloadItem.finalUrl === emptyZipUrl);
  const urlIsZip          = (downloadItem.url === emptyZipUrl);
  const referrerHasPrefix = hasPrefix(downloadItem.referrer || "");

  const isOurDownload = urlHasPrefix || finalUrlIsZip || urlIsZip || referrerHasPrefix;
  if (!isOurDownload) return;

  // ── Cancel the dummy download immediately ──────────────────────────
  try {
    await chrome.downloads.cancel(downloadItem.id);
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Could not cancel download:", err);
  }

  // Erase it from the download history
  try {
    await chrome.downloads.erase({ id: downloadItem.id });
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Could not erase download:", err);
  }

  // ── Check if already handled by onBeforeNavigate ───────────────────
  // If the webNavigation listener already opened the tab, skip.
  if (downloadItem.tabId !== undefined && handledTabs.has(downloadItem.tabId)) {
    handledTabs.delete(downloadItem.tabId);
    return;
  }

  // ── Fallback: extract URL and open tab ─────────────────────────────
  let newtabUrl = "";
  if (urlHasPrefix) {
    newtabUrl = downloadItem.url;
  } else if (referrerHasPrefix) {
    newtabUrl = downloadItem.referrer;
  } else if (hasPrefix(downloadItem.finalUrl || "")) {
    newtabUrl = downloadItem.finalUrl;
  }

  const cleanUrl = newtabUrl ? removePrefix(newtabUrl) : "";
  if (!cleanUrl) {
    console.warn(
      "[Bookmarks→NewTab] Could not extract original URL from download item:",
      { url: downloadItem.url, finalUrl: downloadItem.finalUrl, referrer: downloadItem.referrer }
    );
    return;
  }

  await openInNewTab(cleanUrl);
});

// ─── Fallback: webNavigation Safety Net ──────────────────────────────────────
// This listener handles TWO cases where the current tab navigates instead of
// being silently redirected to the empty.zip download:
//
// Case A — "prefix intact": The URL still contains newtab@ when onCommitted
//   fires. This happens on some browsers (e.g. Edge) or under timing issues
//   where declarativeNetRequest didn't redirect.
//
// Case B — "prefix stripped": Chrome's network stack silently strips the
//   newtab@ userinfo from URLs on certain high-security domains (Gmail,
//   Outlook, etc.) that are on Chrome's HSTS preload list. The
//   declarativeNetRequest rule never matches because the URL no longer
//   contains "newtab@" by the time it reaches the network layer.
//   In this case, onBeforeNavigate DID see the newtab@ URL and already
//   opened a new tab + recorded the tabId in handledTabs. We just need
//   to restore the current tab.

chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only act on top-level frame navigations
  if (details.frameId !== 0) return;
  if (!settings.enabled) return;

  const urlHasPrefix = hasPrefix(details.url);
  const handled = handledTabs.get(details.tabId);

  // ── Case B: prefix was stripped by Chrome (Gmail, Outlook, etc.) ────
  // onBeforeNavigate already opened a new tab. The current tab navigated
  // to the clean URL because Chrome stripped newtab@ before
  // declarativeNetRequest could redirect it. We need to undo this
  // navigation so the current tab goes back to where it was.
  //
  // Exception: if the committed URL matches the handled cleanUrl, it
  // means openInNewTab() reused this tab (it was a new-tab page) and
  // navigated it directly to the bookmark destination. Don't restore.
  if (!urlHasPrefix && handled) {
    handledTabs.delete(details.tabId);

    // Tab was reused by openInNewTab — nothing to restore
    if (details.url === handled) return;

    const tabId = details.tabId;

    try {
      // Try to go back to the previous page
      await chrome.tabs.goBack(tabId);
    } catch (err) {
      // goBack fails if the tab has no history (e.g. Cmd+Click opened a
      // new tab for the bookmark). In that case, close the duplicate tab
      // since onBeforeNavigate already opened the URL in another tab.
      try {
        await chrome.tabs.remove(tabId);
      } catch (removeErr) {
        // Last resort — navigate to new-tab page
        await chrome.tabs.update(tabId, { url: "chrome://newtab" }).catch(() => {});
      }
    }
    return;
  }

  // ── Case A: prefix still intact ────────────────────────────────────
  if (!urlHasPrefix) return;

  // If onBeforeNavigate already opened the new tab, just restore this tab
  if (handled) {
    handledTabs.delete(details.tabId);

    // Tab was reused by openInNewTab — nothing to restore
    if (removePrefix(details.url) === handled) return;

    const tabId = details.tabId;

    try {
      await chrome.tabs.goBack(tabId);
    } catch (err) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (removeErr) {
        await chrome.tabs.update(tabId, { url: "chrome://newtab" }).catch(() => {});
      }
    }
    return;
  }

  // onBeforeNavigate did NOT handle this — full fallback
  const cleanUrl = removePrefix(details.url);
  const tabId = details.tabId;

  try {
    const tab = await chrome.tabs.get(tabId);

    const isFromNewTab = (
      details.transitionType === "auto_bookmark" ||
      details.transitionType === "typed"
    );

    if (isFromNewTab && (!tab.openerTabId || isNewTabPage(tab.pendingUrl))) {
      // Tab was empty — just load the bookmark URL there
      await chrome.tabs.update(tabId, { url: cleanUrl });
    } else {
      // Open clean URL in a new tab
      let createOptions = {
        url: cleanUrl,
        active: settings.focusNewTab,
      };
      if (settings.position === "right") {
        createOptions.index = tab.index + 1;
      }
      await chrome.tabs.create(createOptions);

      // Navigate the original tab back to restore its previous page
      try {
        await chrome.tabs.goBack(tabId);
      } catch (err) {
        await chrome.tabs.update(tabId, { url: "chrome://newtab" });
      }
    }
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Fallback handler error:", err);
  }
});

// ─── Keep-Alive Alarm ────────────────────────────────────────────────────────
// Chrome MV3 service workers can be terminated after ~30 seconds of
// inactivity. The downloads.onCreated listener must be active to catch the
// dummy download, so we use a periodic alarm to keep the worker alive.

/**
 * Set up a repeating alarm that fires every 30 seconds.
 * The alarm handler itself does nothing — its purpose is simply to
 * wake / keep alive the service worker.
 */
async function setupKeepAlive() {
  await chrome.alarms.create("keepAlive", {
    periodInMinutes: KEEPALIVE_INTERVAL_MIN,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // No-op — the alarm's purpose is just to keep the service worker alive
    // so that the downloads.onCreated listener is ready.
  }
});

// ─── Enable / Disable Logic ─────────────────────────────────────────────────

/**
 * Activates the extension: prefixes all bookmarks and enables the
 * declarativeNetRequest redirect rule.
 */
async function enableExtension() {
  // Enable the redirect rule
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: ["newtab_redirect"],
  });

  // Add prefix to all bookmarks
  await prefixAllBookmarks();

  // Start the keep-alive alarm
  await setupKeepAlive();
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
    disableRulesetIds: ["newtab_redirect"],
  });

  // Stop the keep-alive alarm
  await chrome.alarms.clear("keepAlive");
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
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

/**
 * Runs when the extension is about to be uninstalled (if supported).
 * Clean up all bookmark URLs by removing the prefix.
 *
 * Note: chrome.runtime.setUninstallURL is used for the cleanup page;
 * the actual cleanup happens in the "suspend" or via onInstalled on
 * re-install. As a safeguard, we also clean up on disable.
 */

// ─── Initialization (Service Worker Startup) ─────────────────────────────────
// This runs every time the service worker starts (which can happen multiple
// times due to Chrome's MV3 lifecycle). We reload settings and ensure the
// keep-alive alarm is running.

async function init() {
  await loadSettings();

  // Hide the download UI for our dummy empty.zip downloads (Chrome 117+).
  // Even if the downloads.onCreated cancel is slightly delayed, the user
  // won't see a download bubble flash.
  try {
    await chrome.downloads.setUiOptions?.({ enabled: false });
  } catch (err) {
    // Not supported in older Chrome — non-critical
  }

  if (settings.enabled) {
    // Ensure keep-alive alarm is active (it may have been cleared if the
    // service worker was terminated and restarted)
    await setupKeepAlive();
  }
}

init();
console.log("[Bookmarks→NewTab] Service worker initialized.");
