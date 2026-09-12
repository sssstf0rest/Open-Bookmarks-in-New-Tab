/** The marker username injected into bookmark URLs */
const NEWTAB_PREFIX = "newtab@";

/** ID of the static declarativeNetRequest ruleset declared in manifest.json */
const RULESET_ID = "newtab_redirect";

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
