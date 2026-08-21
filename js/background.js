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
 *   - tabs                  → open new tabs, read the navigating tab
 *                             (never the active tab — see openInNewTab)
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

/**
 * Page the declarativeNetRequest rule redirects the marker navigation to.
 * The fetch handler below answers it with a typed 204 — see there.
 */
const CANCEL_PAGE_FILENAME = "cancel.html";
const CANCEL_PAGE_URL = chrome.runtime.getURL(CANCEL_PAGE_FILENAME);

/**
 * Previous redirect target, kept for one release as the rollback path.
 * Reverting rules.json to "/empty.zip" restores the old download-based
 * cancellation without any other change; the file and its web_accessible_resources
 * entry are still in place for exactly that. The download listener below also
 * still recognises it.
 */
const EMPTY_ZIP_FILENAME = "empty.zip";

/** ID of the static declarativeNetRequest ruleset declared in manifest.json */
const RULESET_ID = "newtab_redirect";

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
  "mail.google.com",         // Gmail
  "gmail.com",               // Gmail
  "www.gmail.com",           // Gmail
  "outlook.cloud.microsoft", // Outlook (new domain)
  "outlook.live.com",        // Outlook (personal)
  "outlook.office.com",      // Outlook (work)
  "outlook.office365.com",   // Outlook (365)
  "baidu.com",               // Baidu (Edge browser strips newtab@; covers left tab otherwise)
];

// ─── Navigation Cancellation (typed 204) ─────────────────────────────────────
// This is what stops a bookmark click from taking the current tab away.
//
// The DNR rule (rules.json) redirects the newtab@ marker navigation to
// cancel.html, and this handler answers that request with a body-less, HTML-typed
// HTTP 204. Chrome treats that as an ABORTED NO-CONTENT navigation: the source
// tab keeps its document, and — unlike the previous empty.zip redirect — no
// DownloadItem is ever created.
//
// Why that matters beyond hiding the download popup: Chrome closes a tab whose
// navigation resolves to a download while the tab has nothing committed
// (download_ui_controller.cc gates web_contents->Close() on
// NavigationController::IsInitialNavigation()). That is what destroyed a
// still-loading bookmark tab when the next bookmark was clicked. With no
// DownloadItem, that code path is never reached at all.
//
// The Content-Type is load-bearing, not decoration: without it Chrome classifies
// the response as an interrupted zero-byte download (SERVER_BAD_CONTENT).
//
// Must be registered at the top level, synchronously, so it exists the moment
// the worker evaluates — a navigation can be waiting on it.
self.addEventListener("fetch", (event) => {
  if (event.request.url !== CANCEL_PAGE_URL) return;
  event.respondWith(
    new Response(null, {
      status: 204,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
});

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
 *
 * Entry shape: { cleanUrl: string, reused: boolean, seq: number }
 *   - cleanUrl: the destination URL (without newtab@ prefix)
 *   - reused:   true if openInNewTab reused the source tab itself
 *               (i.e. source tab was a new-tab page). When true,
 *               onCommitted MUST NOT restore the tab — the navigation
 *               is intentional and the final URL may differ from
 *               cleanUrl due to server-side redirects (e.g. ChatGPT
 *               redirects chat.openai.com → chatgpt.com).
 *   - seq:      handoff id, so an expiry timer only deletes its own entry
 *               and not a newer click's on the same tab.
 */
const handledTabs = new Map(); // tabId → { cleanUrl, reused, seq }

/**
 * Destination URLs that onBeforeNavigate has already opened, used to stop the
 * downloads.onCreated fallback from opening a SECOND tab for the same click.
 *
 * Why not correlate on tab ID: chrome.downloads.DownloadItem has no `tabId`
 * property (see the API reference — the type carries url/finalUrl/referrer but
 * no tab identity at all), so the download listener genuinely cannot tell which
 * tab its download belongs to. The URL is the only thing both listeners see.
 *
 * Written SYNCHRONOUSLY in onBeforeNavigate, before any await, so the entry is
 * already present by the time the download event arrives.
 *
 * Entry shape: cleanUrl → seq (the handoff id, so an expiry timer only deletes
 * its own entry and not a newer click's on the same URL)
 */
const recentlyOpenedUrls = new Map(); // cleanUrl → seq

/** How long a recentlyOpenedUrls / handledTabs entry stays valid (ms) */
const HANDOFF_TTL_MS = 10000;

/**
 * Destination tabs this extension opened, until they commit their page.
 *
 * A tab that has not committed anything is fragile: if a navigation in it
 * resolves to a download, Chrome closes it outright, and our own restore path
 * would otherwise fall through to chrome.tabs.remove. Knowing that a tab is one
 * of ours, and what it was loading, lets the restore path put it back instead
 * of destroying a page the user is waiting for.
 *
 * Entry shape: tabId → { url, seq }
 */
const openedTabs = new Map();

/**
 * How long an openedTabs entry survives (ms). Generous, because the whole point
 * is to cover a slow page load — this is the window during which a destination
 * tab is still uncommitted.
 */
const OPENED_TAB_TTL_MS = 120000;

/**
 * Monotonic id stamped on every handoff entry.
 *
 * The expiry timers must only delete the entry they were scheduled for. Keyed
 * on tabId or cleanUrl alone, click #1's timer would delete click #2's entry
 * when the same tab (or the same URL) is clicked again inside the TTL, leaving
 * onCommitted with no record and sending it down the full-fallback path.
 */
let handoffSeq = 0;

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
 * Only the listeners that MUTATE bookmarks or toggle the extension await this.
 * The navigation and download listeners deliberately do not: their real guard
 * is hasPrefix(), which is already false when the extension is paused, and
 * awaiting here would break onBeforeNavigate's synchronous handoff write.
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
 * Returns true if this tab is safe to navigate directly to the bookmark
 * instead of opening a new one.
 *
 * Reuse requires a tab that has COMMITTED a new-tab page. Two rules follow, and
 * both matter:
 *
 * 1. Tab.url is the last COMMITTED URL and is "" for a tab that has not
 *    committed anything. An empty url therefore means "unknown", not "blank" —
 *    treating it as reusable is how an in-flight tab gets hijacked.
 *
 * 2. More importantly, a tab with nothing committed is one Chrome created FOR
 *    this very navigation — Cmd/Ctrl+click, middle-click, or "Open all
 *    bookmarks". That tab is doomed: its only navigation is the newtab@ marker,
 *    which declarativeNetRequest turns into a download, and Chrome discards a
 *    tab whose sole navigation became a download. That teardown reliably beats
 *    our two IPC round-trips (tabs.get then tabs.update), so navigating it is
 *    handing the user a tab that is about to vanish. Open our own tab instead
 *    and let Chrome discard the doomed one.
 *
 * @param {chrome.tabs.Tab|null|undefined} tab
 * @returns {boolean}
 */
function isReusableBlankTab(tab) {
  if (!tab) return false;

  // Nothing committed → a tab Chrome opened for this navigation. Never reuse.
  if (!tab.url) return false;

  // Committed to something — judge on the real URL.
  return isNewTabPage(tab.url);
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

// ─── Open URL Helper ─────────────────────────────────────────────────────────

/**
 * Opens a clean (prefix-stripped) URL in a new tab, or reuses the source
 * tab if it's an empty / new-tab page. Respects user settings for focus
 * and tab position.
 *
 * @param {string} cleanUrl       The destination URL (without newtab@ prefix).
 * @param {number} [sourceTabId]  Optional tab ID where the bookmark was clicked.
 *                                If provided and that tab is a new-tab page,
 *                                it will be reused for the navigation.
 *                                If omitted, a new tab is ALWAYS created — the
 *                                active tab is never guessed at (see below).
 * @returns {Promise<{ reused: boolean }>}
 *   reused = true means the SOURCE tab was navigated directly (no new tab
 *   created). In that case, onCommitted must NOT try to restore the tab.
 */
async function openInNewTab(cleanUrl, sourceTabId) {
  try {
    // Try to get the exact source tab first (most reliable)
    let sourceTab = null;
    if (sourceTabId !== undefined) {
      try {
        sourceTab = await chrome.tabs.get(sourceTabId);
      } catch {
        // Tab may have been closed in the meantime
      }
    }

    // NOTE: there is deliberately NO "use the active tab" fallback here.
    // Guessing the active tab is how this function used to hijack an unrelated
    // tab, or duplicate into one, when it was called without a tab ID (the
    // downloads.onCreated path, which has no tab identity to give). Without a
    // known source tab we simply open a new tab, which is always correct.

    // Reuse the source tab if it's a new-tab page — single-tab UX
    if (isReusableBlankTab(sourceTab)) {
      await chrome.tabs.update(sourceTab.id, { url: cleanUrl });
      // Only report "reused" if it's the SAME tab the bookmark click
      // originated from. That's the tab whose onCommitted we need to skip.
      const reused = sourceTabId !== undefined && sourceTab.id === sourceTabId;
      return { reused };
    }

    // Normal case — open in a new tab.
    // If the tab this navigation belongs to was itself opened in the
    // background (Cmd/Ctrl+click, middle-click, "Open all bookmarks"), keep the
    // replacement in the background too — the user asked for a background tab
    // and focusNewTab is about ordinary same-tab bookmark clicks.
    const openedInBackground = sourceTab ? sourceTab.active === false : false;

    let createOptions = {
      url: cleanUrl,
      active: openedInBackground ? false : settings.focusNewTab,
    };

    // Determine tab placement. Pin the window explicitly: without windowId,
    // Chrome puts the tab in the last-focused window, which is not necessarily
    // the window the bookmark was clicked in — and then `index` below would be
    // measured against a different window's tab strip.
    if (sourceTab) {
      createOptions.windowId = sourceTab.windowId;
      if (settings.position === "right") {
        createOptions.index = sourceTab.index + 1;
      }
    }
    // "end" is the default — Chrome appends to the end of the tab bar

    const created = await chrome.tabs.create(createOptions);

    // Remember it until it commits. Until then it has no document of its own,
    // so neither Chrome nor our restore path can tell it apart from a throwaway
    // tab — and both would happily destroy it mid-load.
    if (created && created.id !== undefined) {
      const seq = ++handoffSeq;
      openedTabs.set(created.id, { url: cleanUrl, seq });
      setTimeout(() => {
        const entry = openedTabs.get(created.id);
        if (entry && entry.seq === seq) openedTabs.delete(created.id);
      }, OPENED_TAB_TTL_MS);
    }

    return { reused: false };
  } catch (err) {
    console.warn("[Bookmarks→NewTab] Error opening new tab:", err);
    return { reused: false };
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

  const seq = ++handoffSeq;

  // Mark this tab as handled IMMEDIATELY (before any await) so the
  // download listener and onCommitted both see the entry. We start with
  // reused=false; openInNewTab may upgrade it to true below.
  handledTabs.set(details.tabId, { cleanUrl, reused: false, seq });

  // Record the destination URL too — this is what the downloads listener
  // correlates on, since DownloadItem carries no tab identity. Must also be
  // synchronous: the download event can arrive while we are still awaiting.
  recentlyOpenedUrls.set(cleanUrl, seq);

  // Clean up both entries after the handoff window to avoid memory leaks.
  // Each timer deletes ONLY the entry it was scheduled for — a later click on
  // the same tab or the same URL installs a newer seq, and this timer must
  // leave that one alone.
  setTimeout(() => {
    const entry = handledTabs.get(details.tabId);
    if (entry && entry.seq === seq) handledTabs.delete(details.tabId);
  }, HANDOFF_TTL_MS);
  setTimeout(() => {
    if (recentlyOpenedUrls.get(cleanUrl) === seq) {
      recentlyOpenedUrls.delete(cleanUrl);
    }
  }, HANDOFF_TTL_MS);

  // Open the real URL in a new tab (or reuse the source tab if it's empty)
  const { reused } = await openInNewTab(cleanUrl, details.tabId);

  // If openInNewTab reused the source tab itself, update the flag so
  // onCommitted knows to skip the restore logic (the source tab IS the
  // destination tab now — don't goBack/remove it).
  if (reused) {
    const entry = handledTabs.get(details.tabId);
    if (entry) handledTabs.set(details.tabId, { ...entry, reused: true });
  }
});

// ─── Download Interception (Safety Net) ──────────────────────────────────────
// The declarativeNetRequest rule still redirects newtab@ URLs to empty.zip,
// creating a dummy download. This listener cancels it and erases it from
// history. It also serves as a fallback to open the URL if the
// webNavigation listener didn't fire (edge cases).

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const emptyZipUrl = chrome.runtime.getURL(EMPTY_ZIP_FILENAME);
  const cancelUrl = CANCEL_PAGE_URL;

  // ── Detect whether this download belongs to us ─────────────────────
  const urlHasPrefix      = hasPrefix(downloadItem.url || "");
  // Both redirect targets are recognised. cancel.html should never produce a
  // download at all — that is the whole point of the typed 204 — but if a Chrome
  // build classifies the 204 as a zero-byte download instead (the documented
  // SERVER_BAD_CONTENT behaviour when the Content-Type is missing), this listener
  // still catches it and the extension degrades to its previous behaviour rather
  // than leaving the user with a stuck download.
  const finalUrlIsOurs = (
    downloadItem.finalUrl === emptyZipUrl || downloadItem.finalUrl === cancelUrl
  );
  const urlIsOurs = (
    downloadItem.url === emptyZipUrl || downloadItem.url === cancelUrl
  );
  const referrerHasPrefix = hasPrefix(downloadItem.referrer || "");

  // A referrer carrying the marker is deliberately NOT enough on its own to
  // claim a download. This listener cancels and erases whatever it claims, so
  // a false positive silently destroys a download the user actually wanted —
  // e.g. any real file started from a page that was reached through the proxy
  // and still has newtab@ in its referrer. Every download we genuinely create
  // is identified by its own URL: DownloadItem.url is the pre-redirect marker
  // URL, and finalUrl is our bundled empty.zip. The referrer is only used
  // below as a last resort for recovering the destination.
  const isOurDownload = urlHasPrefix || finalUrlIsOurs || urlIsOurs;
  if (!isOurDownload) return;

  console.warn(
    "[Bookmarks→NewTab] A download was created for a bookmark navigation. " +
    "The typed-204 cancellation did not take effect on this Chrome build; " +
    "falling back to cancelling the download.",
    { url: downloadItem.url, finalUrl: downloadItem.finalUrl }
  );

  // ── Recover the original bookmark URL ──────────────────────────────
  // Done BEFORE cancel/erase so the dedup decision below is made from state
  // captured at onBeforeNavigate time, not several IPC round-trips later.
  // DownloadItem.url is documented as the URL *before any redirects*, so it
  // still carries the newtab@ marker even though DNR redirected to empty.zip.
  let newtabUrl = "";
  if (urlHasPrefix) {
    newtabUrl = downloadItem.url;
  } else if (referrerHasPrefix) {
    newtabUrl = downloadItem.referrer;
  } else if (hasPrefix(downloadItem.finalUrl || "")) {
    newtabUrl = downloadItem.finalUrl;
  }

  const cleanUrl = newtabUrl ? removePrefix(newtabUrl) : "";

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
  // Correlate on the destination URL, NOT on downloadItem.tabId — that
  // property does not exist on DownloadItem, so the old check here was
  // always false and this listener opened a duplicate tab on every click.
  if (cleanUrl && recentlyOpenedUrls.has(cleanUrl)) {
    recentlyOpenedUrls.delete(cleanUrl);
    return;
  }

  // ── Fallback: onBeforeNavigate never ran for this click ────────────
  if (!cleanUrl) {
    console.warn(
      "[Bookmarks→NewTab] Could not extract original URL from download item:",
      { url: downloadItem.url, finalUrl: downloadItem.finalUrl, referrer: downloadItem.referrer }
    );
    return;
  }

  // No source tab id is available here (DownloadItem has none), so
  // openInNewTab will create a new tab rather than guess at one.
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

/**
 * Returns true if this commit is the bookmark navigation we intercepted,
 * rather than something the user did afterwards in the same tab.
 *
 * The restore paths below used to key on tabId alone. Because a handledTabs
 * entry lives for HANDOFF_TTL_MS, that matched ANY commit in that tab inside
 * the window — so with focusNewTab off, clicking a bookmark and then clicking a
 * link on the source page within 10s made the tab jump backwards for no
 * reason. A bookmark click commits as "auto_bookmark"; a link click commits as
 * "link", which is what separates them. Server-side redirects keep the original
 * transitionType and only add a qualifier, so a redirected bookmark still
 * matches.
 *
 * @param {object} details  webNavigation.onCommitted details.
 * @returns {boolean}
 */
/**
 * Returns true if a committed URL is plausibly the destination we asked for.
 *
 * Exact equality is not enough: a destination routinely commits somewhere else
 * after a server-side redirect (chat.openai.com → chatgpt.com, gmail.com →
 * mail.google.com), which is the same reason the `reused` flag exists. Origin
 * equality is the useful middle ground — close enough to recognise our own
 * page, strict enough not to match an unrelated site.
 *
 * @param {string} committedUrl
 * @param {string} intendedUrl
 * @returns {boolean}
 */
function sameDestination(committedUrl, intendedUrl) {
  if (committedUrl === intendedUrl) return true;
  try {
    return new URL(committedUrl).origin === new URL(intendedUrl).origin;
  } catch {
    return false;
  }
}

function isBookmarkNavigation(details) {
  return (
    details.transitionType === "auto_bookmark" ||
    details.transitionType === "typed"
  );
}

/**
 * Puts a source tab back where it was after we opened its bookmark elsewhere.
 *
 * Order matters: go back if there is anywhere to go back to; otherwise, if this
 * is a tab WE opened for a bookmark and which had not finished loading, put it
 * back on the URL it was loading — never remove it. Removing it is only right
 * for a throwaway tab that has neither history nor a destination of its own.
 *
 * @param {number} tabId
 */
async function restoreSourceTab(tabId) {
  try {
    await chrome.tabs.goBack(tabId);
    return;
  } catch (err) {
    // No history — nothing to go back to.
  }

  const opened = openedTabs.get(tabId);
  if (opened) {
    // A destination tab of ours, still loading. Closing it would throw away the
    // page the user is waiting for; re-issue its navigation instead. The load
    // restarts, but the tab survives.
    await chrome.tabs
      .update(tabId, { url: opened.url })
      .catch(() => {});
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (removeErr) {
    await chrome.tabs.update(tabId, { url: "chrome://newtab" }).catch(() => {});
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only act on top-level frame navigations
  if (details.frameId !== 0) return;
  if (!settings.enabled) return;

  const urlHasPrefix = hasPrefix(details.url);
  const handled = handledTabs.get(details.tabId);

  // Retire the openedTabs entry only once this tab has committed the very page
  // we opened it for — that is the moment it stops being fragile. Do NOT retire
  // it on any other commit: in Case B the commit is a DIFFERENT bookmark's
  // destination landing in this tab, and that is exactly when restoreSourceTab
  // needs the entry to know this tab is worth saving rather than closing.
  const openedEntry = openedTabs.get(details.tabId);
  if (openedEntry && sameDestination(details.url, openedEntry.url)) {
    openedTabs.delete(details.tabId);
  }

  // ── Tab was intentionally reused by openInNewTab ────────────────────
  // The source tab itself was a new-tab page and we navigated it directly
  // to the bookmark URL. Do NOT restore — the current commit IS the
  // intended destination (or a post-redirect URL like ChatGPT going from
  // chat.openai.com → chatgpt.com, baidu.com → www.baidu.com, etc.).
  if (handled && handled.reused) {
    handledTabs.delete(details.tabId);
    return;
  }

  // ── Case B: prefix was stripped by Chrome (Gmail, Outlook, etc.) ────
  // onBeforeNavigate already opened a new tab. The current tab navigated
  // to the clean URL because Chrome stripped newtab@ before
  // declarativeNetRequest could redirect it. We need to undo this
  // navigation so the current tab goes back to where it was.
  if (!urlHasPrefix && handled) {
    // Only if this commit really is the bookmark navigation. Without this the
    // entry matches any commit in the tab for the next 10s, including the user
    // simply clicking a link.
    if (!isBookmarkNavigation(details)) return;

    handledTabs.delete(details.tabId);
    await restoreSourceTab(details.tabId);
    return;
  }

  // ── Case A: prefix still intact ────────────────────────────────────
  if (!urlHasPrefix) return;

  // If onBeforeNavigate already opened the new tab, just restore this tab
  if (handled) {
    handledTabs.delete(details.tabId);
    await restoreSourceTab(details.tabId);
    return;
  }

  // onBeforeNavigate did NOT handle this — full fallback
  const cleanUrl = removePrefix(details.url);
  const tabId = details.tabId;

  // ...unless a tab for this destination was already opened moments ago.
  // handledTabs is keyed by tabId and lives only in memory, so it is empty
  // after a service-worker restart even though onBeforeNavigate did run and
  // did open the tab. recentlyOpenedUrls is keyed by URL and survives that
  // same restart no better — but when it IS present it is proof a tab exists,
  // and creating a second one here is the third duplicate-tab source.
  // Restore this tab instead of adding to the pile.
  if (recentlyOpenedUrls.has(cleanUrl)) {
    await restoreSourceTab(tabId);
    return;
  }

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
    enableRulesetIds: [RULESET_ID],
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
    disableRulesetIds: [RULESET_ID],
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

/**
 * Brings the declarativeNetRequest ruleset in line with the stored setting.
 *
 * The static ruleset's enabled state is persisted PER PROFILE by Chrome, but it
 * was only ever written on an enable/disable transition — never checked at
 * startup. Bookmark markers, by contrast, travel between machines through
 * Chrome bookmark sync, because the marker lives in the bookmark URL itself.
 *
 * So a profile could end up holding fully marked, synced bookmarks while its
 * ruleset sat disabled. The rule then never matches, no download is ever
 * created, and the source tab visibly navigates and gets restored instead —
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
  // read, a write only on drift) and it runs before any bookmark click can be
  // handled, so it cannot fight the listeners.
  await reconcileRuleset();

  // NOTE: there is no downloads.setUiOptions call here any more. It needed the
  // "downloads.ui" permission the manifest does not declare, so it always
  // rejected and did nothing — and with the typed-204 cancellation there is no
  // download to hide in the first place.

  if (settings.enabled) {
    // Ensure keep-alive alarm is active (it may have been cleared if the
    // service worker was terminated and restarted).
    //
    // This matters MORE than it used to. Chrome used to serve the redirect
    // target straight from the extension bundle, needing no worker. Now the
    // fetch handler above answers it, so a terminated worker has to boot before
    // the marker navigation can be aborted — and the page the user is reading
    // sits in a pending navigation until it does.
    await setupKeepAlive();
  }
}

init();
console.log("[Bookmarks→NewTab] Service worker initialized.");
