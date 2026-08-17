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
 *   - Show a brief loading indicator when toggling enabled/disabled,
 *     because the background worker needs time to rewrite all bookmarks
 *
 * All DOM access is wrapped in DOMContentLoaded for safety, although
 * the <script> tag is placed at the end of <body>.
 * =============================================================================
 */

document.addEventListener("DOMContentLoaded", () => {

  // ─── i18n ─────────────────────────────────────────────────────────────

  const I18N = {
    en: {
      documentTitle: "Open Bookmarks in New Tab",
      title:       "Bookmarks → New Tab",
      extEnabled:  "Extension Enabled",
      statusOn:    "Bookmarks open in a new tab",
      statusOff:   "Extension is paused",
      busyEnable:  "Enabling… updating bookmarks",
      busyDisable: "Disabling… restoring bookmarks",
      errorLoad:   "Could not read extension state. Reopen the popup.",
      errorUpdate: "Change failed. Your previous setting was restored.",
      settings:    "Settings",
      focusNewTab: "Focus new tab",
      tabPosition: "New tab position",
      posEnd:      "End of tab bar",
      posRight:    "Right of current tab",
      tip:         "Tip: You can still Ctrl/⌘+Click or middle-click bookmarks to open them in a new tab manually.",
      languageSwitch: "Language",
      langEnLabel: "Use English",
      langZhLabel: "Use Simplified Chinese",
      extensionToggleLabel: "Extension toggle",
      settingsLabel: "Settings",
      positionSelectLabel: "Choose where the new tab appears",
    },
    zh: {
      documentTitle: "在新标签页中打开书签",
      title:       "书签 → 新标签页",
      extEnabled:  "扩展已启用",
      statusOn:    "书签将在新标签页中打开",
      statusOff:   "扩展已暂停",
      busyEnable:  "正在启用…更新书签中",
      busyDisable: "正在禁用…恢复书签中",
      errorLoad:   "无法读取扩展状态。请重新打开弹窗。",
      errorUpdate: "更改失败，已恢复之前的设置。",
      settings:    "设置",
      focusNewTab: "聚焦新标签页",
      tabPosition: "新标签页位置",
      posEnd:      "标签栏末尾",
      posRight:    "当前标签页右侧",
      tip:         "提示：您仍然可以按住 Ctrl/⌘ 点击或使用鼠标中键，在新标签页中手动打开书签。",
      languageSwitch: "语言",
      langEnLabel: "使用英语",
      langZhLabel: "使用简体中文",
      extensionToggleLabel: "扩展开关",
      settingsLabel: "设置",
      positionSelectLabel: "选择新标签页的打开位置",
    },
  };

  let currentLang = "en";
  let currentEnabledState = true;
  let currentBusyState = false;
  let currentErrorKey = null;

  function applyLang(lang, persist = true) {
    currentLang = lang;
    const strings = I18N[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (strings[key] != null) el.textContent = strings[key];
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const key = el.dataset.i18nAriaLabel;
      if (strings[key] != null) el.setAttribute("aria-label", strings[key]);
    });
    // Update active button styles
    const englishButton = document.getElementById("lang-en");
    const chineseButton = document.getElementById("lang-zh");
    englishButton.classList.toggle("lang-switch__btn--active", lang === "en");
    chineseButton.classList.toggle("lang-switch__btn--active", lang === "zh");
    englishButton.setAttribute("aria-pressed", String(lang === "en"));
    chineseButton.setAttribute("aria-pressed", String(lang === "zh"));
    updateVisualState(currentEnabledState, currentBusyState);
    if (persist) chrome.storage.sync.set({ lang });
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
      if (!response?.settings) {
        throw new Error(response?.error || "The background worker did not respond.");
      }
      applySettingsToUI(response.settings);
    } catch (err) {
      console.warn("[Popup] Could not load settings:", err);
      currentErrorKey = "errorLoad";
      enabledToggle.checked = false;
      enabledToggle.disabled = true;
      updateVisualState(false);
    }
  }

  /**
   * Maps a settings object → DOM control states.
   * @param {Object} s  The settings object from background.js
   */
  function applySettingsToUI(s) {
    currentErrorKey = null;
    enabledToggle.checked  = s.enabled;
    enabledToggle.disabled = false;
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
    currentEnabledState = isEnabled;
    currentBusyState = isBusy;
    statusText.classList.remove(
      "toggle-row__hint--off",
      "toggle-row__hint--busy",
      "toggle-row__hint--error"
    );

    if (currentErrorKey && !isBusy) {
      statusText.textContent = t(currentErrorKey);
      statusText.classList.add("toggle-row__hint--error");
    } else if (isBusy) {
      statusText.textContent = isEnabled ? t("busyEnable") : t("busyDisable");
      statusText.classList.add("toggle-row__hint--busy");
    } else if (isEnabled) {
      statusText.textContent = t("statusOn");
    } else {
      statusText.textContent = t("statusOff");
      statusText.classList.add("toggle-row__hint--off");
    }

    const disableSettings = !isEnabled || isBusy;
    focusToggle.disabled = disableSettings;
    positionSelect.disabled = disableSettings;
    settingsSection.classList.toggle("settings-card--disabled", disableSettings);
    settingsSection.setAttribute("aria-disabled", String(disableSettings));
    settingsSection.setAttribute("aria-busy", String(isBusy));
    enabledToggle.setAttribute("aria-busy", String(isBusy));
  }

  // ─── Event Handlers ──────────────────────────────────────────────────

  /**
   * Sends a partial settings update to the background worker.
   * Returns a promise that resolves when the background acknowledges.
   * @param {Object} partial  Key–value pairs to merge into settings
   * @returns {Promise}
   */
  async function updateSetting(partial) {
    const response = await chrome.runtime.sendMessage({
      type: "updateSettings",
      data: partial,
    });
    if (!response || response.error) {
      throw new Error(response?.error || "The background worker did not respond.");
    }
    return response;
  }

  /**
   * Main on/off toggle.
   * Toggling enabled/disabled triggers a full bookmark rewrite in the
   * background, so we show a brief busy state and disable the toggle
   * to prevent rapid clicking.
   */
  enabledToggle.addEventListener("change", async () => {
    const isEnabled = enabledToggle.checked;
    const previousEnabled = !isEnabled;

    // Disable toggle while bookmarks are being rewritten
    currentErrorKey = null;
    enabledToggle.disabled = true;
    updateVisualState(isEnabled, true);

    try {
      const response = await updateSetting({ enabled: isEnabled });
      applySettingsToUI(response.settings);
    } catch (err) {
      console.warn("[Popup] Failed to update enabled state:", err);
      enabledToggle.checked = previousEnabled;
      currentErrorKey = "errorUpdate";
      updateVisualState(previousEnabled);
    } finally {
      enabledToggle.disabled = false;
    }
  });

  // Focus new tab toggle
  focusToggle.addEventListener("change", async () => {
    const requested = focusToggle.checked;
    try {
      const response = await updateSetting({ focusNewTab: requested });
      applySettingsToUI(response.settings);
    } catch (err) {
      console.warn("[Popup] Failed to update focus setting:", err);
      focusToggle.checked = !requested;
      currentErrorKey = "errorUpdate";
      updateVisualState(currentEnabledState);
    }
  });

  // Tab position dropdown
  positionSelect.addEventListener("change", async () => {
    const requested = positionSelect.value;
    const previous = requested === "right" ? "end" : "right";
    try {
      const response = await updateSetting({ position: requested });
      applySettingsToUI(response.settings);
    } catch (err) {
      console.warn("[Popup] Failed to update tab position:", err);
      positionSelect.value = previous;
      currentErrorKey = "errorUpdate";
      updateVisualState(currentEnabledState);
    }
  });

  // ─── Language Switcher ───────────────────────────────────────────────
  document.getElementById("lang-en").addEventListener("click", () => applyLang("en"));
  document.getElementById("lang-zh").addEventListener("click", () => applyLang("zh"));

  // ─── Kick off ────────────────────────────────────────────────────────
  // Restore saved language, then init UI
  async function loadLanguage() {
    const synced = await chrome.storage.sync.get("lang");
    if (synced.lang === "en" || synced.lang === "zh") return synced.lang;

    const local = await chrome.storage.local.get("lang");
    const migrated = local.lang === "zh" ? "zh" : "en";
    await chrome.storage.sync.set({lang: migrated});
    return migrated;
  }

  loadLanguage().then((savedLang) => {
    applyLang(savedLang, false);
    return initUI();
  }).catch((err) => {
    console.warn("[Popup] Could not initialise popup:", err);
    applyLang("en", false);
    return initUI();
  });
});
