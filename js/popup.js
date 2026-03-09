/**
 * =============================================================================
 * Open Bookmarks in New Tab — Popup Script
 * =============================================================================
 *
 * Responsibilities:
 *   - Read settings from the background service worker on popup open
 *   - Bind UI controls (toggle, select) to settings updates
 *   - Persist changes through chrome.runtime messages
 *   - Update visual state (status text, disabled sections) reactively
 *   - Toggle enabled/disabled state instantly (no bookmark rewriting needed)
 *
 * All DOM access is wrapped in DOMContentLoaded for safety, although
 * the <script> tag is placed at the end of <body>.
 * =============================================================================
 */

document.addEventListener("DOMContentLoaded", () => {

  // ─── i18n ─────────────────────────────────────────────────────────────

  const I18N = {
    en: {
      title:       "Bookmarks → New Tab",
      extEnabled:  "Extension Enabled",
      statusOn:    "Bookmarks open in a new tab",
      statusOff:   "Extension is paused",
      busyEnable:  "Enabling… updating bookmarks",
      busyDisable: "Disabling… restoring bookmarks",
      settings:    "Settings",
      focusNewTab: "Focus new tab",
      tabPosition: "New tab position",
      posEnd:      "End of tab bar",
      posRight:    "Right of current tab",
      tip:         "Tip: You can still Ctrl+Click or middle-click bookmarks to open them in a new tab manually.",
    },
    zh: {
      title:       "书签 → 新标签页",
      extEnabled:  "扩展已启用",
      statusOn:    "书签将在新标签页中打开",
      statusOff:   "扩展已暂停",
      busyEnable:  "正在启用…更新书签中",
      busyDisable: "正在禁用…恢复书签中",
      settings:    "设置",
      focusNewTab: "聚焦新标签页",
      tabPosition: "新标签页位置",
      posEnd:      "标签栏末尾",
      posRight:    "当前标签页右侧",
      tip:         "提示：您仍然可以按住 Ctrl 点击或鼠标中键点击书签来手动在新标签页中打开。",
    },
  };

  let currentLang = "en";

  function applyLang(lang) {
    currentLang = lang;
    const strings = I18N[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (strings[key] != null) el.textContent = strings[key];
    });
    // Update active button styles
    document.getElementById("lang-en").classList.toggle("lang-switch__btn--active", lang === "en");
    document.getElementById("lang-zh").classList.toggle("lang-switch__btn--active", lang === "zh");
    // Persist preference
    chrome.storage.local.set({ lang });
  }

  function t(key) {
    return I18N[currentLang][key] || I18N.en[key] || key;
  }

  // ─── DOM References ──────────────────────────────────────────────────
  const enabledToggle   = document.getElementById("enabled-toggle");
  const focusToggle     = document.getElementById("focus-toggle");
  const positionSelect  = document.getElementById("position-select");
  const statusText      = document.getElementById("status-text");
  const settingsSection = document.getElementById("settings-section");

  // ─── Initialise UI from stored settings ──────────────────────────────

  /**
   * Fetches current settings from the background worker and applies them
   * to the popup's UI controls.
   */
  async function initUI() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "getSettings" });
      if (response && response.settings) {
        applySettingsToUI(response.settings);
      }
    } catch (err) {
      console.warn("[Popup] Could not load settings:", err);
    }
  }

  /**
   * Maps a settings object → DOM control states.
   * @param {Object} s  The settings object from background.js
   */
  function applySettingsToUI(s) {
    enabledToggle.checked  = s.enabled;
    focusToggle.checked    = s.focusNewTab;
    positionSelect.value   = s.position;
    updateVisualState(s.enabled);
  }

  /**
   * Toggles the visual "enabled / disabled" appearance of the popup.
   * @param {boolean} isEnabled
   * @param {boolean} [isBusy=false]  If true, show a "working" message
   */
  function updateVisualState(isEnabled, isBusy = false) {
    if (isBusy) {
      statusText.textContent = isEnabled ? t("busyEnable") : t("busyDisable");
      statusText.classList.remove("toggle-row__hint--off");
      statusText.classList.add("toggle-row__hint--busy");
    } else if (isEnabled) {
      statusText.textContent = t("statusOn");
      statusText.classList.remove("toggle-row__hint--off");
      statusText.classList.remove("toggle-row__hint--busy");
    } else {
      statusText.textContent = t("statusOff");
      statusText.classList.add("toggle-row__hint--off");
      statusText.classList.remove("toggle-row__hint--busy");
    }

    // Grey out settings when disabled
    settingsSection.classList.toggle("settings-card--disabled", !isEnabled);
  }

  // ─── Event Handlers ──────────────────────────────────────────────────

  /**
   * Sends a partial settings update to the background worker.
   * Returns a promise that resolves when the background acknowledges.
   * @param {Object} partial  Key–value pairs to merge into settings
   * @returns {Promise}
   */
  function updateSetting(partial) {
    return chrome.runtime.sendMessage({
      type: "updateSettings",
      data: partial,
    });
  }

  /**
   * Main on/off toggle.
   * Enable/disable is instant — just flips a flag in the background worker.
   */
  enabledToggle.addEventListener("change", async () => {
    const isEnabled = enabledToggle.checked;
    updateVisualState(isEnabled);

    try {
      await updateSetting({ enabled: isEnabled });
    } catch (err) {
      console.warn("[Popup] Failed to update enabled state:", err);
    }
  });

  // Focus new tab toggle
  focusToggle.addEventListener("change", () => {
    updateSetting({ focusNewTab: focusToggle.checked });
  });

  // Tab position dropdown
  positionSelect.addEventListener("change", () => {
    updateSetting({ position: positionSelect.value });
  });

  // ─── Language Switcher ───────────────────────────────────────────────
  document.getElementById("lang-en").addEventListener("click", () => applyLang("en"));
  document.getElementById("lang-zh").addEventListener("click", () => applyLang("zh"));

  // ─── Kick off ────────────────────────────────────────────────────────
  // Restore saved language, then init UI
  chrome.storage.local.get("lang", (result) => {
    if (result.lang) applyLang(result.lang);
    initUI();
  });
});
