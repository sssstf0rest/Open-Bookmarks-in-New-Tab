/**
 * One handoff per source tab, never per destination URL. Different tabs may
 * legitimately open the same bookmark, including a folder with repeated URLs.
 * Entries are registered before any await and checked by object identity.
 */
const handledTabs = new Map();
const HANDOFF_TTL_MS = 10000;

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
