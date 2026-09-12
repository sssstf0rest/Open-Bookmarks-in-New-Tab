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
