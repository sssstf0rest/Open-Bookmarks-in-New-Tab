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
