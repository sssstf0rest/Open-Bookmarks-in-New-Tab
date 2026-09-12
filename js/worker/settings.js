// ─── State ───────────────────────────────────────────────────────────────────
let settings = { ...DEFAULT_SETTINGS };

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
