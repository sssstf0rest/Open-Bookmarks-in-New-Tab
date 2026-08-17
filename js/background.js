/**
 * Open Bookmarks in New Tab — Manifest V3 service worker.
 *
 * Enabled HTTP(S) bookmarks receive a reversible final query marker carrying
 * a synchronized 128-bit owner, an origin-provenance flag, and a different
 * 256-bit random nonce for every bookmark. A
 * dynamic DNR rule redirects only those marked top-level navigations to the
 * local cancel.html resource. This worker serves that resource as a typed
 * HTTP 204, so Chrome keeps the source document alive and creates no download.
 * webNavigation owns the matching click and opens its clean destination once.
 */

importScripts("url-utils.js");

const UrlTools = globalThis.BookmarkUrl;
const SETTINGS_KEY = "settings";
const SYNC_STATE_KEY = "syncStateV4";
const RUNTIME_STATE_KEY = "runtimeState";
const LEGACY_BACKUP_KEY = "legacyMigrationBackupV2";
const SESSION_READY_KEY = "sessionReadyV5";
const BOOKMARK_FORMAT_VERSION = 5;
const CANCEL_RESOURCE = "cancel.html";
const CURRENT_RULE_IDS = [1, 2, 3, 4];
const DRAFT_V4_RULE_ID = 5;
const PUBLIC_V3_RULE_ID = 6;
const LEGACY_RULE_ID = 7;
const MIXED_LEGACY_RULE_IDS = [8, 9, 10, 11];
const BOOKMARK_WRITE_CONCURRENCY = 8;
const SOURCE_SNAPSHOT_TTL_MS = 15000;
const EVENT_IDENTITY_TTL_MS = 10000;
const MAX_SOURCE_SNAPSHOTS = 512;
const MAX_EVENT_IDENTITIES = 512;
const MAX_RECENT_MANAGED_URLS = 1024;
const MAX_PREVIOUS_MARKER_SECRETS = CURRENT_RULE_IDS.length - 1;
const LEGACY_BACKUP_MAX_BYTES = 2 * 1024 * 1024;
const LEGACY_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  focusNewTab: true,
  position: "end",
});

const publicV3Token = chrome.runtime.id;
const cancelUrl = chrome.runtime.getURL(CANCEL_RESOURCE);

let settings = {...DEFAULT_SETTINGS};
let navigationSettings = {...DEFAULT_SETTINGS};
let navigationEnabled = false;
let hadStoredSettings = false;
let markerSecret = null;
let acceptedMarkerSecrets = [];
let syncedLegacyCompatibility = null;
let syncedLegacyAllowAmbiguousSingle = null;
let importInProgress = false;
let legacyInterceptionEnabled = false;
let publicV3InterceptionEnabled = false;
let draftV4InterceptionEnabled = false;
let legacyCompatibilityEnabled = false;
let legacyAllowAmbiguousSingle = true;
let interceptionReadyPromise;
let maintenanceTail = Promise.resolve();

const pendingBookmarkWrites = new Map();
const deferredBookmarkUrls = new Map();
const sourceSnapshots = new Map();
const recentEventIdentities = new Map();
const inFlightNavigations = new Map();
const replacementGroupPromises = new Map();
const recentManagedUrls = new Map();
const regexSupportPromises = new Map();

// Chrome 151 treats a body-less, HTML-typed 204 as an aborted navigation; it
// neither commits cancel.html nor downloads it.
self.addEventListener("fetch", (event) => {
  if (event.request.url !== cancelUrl) return;
  event.respondWith(new Response(null, {
    status: 204,
    headers: {"Content-Type": "text/html; charset=utf-8"},
  }));
});

// ─── Settings ──────────────────────────────────────────────────────────────

function normalizeSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  return {
    enabled: typeof stored.enabled === "boolean"
      ? stored.enabled
      : DEFAULT_SETTINGS.enabled,
    focusNewTab: typeof stored.focusNewTab === "boolean"
      ? stored.focusNewTab
      : DEFAULT_SETTINGS.focusNewTab,
    position: stored.position === "right" ? "right" : "end",
  };
}

function validateSettingsPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Settings update must be an object.");
  }

  const patch = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean.");
    }
    patch.enabled = value.enabled;
  }
  if ("focusNewTab" in value) {
    if (typeof value.focusNewTab !== "boolean") {
      throw new TypeError("focusNewTab must be a boolean.");
    }
    patch.focusNewTab = value.focusNewTab;
  }
  if ("position" in value) {
    if (value.position !== "end" && value.position !== "right") {
      throw new TypeError("position must be end or right.");
    }
    patch.position = value.position;
  }
  return patch;
}

function settingsAreEqual(left, right) {
  return (
    left.enabled === right.enabled &&
    left.focusNewTab === right.focusNewTab &&
    left.position === right.position
  );
}

function isMarkerSecret(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function normalizeSyncedRuntimeState(value) {
  const stored = value && typeof value === "object" ? value : {};
  const currentSecret = isMarkerSecret(stored.markerSecret)
    ? stored.markerSecret
    : null;
  const previousMarkerSecrets = Array.isArray(stored.previousMarkerSecrets)
    ? [...new Set(stored.previousMarkerSecrets.filter(isMarkerSecret))]
      .filter((secret) => secret !== currentSecret)
      .slice(0, MAX_PREVIOUS_MARKER_SECRETS)
    : [];
  return {
    markerSecret: currentSecret,
    previousMarkerSecrets,
    legacyCompatibilityEnabled:
      typeof stored.legacyCompatibilityEnabled === "boolean"
        ? stored.legacyCompatibilityEnabled
        : null,
    legacyAllowAmbiguousSingle:
      typeof stored.legacyAllowAmbiguousSingle === "boolean"
        ? stored.legacyAllowAmbiguousSingle
        : null,
  };
}

function applySyncedRuntimeState(value) {
  const normalized = normalizeSyncedRuntimeState(value);
  const priorSecret = markerSecret;
  const knownSecrets = [...new Set([
    ...(normalized.markerSecret ? [normalized.markerSecret] : []),
    ...normalized.previousMarkerSecrets,
    ...(isMarkerSecret(priorSecret) ? [priorSecret] : []),
  ])].sort();
  // storage.sync has no compare-and-swap. Choosing the lowest observed random
  // owner makes simultaneous first installs converge instead of ping-ponging.
  markerSecret = knownSecrets[0] || generateRandomHex(16);
  acceptedMarkerSecrets = [
    markerSecret,
    ...knownSecrets.filter((secret) => secret !== markerSecret),
  ].slice(0, CURRENT_RULE_IDS.length);
  syncedLegacyCompatibility = normalized.legacyCompatibilityEnabled;
  syncedLegacyAllowAmbiguousSingle = normalized.legacyAllowAmbiguousSingle;
  return normalized;
}

async function persistSyncedRuntimeState() {
  await chrome.storage.sync.set({
    [SYNC_STATE_KEY]: {
      markerSecret,
      previousMarkerSecrets: acceptedMarkerSecrets
        .filter((secret) => secret !== markerSecret)
        .slice(0, MAX_PREVIOUS_MARKER_SECRETS),
      legacyCompatibilityEnabled,
      legacyAllowAmbiguousSingle,
    },
  });
}

async function readSyncedSettings() {
  const synced = await chrome.storage.sync.get(SETTINGS_KEY);
  return synced[SETTINGS_KEY]
    ? normalizeSettings(synced[SETTINGS_KEY])
    : null;
}

async function loadSettings() {
  await chrome.storage.sync.setAccessLevel?.({
    accessLevel: "TRUSTED_CONTEXTS",
  });

  const [synced, local] = await Promise.all([
    chrome.storage.sync.get([SETTINGS_KEY, SYNC_STATE_KEY]),
    chrome.storage.local.get(SETTINGS_KEY),
  ]);
  const storedSettings = synced[SETTINGS_KEY] || local[SETTINGS_KEY];
  hadStoredSettings = Boolean(storedSettings);
  settings = normalizeSettings(storedSettings);
  navigationSettings = {...settings};
  const normalizedSyncState = applySyncedRuntimeState(
    synced[SYNC_STATE_KEY]
  );

  // Versions through 2.3 synchronized these preferences. Keep sync canonical
  // so devices that share bookmark mutations cannot disagree about enabled
  // state. The local copy was written only by an unreleased 2.4 draft.
  const syncPatch = {};
  if (
    !synced[SETTINGS_KEY] ||
    !settingsAreEqual(normalizeSettings(synced[SETTINGS_KEY]), settings)
  ) {
    syncPatch[SETTINGS_KEY] = settings;
  }
  if (local[SETTINGS_KEY]) {
    await chrome.storage.local.remove(SETTINGS_KEY);
  }
  if (!normalizedSyncState.markerSecret) {
    // Write fresh-install provenance in the same storage operation as default
    // settings. A second concurrently installed device must not mistake those
    // new defaults for evidence of a released 2.3 profile.
    const legacyProfile = hadStoredSettings;
    syncedLegacyCompatibility = legacyProfile;
    syncedLegacyAllowAmbiguousSingle = legacyProfile;
    syncPatch[SYNC_STATE_KEY] = {
      markerSecret,
      previousMarkerSecrets: acceptedMarkerSecrets.slice(1),
      legacyCompatibilityEnabled: legacyProfile,
      legacyAllowAmbiguousSingle: legacyProfile,
    };
  }
  if (Object.keys(syncPatch).length > 0) {
    await chrome.storage.sync.set(syncPatch);
  }
  return settings;
}

async function synchronizeSettingsFromStorage() {
  const latest = await readSyncedSettings();
  return latest || settings;
}

// ─── Navigation Rules ──────────────────────────────────────────────────────

function currentRule(ownerSecret, ruleId) {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {extensionPath: `/${CANCEL_RESOURCE}`},
    },
    condition: {
      regexFilter: UrlTools.markerRegexFilter(ownerSecret),
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
    },
  };
}

function draftV4Rule() {
  return {
    id: DRAFT_V4_RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {extensionPath: `/${CANCEL_RESOURCE}`},
    },
    condition: {
      regexFilter: UrlTools.draftV4RegexFilter(),
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
    },
  };
}

function publicV3Rule() {
  return {
    id: PUBLIC_V3_RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {extensionPath: `/${CANCEL_RESOURCE}`},
    },
    condition: {
      regexFilter:
        `\\?([^#]*&)?${UrlTools.V3_MARKER_PARAMETER}=` +
        `${publicV3Token}(#.*)?$`,
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
    },
  };
}

function legacyRule() {
  return {
    id: LEGACY_RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {extensionPath: `/${CANCEL_RESOURCE}`},
    },
    condition: {
      regexFilter: "^https?://newtab(?:@|%40)",
      isUrlFilterCaseSensitive: false,
      resourceTypes: ["main_frame"],
    },
  };
}

function mixedLegacyWrapperRule(ownerSecret, ruleId) {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {extensionPath: `/${CANCEL_RESOURCE}`},
    },
    condition: {
      // Released 2.3 versions wrap Gmail and similar destinations in this
      // exact GitHub Pages URL. Requiring an encoded, installation-owned marker
      // keeps the compatibility rule from intercepting arbitrary redirects.
      // A urlFilter avoids Chrome's 2 KB compiled-RE2 limit for long fixed
      // wrapper patterns. Exact bookmark verification still gates tab opens.
      urlFilter:
        "sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/" +
        "redirect.html?url=*" +
        `${UrlTools.MARKER_PARAMETER}%3D${ownerSecret}_`,
      isUrlFilterCaseSensitive: false,
      requestDomains: ["sssstf0rest.github.io"],
      resourceTypes: ["main_frame"],
    },
  };
}

async function assertRuleRegexSupported(rule) {
  const regex = rule.condition.regexFilter;
  if (!regex || typeof chrome.declarativeNetRequest.isRegexSupported !== "function") {
    return;
  }
  let supportPromise = regexSupportPromises.get(regex);
  if (!supportPromise) {
    supportPromise = chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
      requireCapturing: false,
    });
    regexSupportPromises.set(regex, supportPromise);
  }
  const support = await supportPromise;
  if (!support?.isSupported) {
    throw new Error(
      `Chrome rejected navigation regex: ${support?.reason || "unknown reason"}`
    );
  }
}

async function setNavigationRules(
  enabled,
  includeLegacy = false,
  allowAmbiguousSingle = true,
  includePublicV3 = false,
  includeDraftV4 = false
) {
  const addRules = enabled
    ? [
      ...acceptedMarkerSecrets.map((secret, index) => (
        currentRule(secret, CURRENT_RULE_IDS[index])
      )),
      ...acceptedMarkerSecrets.map((secret, index) => (
        mixedLegacyWrapperRule(secret, MIXED_LEGACY_RULE_IDS[index])
      )),
      ...(includeDraftV4 ? [draftV4Rule()] : []),
      ...(includePublicV3 ? [publicV3Rule()] : []),
      ...(includeLegacy ? [legacyRule()] : []),
    ]
    : [];

  await Promise.all(addRules.map(assertRuleRegexSupported));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [
      ...CURRENT_RULE_IDS,
      ...MIXED_LEGACY_RULE_IDS,
      DRAFT_V4_RULE_ID,
      PUBLIC_V3_RULE_ID,
      LEGACY_RULE_ID,
    ],
    addRules,
  });
  legacyInterceptionEnabled = enabled && includeLegacy;
  publicV3InterceptionEnabled = enabled && includePublicV3;
  draftV4InterceptionEnabled = enabled && includeDraftV4;
  legacyAllowAmbiguousSingle = allowAmbiguousSingle;
}

// ─── Bookmark Transformation and Migration ────────────────────────────────

function collectBookmarkNodes(tree) {
  const bookmarks = [];
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.children) stack.push(...node.children);
    if (node.url && !node.unmodifiable) bookmarks.push(node);
  }
  return bookmarks;
}

async function writeBookmarkUrl(id, currentUrl, nextUrl) {
  if (nextUrl === currentUrl) return false;

  rememberManagedUrl(currentUrl);
  pendingBookmarkWrites.set(id, nextUrl);
  try {
    await chrome.bookmarks.update(id, {url: nextUrl});
    setTimeout(() => {
      if (pendingBookmarkWrites.get(id) === nextUrl) {
        pendingBookmarkWrites.delete(id);
      }
    }, 5000);
    return true;
  } catch (error) {
    if (pendingBookmarkWrites.get(id) === nextUrl) {
      pendingBookmarkWrites.delete(id);
    }
    throw error;
  }
}

async function transformBookmarkNodes(nodes, transform) {
  let cursor = 0;
  let changed = 0;
  const failures = [];

  async function worker() {
    while (cursor < nodes.length) {
      const node = nodes[cursor];
      cursor += 1;
      try {
        // Re-read just before writing so a recent user/sync edit is not lost.
        const [latest] = await chrome.bookmarks.get(node.id);
        if (!latest?.url || latest.unmodifiable) continue;
        const nextUrl = transform(latest.url, latest);
        if (await writeBookmarkUrl(node.id, latest.url, nextUrl)) changed += 1;
      } catch (error) {
        if (String(error?.message || error).includes("Bookmark not found")) {
          continue;
        }
        failures.push({id: node.id, error});
      }
    }
  }

  const workerCount = Math.min(BOOKMARK_WRITE_CONCURRENCY, nodes.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  if (failures.length > 0) {
    throw new Error(
      `Could not update ${failures.length} bookmark(s): ` +
      failures.map(({id}) => id).join(", ")
    );
  }
  return {examined: nodes.length, changed};
}

async function transformAllBookmarks(transform) {
  const tree = await chrome.bookmarks.getTree();
  return transformBookmarkNodes(collectBookmarkNodes(tree), transform);
}

async function transformBookmarkById(id, transform) {
  let nodes;
  try {
    nodes = await chrome.bookmarks.get(id);
  } catch (error) {
    console.warn("[Bookmarks→NewTab] Could not read bookmark", id, error);
    return false;
  }

  const bookmark = nodes[0];
  if (!bookmark?.url || bookmark.unmodifiable) return false;
  // The fresh read is authoritative. Replaying an older onChanged payload can
  // otherwise overwrite a newer user or sync edit after a worker restart.
  const nextUrl = transform(bookmark.url, bookmark);
  return writeBookmarkUrl(id, bookmark.url, nextUrl);
}

async function updateRuntimeState(patch) {
  const stored = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  const current = stored[RUNTIME_STATE_KEY] || {};
  await chrome.storage.local.set({
    [RUNTIME_STATE_KEY]: {...current, ...patch},
  });
}

function generateRandomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateMarkerCapability(mode = "m") {
  if (mode !== "m" && mode !== "p") {
    throw new TypeError("Unknown marker provenance mode.");
  }
  return `${markerSecret}_${mode}_${generateRandomHex(32)}`;
}

function isAcceptedMarker(marker) {
  return Boolean(marker && acceptedMarkerSecrets.includes(marker.owner));
}

function pruneRecentManagedUrls(now = Date.now()) {
  for (const [url, observedAt] of recentManagedUrls) {
    if (now - observedAt >= SOURCE_SNAPSHOT_TTL_MS) {
      recentManagedUrls.delete(url);
    }
  }
  pruneBoundedMap(recentManagedUrls, MAX_RECENT_MANAGED_URLS);
}

function rememberManagedUrl(url) {
  if (!UrlTools.isSupportedUrl(url)) return;
  pruneRecentManagedUrls();
  recentManagedUrls.set(url, Date.now());
  pruneBoundedMap(recentManagedUrls, MAX_RECENT_MANAGED_URLS);
}

function legacyOriginal(url, allowAmbiguousSingle) {
  return UrlTools.getLegacyOriginalUrl(url, {allowAmbiguousSingle});
}

function markerModeForRawUrl(url) {
  return /^https?:\/\/newtab(?:@|%40)/i.test(url) ? "p" : "m";
}

function ensureEnabledMarker(url, options = {}) {
  if (!UrlTools.isSupportedUrl(url)) return url;

  const allowLegacy = options.allowLegacy === true;
  const allowAmbiguousSingle = options.allowAmbiguousSingle !== false;
  const marker = UrlTools.readMarker(url);
  if (marker?.owner === markerSecret) return url;

  let sourceUrl = url;
  if (isAcceptedMarker(marker)) {
    const recovered = UrlTools.unwrapManagedUrl(url, {
      acceptedMarkerSecrets,
    }) || marker.originalUrl;
    return UrlTools.markUrl(
      recovered,
      generateMarkerCapability(marker.mode)
    );
  } else if (options.allowDraftV4) {
    const draftMarker = UrlTools.readDraftV4Marker(url);
    if (draftMarker) sourceUrl = draftMarker.originalUrl;
  }

  // A still-running 2.3 device may place its exact redirect wrapper outside
  // an authenticated v4 marker (notably for Gmail). Normalize that safe mixed
  // form even after broad legacy migration has ended.
  const safeLegacyTarget = legacyOriginal(url, false);
  const nestedMarker = UrlTools.readMarker(safeLegacyTarget);
  if (isAcceptedMarker(nestedMarker)) {
    // Preserve the wrapper while a synchronized 2.3 device may still be
    // running. Rewriting it to the direct destination makes 2.3 immediately
    // wrap it again, causing an endless cross-device write loop. Owner-scoped
    // wrapper interception and pause-time unwrapping handle this form safely.
    return url;
  }
  if (!options.schemaMigration && UrlTools.readLegacyRedirectTarget(url)) {
    // The released Gmail/Outlook wrapper host and path are unambiguous. Keep
    // the wrapper itself stable for a 2.3 peer, but authenticate it with `m`
    // so clicks and Pause recover the encoded clean destination locally.
    return UrlTools.markUrl(url, generateMarkerCapability("m"));
  }

  if (options.schemaMigration) {
    const restored = UrlTools.unwrapManagedUrl(sourceUrl, {
      acceptedMarkerSecrets,
      allowLegacy,
      allowAmbiguousSingle,
      allowDraftV4: options.allowDraftV4,
      v3MarkerToken: publicV3Token,
    }) || sourceUrl;
    return UrlTools.markUrl(restored, generateMarkerCapability("m"));
  }

  if (allowLegacy) {
    const recovered = legacyOriginal(sourceUrl, allowAmbiguousSingle);
    if (recovered) {
      // A 2.3 device may wrap a v4 Gmail bookmark. Leaving that wrapper
      // untouched prevents two synchronized devices from rewriting forever.
      const recoveredMarker = UrlTools.readMarker(recovered);
      if (recoveredMarker?.owner === markerSecret) return sourceUrl;
      if (isAcceptedMarker(recoveredMarker)) {
        return UrlTools.markUrl(
          recoveredMarker.originalUrl,
          generateMarkerCapability(recoveredMarker.mode)
        );
      }
      const recoveredV3 = UrlTools.getV3OriginalUrl(
        recovered,
        publicV3Token
      );
      if (recoveredV3) {
        return UrlTools.markUrl(recoveredV3, generateMarkerCapability("m"));
      }
    }

    const directV3 = UrlTools.getV3OriginalUrl(sourceUrl, publicV3Token);
    if (directV3) {
      return UrlTools.markUrl(directV3, generateMarkerCapability("m"));
    }
  }

  // Preserve a released legacy layer from a still-running 2.3 device and put
  // an authenticated v4 capability outside it. The navigation path unwraps both.
  return UrlTools.markUrl(
    sourceUrl,
    generateMarkerCapability(markerModeForRawUrl(sourceUrl))
  );
}

function restoreManagedUrl(url, options = {}) {
  return UrlTools.unwrapManagedUrl(url, {
    acceptedMarkerSecrets,
    allowLegacy: options.allowLegacy === true,
    allowAmbiguousSingle: options.allowAmbiguousSingle,
    allowDraftV4: options.allowDraftV4,
    v3MarkerToken: options.allowPublicV3 ? publicV3Token : null,
  }) || url;
}

async function backupMigrationCandidates(
  nodes,
  allowAmbiguousSingle,
  allowDraftV4
) {
  const candidates = nodes
    .filter((node) => (
      (allowDraftV4 && UrlTools.readDraftV4Marker(node.url)) ||
      UrlTools.getV3OriginalUrl(node.url, publicV3Token) ||
      legacyOriginal(node.url, allowAmbiguousSingle)
    ))
    .map((node) => ({id: node.id, url: node.url}));
  if (candidates.length === 0) {
    return {count: 0, truncated: false, storageFailed: false};
  }

  let storedBackup;
  try {
    const existing = await chrome.storage.local.get(LEGACY_BACKUP_KEY);
    storedBackup = existing[LEGACY_BACKUP_KEY];
  } catch (error) {
    console.warn("[Bookmarks→NewTab] Could not read migration backup", error);
  }

  const createdAt = storedBackup?.createdAt || new Date().toISOString();
  const allEntries = [
    ...(Array.isArray(storedBackup?.entries) ? storedBackup.entries : []),
    ...candidates,
  ];
  const recorded = new Set();
  const entries = [];
  let truncated = Boolean(storedBackup?.truncated);
  let approximateBytes = new TextEncoder().encode(JSON.stringify({
    createdAt,
    candidateCount: allEntries.length,
    truncated: false,
    entries: [],
  })).length;

  for (const entry of allEntries) {
    const key = `${entry.id}\n${entry.url}`;
    if (recorded.has(key)) continue;
    const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (approximateBytes + entryBytes > LEGACY_BACKUP_MAX_BYTES) {
      truncated = true;
      continue;
    }
    entries.push(entry);
    recorded.add(key);
    approximateBytes += entryBytes;
  }

  const backup = {
    createdAt,
    candidateCount: candidates.length,
    truncated,
    entries,
  };
  try {
    await chrome.storage.local.set({[LEGACY_BACKUP_KEY]: backup});
    return {count: entries.length, truncated, storageFailed: false};
  } catch (error) {
    // Recovery metadata is valuable, but failure to store it must never leave
    // users permanently unable to pause or update the extension.
    console.warn("[Bookmarks→NewTab] Could not store migration backup", error);
    return {count: 0, truncated: true, storageFailed: true};
  }
}

async function cleanupExpiredLegacyBackup() {
  const stored = await chrome.storage.local.get([
    LEGACY_BACKUP_KEY,
    RUNTIME_STATE_KEY,
  ]);
  if (
    stored[RUNTIME_STATE_KEY]?.migrationMode === "legacy" ||
    stored[RUNTIME_STATE_KEY]?.pendingOperation?.type === "schemaMigration"
  ) return;
  const backup = stored[LEGACY_BACKUP_KEY];
  if (!backup?.createdAt) return;

  const createdAt = Date.parse(backup.createdAt);
  if (
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= LEGACY_BACKUP_RETENTION_MS
  ) {
    await chrome.storage.local.remove(LEGACY_BACKUP_KEY);
  }
}

async function performReconciliation(targetSettings, options = {}) {
  const stored = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  const priorState = stored[RUNTIME_STATE_KEY] || {};
  const schemaMigration = options.schemaMigration === true;
  const allowDraftV4 = options.allowDraftV4 === true;
  const allowPublicV3 = options.allowPublicV3 === true;
  const allowLegacy = options.allowLegacy === true;
  const allowAmbiguousSingle = options.allowAmbiguousSingle !== false;
  const desiredState = targetSettings.enabled ? "enabled" : "disabled";

  await updateRuntimeState({
    pendingOperation: {
      type: schemaMigration ? "schemaMigration" : "reconcile",
      targetEnabled: targetSettings.enabled,
      targetSettings,
      includeLegacy: allowLegacy,
      allowAmbiguousSingle,
      allowDraftV4,
      allowPublicV3,
      startedAt: new Date().toISOString(),
    },
  });

  if (options.persistSettings) {
    await chrome.storage.sync.set({[SETTINGS_KEY]: targetSettings});
  }

  navigationSettings = {...targetSettings};
  // While disabling, bookmarks and cancellation rules are removed in that
  // order. Until both finish, owned markers must retain new-tab behavior.
  navigationEnabled = true;
  await setNavigationRules(
    true,
    allowLegacy,
    allowAmbiguousSingle,
    allowPublicV3,
    allowDraftV4
  );

  let backup = {count: 0, truncated: false, storageFailed: false};
  if (schemaMigration) {
    const tree = await chrome.bookmarks.getTree();
    const nodes = collectBookmarkNodes(tree);
    backup = await backupMigrationCandidates(
      nodes,
      allowAmbiguousSingle,
      allowDraftV4
    );
  }

  const transform = targetSettings.enabled
    ? (url) => ensureEnabledMarker(url, {
      allowLegacy,
      allowAmbiguousSingle,
      allowDraftV4,
      schemaMigration,
    })
    : (url) => restoreManagedUrl(url, {
      allowLegacy,
      allowAmbiguousSingle,
      allowDraftV4,
      allowPublicV3,
    });
  const result = await transformAllBookmarks(transform);

  if (targetSettings.enabled) {
    await setNavigationRules(
      true,
      false,
      allowAmbiguousSingle,
      false,
      false
    );
  } else {
    await setNavigationRules(
      false,
      false,
      allowAmbiguousSingle,
      false,
      false
    );
  }

  settings = {...targetSettings};
  navigationSettings = {...targetSettings};
  navigationEnabled = targetSettings.enabled;
  await updateRuntimeState({
    bookmarkFormatVersion: BOOKMARK_FORMAT_VERSION,
    bookmarkState: desiredState,
    legacyCompatibilityEnabled,
    markerSecretApplied: markerSecret,
    migrationMode: null,
    migrationAllowAmbiguousSingle: null,
    pendingOperation: null,
    legacyBackupCount: schemaMigration
      ? backup.count
      : priorState.legacyBackupCount,
    legacyBackupTruncated: schemaMigration
      ? backup.truncated
      : priorState.legacyBackupTruncated,
  });
  await chrome.storage.session?.set({[SESSION_READY_KEY]: true});
  return result;
}

function reconciliationContext(runtimeState) {
  const schemaMigration = (
    (runtimeState.bookmarkFormatVersion || 0) < BOOKMARK_FORMAT_VERSION ||
    runtimeState.pendingOperation?.type === "schemaMigration" ||
    runtimeState.migrationMode === "legacy"
  );
  const allowDraftV4 = Boolean(
    runtimeState.bookmarkFormatVersion === 4 ||
    runtimeState.pendingOperation?.allowDraftV4
  );
  const allowPublicV3 = Boolean(
    runtimeState.bookmarkFormatVersion === 3 ||
    runtimeState.pendingOperation?.allowPublicV3 ||
    runtimeState.migrationMode === "legacy"
  );
  const allowAmbiguousSingle =
    typeof runtimeState.migrationAllowAmbiguousSingle === "boolean"
      ? runtimeState.migrationAllowAmbiguousSingle
      : legacyAllowAmbiguousSingle;
  return {
    allowAmbiguousSingle,
    allowDraftV4,
    allowPublicV3,
    schemaMigration,
  };
}

async function applyConfiguredState(force = false) {
  const stored = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  const runtimeState = stored[RUNTIME_STATE_KEY] || {};
  const context = reconciliationContext(runtimeState);
  const desiredState = settings.enabled ? "enabled" : "disabled";
  if (
    !force &&
    !context.schemaMigration &&
    !runtimeState.pendingOperation &&
    runtimeState.bookmarkState === desiredState
  ) {
    navigationEnabled = settings.enabled;
    navigationSettings = {...settings};
    return {examined: 0, changed: 0};
  }

  return performReconciliation(settings, {
    ...context,
    allowLegacy: context.schemaMigration && legacyCompatibilityEnabled,
    force,
  });
}

async function transitionToSettings(targetSettings, options = {}) {
  const normalizedTarget = normalizeSettings(targetSettings);
  const stored = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  const runtimeState = stored[RUNTIME_STATE_KEY] || {};
  const context = reconciliationContext(runtimeState);

  // A failed/interrupted schema pass must not be overwritten by an ordinary
  // toggle journal. In particular, Pause must restore any mix of released,
  // draft, and current markers rather than declaring a partial tree complete.
  if (context.schemaMigration || runtimeState.pendingOperation) {
    return performReconciliation(normalizedTarget, {
      ...context,
      allowLegacy: context.schemaMigration && legacyCompatibilityEnabled,
      persistSettings: options.persistSettings,
    });
  }

  const enabledChanged = normalizedTarget.enabled !== settings.enabled;
  if (!enabledChanged && !options.force) {
    if (options.persistSettings) {
      await chrome.storage.sync.set({[SETTINGS_KEY]: normalizedTarget});
    }
    settings = {...normalizedTarget};
    navigationSettings = {...normalizedTarget};
    navigationEnabled = normalizedTarget.enabled;
    return {examined: 0, changed: 0};
  }

  return performReconciliation(normalizedTarget, {
    allowAmbiguousSingle: legacyAllowAmbiguousSingle,
    allowLegacy: false,
    persistSettings: options.persistSettings,
    schemaMigration: false,
  });
}

// ─── Exact Source Tracking ─────────────────────────────────────────────────

function pruneBoundedMap(map, maxSize) {
  while (map.size > maxSize) {
    map.delete(map.keys().next().value);
  }
}

function pruneSourceSnapshots(now = Date.now()) {
  for (const [tabId, snapshot] of sourceSnapshots) {
    if (now - snapshot.observedAt >= SOURCE_SNAPSHOT_TTL_MS) {
      sourceSnapshots.delete(tabId);
    }
  }
  pruneBoundedMap(sourceSnapshots, MAX_SOURCE_SNAPSHOTS);
}

function isPotentiallyManagedUrl(url) {
  return Boolean(
    UrlTools.readMarker(url) ||
    UrlTools.readDraftV4Marker(url) ||
    UrlTools.getV3OriginalUrl(url, publicV3Token) ||
    (typeof url === "string" && /^https?:\/\/newtab(?:@|%40)/i.test(url))
  );
}

function rememberTab(tab, extras = {}, includeUrlFields = true) {
  if (!tab || !Number.isInteger(tab.id)) return null;
  const now = Date.now();
  pruneSourceSnapshots(now);
  const existing = sourceSnapshots.get(tab.id) || {id: tab.id};
  const next = {...existing, observedAt: now, ...extras};
  const fields = [
    "active",
    "groupId",
    "index",
    "openerTabId",
    "pinned",
    "splitViewId",
    "windowId",
  ];
  if (includeUrlFields) fields.push("pendingUrl", "url");
  for (const field of fields) {
    if (tab[field] !== undefined) next[field] = tab[field];
  }
  if (!extras.removedAt) {
    next.removedAt = null;
    next.windowClosing = false;
  }
  sourceSnapshots.set(tab.id, next);
  pruneBoundedMap(sourceSnapshots, MAX_SOURCE_SNAPSHOTS);
  return {...next};
}

function cachedSource(tabId) {
  pruneSourceSnapshots();
  const snapshot = sourceSnapshots.get(tabId);
  return snapshot ? {...snapshot} : null;
}

function beginSourceCapture(tabId) {
  const cached = cachedSource(tabId);
  const livePromise = chrome.tabs.get(tabId).then((tab) => {
    return rememberTab(tab);
  }).catch(() => cachedSource(tabId) || cached);
  return {cached, livePromise};
}

function isNewTabPage(url) {
  if (typeof url !== "string") return false;
  const lower = url.toLowerCase();
  return (
    lower === "" ||
    lower === "about:blank" ||
    lower.startsWith("chrome://newtab") ||
    lower.startsWith("chrome://new-tab-page") ||
    lower.startsWith("edge://newtab")
  );
}

function canReuseExactSource(source, markedUrl) {
  if (!source || source.windowClosing) return false;
  const isRecentTransient = (
    Number.isFinite(source.createdAt) &&
    Date.now() - source.createdAt < SOURCE_SNAPSHOT_TTL_MS &&
    source.pendingUrl === markedUrl &&
    (source.url === undefined || source.url === "")
  );
  if (!isNewTabPage(source.url) && !isRecentTransient) return false;
  return (
    !source.pendingUrl ||
    source.pendingUrl === markedUrl ||
    source.pendingUrl === cancelUrl
  );
}

async function refreshSource(source, tabId) {
  try {
    return rememberTab(await chrome.tabs.get(tabId));
  } catch {
    return cachedSource(tabId) || source;
  }
}

// ─── Destination Creation ──────────────────────────────────────────────────

async function createTabWithContext(createOptions, source) {
  try {
    const created = await chrome.tabs.create(createOptions);
    rememberTab(created, {createdAt: Date.now()}, false);
    return created;
  } catch (error) {
    const latest = source?.id !== undefined ? cachedSource(source.id) : null;
    if (source?.windowClosing || latest?.windowClosing) return null;

    // The source window may have closed between tabs.get and tabs.create.
    // Retry once without active/current-tab lookup; Chrome selects a remaining
    // normal window and no unrelated existing tab is overwritten.
    if (createOptions.windowId !== undefined) {
      const fallback = {...createOptions};
      delete fallback.windowId;
      delete fallback.index;
      try {
        const created = await chrome.tabs.create(fallback);
        rememberTab(created, {createdAt: Date.now()}, false);
        return created;
      } catch (fallbackError) {
        console.warn(
          "[Bookmarks→NewTab] Could not create destination tab",
          fallbackError
        );
        return null;
      }
    }

    console.warn("[Bookmarks→NewTab] Could not create destination tab", error);
    return null;
  }
}

async function restoreReplacementGroup(tabId, oldGroupId) {
  if (!Number.isInteger(oldGroupId) || oldGroupId < 0) return;
  if (typeof chrome.tabs.group !== "function") return;

  try {
    await chrome.tabs.group({tabIds: tabId, groupId: oldGroupId});
    return;
  } catch {
    // Chrome may remove an empty group before replacement tabs are created.
  }

  let groupPromise = replacementGroupPromises.get(oldGroupId);
  if (!groupPromise) {
    groupPromise = chrome.tabs.group({tabIds: tabId});
    replacementGroupPromises.set(oldGroupId, groupPromise);
    setTimeout(() => {
      if (replacementGroupPromises.get(oldGroupId) === groupPromise) {
        replacementGroupPromises.delete(oldGroupId);
      }
    }, SOURCE_SNAPSHOT_TTL_MS);
    try {
      await groupPromise;
    } catch {
      replacementGroupPromises.delete(oldGroupId);
    }
    return;
  }

  try {
    const replacementGroupId = await groupPromise;
    await chrome.tabs.group({tabIds: tabId, groupId: replacementGroupId});
  } catch {
    // Group restoration is best-effort; the destination tab remains valid.
  }
}

async function createReplacement(destinationUrl, source, navigationSettings) {
  const latest = source?.id !== undefined ? cachedSource(source.id) : null;
  const context = latest || source;
  if (context?.windowClosing) return null;

  const createOptions = {
    url: destinationUrl,
    active: context?.active === true || navigationSettings.focusNewTab,
  };
  if (Number.isInteger(context?.windowId)) {
    createOptions.windowId = context.windowId;
  }
  // This tab replaces a vanished source, so its old index wins over the
  // normal end/right preference.
  if (Number.isInteger(context?.index) && context.index >= 0) {
    createOptions.index = context.index;
  }

  const created = await createTabWithContext(createOptions, context);
  if (created?.id !== undefined) {
    await restoreReplacementGroup(created.id, context?.groupId);
  }
  return created;
}

async function updateExactSourceOrReplace(
  sourceTabId,
  destinationUrl,
  source,
  navSettings
) {
  try {
    const updated = await chrome.tabs.update(sourceTabId, {
      url: destinationUrl,
    });
    rememberTab(updated);
    return updated;
  } catch {
    const latest = cachedSource(sourceTabId) || source;
    if (latest?.windowClosing) return null;
    // Fast-path reuse intentionally skips storage. Only a lost-tab fallback
    // waits for settings so a cold worker still honors the focus preference.
    await waitForInterceptionState();
    return createReplacement(
      destinationUrl,
      latest,
      navSettings
    );
  }
}

async function createNormalDestination(destinationUrl, source, navSettings) {
  const createOptions = {
    url: destinationUrl,
    active: navSettings.focusNewTab,
  };
  if (Number.isInteger(source?.windowId)) {
    createOptions.windowId = source.windowId;
  }
  if (
    navSettings.position === "right" &&
    Number.isInteger(source?.index) &&
    source.index >= 0
  ) {
    createOptions.index = source.index + 1;
  }
  return createTabWithContext(createOptions, source);
}

// ─── Single Navigation Owner ───────────────────────────────────────────────

async function exactBookmarkExists(markedUrl) {
  try {
    const matches = await chrome.bookmarks.search({url: markedUrl});
    if (matches.some((bookmark) => bookmark.url === markedUrl)) return true;
    pruneRecentManagedUrls();
    return recentManagedUrls.has(markedUrl);
  } catch (error) {
    console.warn(
      "[Bookmarks→NewTab] Could not verify bookmark navigation",
      error
    );
    return false;
  }
}

async function waitForInterceptionState() {
  try {
    await interceptionReadyPromise;
    return true;
  } catch (error) {
    console.error("[Bookmarks→NewTab] Runtime initialization failed", error);
    return false;
  }
}

async function persistedRuleOwnsMarker(marker) {
  if (!marker) return false;
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.some((rule) => (
      CURRENT_RULE_IDS.includes(rule.id) &&
      rule.condition?.regexFilter?.includes(
        `${UrlTools.MARKER_PARAMETER}=${marker.owner}_`
      )
    ));
  } catch {
    return false;
  }
}

async function handleMarkedNavigation(
  details,
  markerCandidates,
  capture
) {
  const verificationPromise = exactBookmarkExists(details.url);
  const sourcePromise = capture.livePromise;
  const stateReady = await waitForInterceptionState();
  const acceptedCurrent = isAcceptedMarker(markerCandidates.current);
  const persistedCurrent = !stateReady && await persistedRuleOwnsMarker(
    markerCandidates.current
  );
  const recognizedCurrent = acceptedCurrent || persistedCurrent;
  const ownedCurrent = stateReady && acceptedCurrent;
  const safeMixedOriginal = stateReady
    ? UrlTools.unwrapManagedUrl(details.url, {acceptedMarkerSecrets})
    : null;

  let originalUrl = null;
  if (ownedCurrent) {
    originalUrl = UrlTools.unwrapManagedUrl(details.url, {
      acceptedMarkerSecrets,
      allowLegacy: stateReady && legacyInterceptionEnabled,
      allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      allowDraftV4: draftV4InterceptionEnabled,
      v3MarkerToken: stateReady && publicV3InterceptionEnabled
        ? publicV3Token
        : null,
    }) || markerCandidates.current.originalUrl;
  } else if (
    markerCandidates.draftV4 &&
    stateReady &&
    draftV4InterceptionEnabled
  ) {
    originalUrl = UrlTools.unwrapManagedUrl(details.url, {
      acceptedMarkerSecrets,
      allowDraftV4: true,
      allowLegacy: legacyInterceptionEnabled,
      allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      v3MarkerToken: publicV3InterceptionEnabled ? publicV3Token : null,
    }) || markerCandidates.draftV4.originalUrl;
  } else if (
    markerCandidates.publicV3 &&
    stateReady &&
    publicV3InterceptionEnabled
  ) {
    originalUrl = UrlTools.unwrapManagedUrl(details.url, {
      acceptedMarkerSecrets,
      allowLegacy: legacyInterceptionEnabled,
      allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      v3MarkerToken: publicV3Token,
    }) || markerCandidates.publicV3;
  } else if (
    markerCandidates.legacy &&
    stateReady &&
    (legacyInterceptionEnabled || safeMixedOriginal)
  ) {
    originalUrl = safeMixedOriginal || UrlTools.unwrapManagedUrl(details.url, {
      acceptedMarkerSecrets,
      allowLegacy: true,
      allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      v3MarkerToken: publicV3InterceptionEnabled ? publicV3Token : null,
    }) || markerCandidates.legacy;
  }

  // A dynamic rule survives worker restarts. If initialization fails after
  // that persisted owner-specific rule cancels a click, recover only the
  // marker proven by the installed rule rather than leaving the bookmark dead.
  if (!originalUrl && !stateReady && recognizedCurrent) {
    originalUrl = UrlTools.unwrapManagedUrl(details.url, {
      acceptedMarkerSecrets: [markerCandidates.current.owner],
    }) || markerCandidates.current.originalUrl;
  }
  if (!originalUrl || !UrlTools.isSupportedUrl(originalUrl)) return;

  let source = await sourcePromise;
  const effectiveSettings = {...navigationSettings};
  if (
    recognizedCurrent &&
    canReuseExactSource(source, details.url)
  ) {
    if (!stateReady && !persistedCurrent) {
      try {
        const updated = await chrome.tabs.update(details.tabId, {
          url: originalUrl,
        });
        rememberTab(updated);
      } catch {
        // Without proof of cancellation, never create a second destination.
      }
      return;
    }
    await updateExactSourceOrReplace(
      details.tabId,
      originalUrl,
      source,
      effectiveSettings
    );
    return;
  }

  if (!stateReady) {
    if (!persistedCurrent) {
      // The owner was loaded but no installed rule proves Chrome canceled the
      // pending navigation. Opening another tab here would duplicate the
      // browser's still-running same-tab navigation. Replace only that exact
      // source with the clean URL so the owned marker is not sent to the site.
      try {
        const updated = await chrome.tabs.update(details.tabId, {
          url: originalUrl,
        });
        rememberTab(updated);
      } catch {
        // The browser may already have committed or closed the source.
      }
      return;
    }
    const [verifiedBookmark, latestSource] = await Promise.all([
      verificationPromise,
      refreshSource(source, details.tabId),
    ]);
    if (!verifiedBookmark) return;
    source = latestSource || source;
    if (source?.removedAt) {
      await createReplacement(originalUrl, source, effectiveSettings);
    } else {
      await createNormalDestination(originalUrl, source, effectiveSettings);
    }
    return;
  }

  const [verifiedBookmark, latestSource] = await Promise.all([
    verificationPromise,
    refreshSource(source, details.tabId),
  ]);
  source = latestSource || source;

  if (verifiedBookmark && canReuseExactSource(source, details.url)) {
    await updateExactSourceOrReplace(
      details.tabId,
      originalUrl,
      source,
      effectiveSettings
    );
    return;
  }

  if (navigationEnabled && verifiedBookmark) {
    if (source?.removedAt) {
      await createReplacement(originalUrl, source, effectiveSettings);
      return;
    }
    await createNormalDestination(originalUrl, source, effectiveSettings);
    return;
  }

  // Only the authenticated v4 namespace is safe to strip without bookmark proof.
  // Released/public legacy lookalikes may be legitimate Basic Auth URLs; the
  // 204 leaves their source document intact instead of rewriting credentials.
  if (!ownedCurrent) return;

  // An invalid/copy-pasted capability or paused current navigation stays in
  // its exact source tab rather than gaining new-tab behavior.
  await updateExactSourceOrReplace(
    details.tabId,
    originalUrl,
    source,
    effectiveSettings
  );
}

function pruneEventIdentities(now = Date.now()) {
  for (const [key, receivedAt] of recentEventIdentities) {
    if (now - receivedAt >= EVENT_IDENTITY_TTL_MS) {
      recentEventIdentities.delete(key);
    }
  }
  pruneBoundedMap(recentEventIdentities, MAX_EVENT_IDENTITIES);
}

function claimNavigation(details) {
  const hasBrowserTimestamp = Number.isFinite(details.timeStamp);
  const eventKey = hasBrowserTimestamp
    ? `${details.tabId}\n${details.url}\n${details.timeStamp}`
    : `${details.tabId}\n${details.url}`;
  const now = Date.now();
  pruneEventIdentities(now);
  if (recentEventIdentities.has(eventKey)) return null;
  if (inFlightNavigations.has(eventKey)) return null;
  if (hasBrowserTimestamp) {
    recentEventIdentities.set(eventKey, now);
    pruneBoundedMap(recentEventIdentities, MAX_EVENT_IDENTITIES);
  }
  return eventKey;
}

// All listeners are registered synchronously at service-worker top level.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  const markerCandidates = {
    current: UrlTools.readMarker(details.url),
    draftV4: UrlTools.readDraftV4Marker(details.url),
    publicV3: UrlTools.getV3OriginalUrl(details.url, publicV3Token),
    legacy: UrlTools.getLegacyOriginalUrl(details.url),
  };
  if (
    !markerCandidates.current &&
    !markerCandidates.draftV4 &&
    !markerCandidates.publicV3 &&
    !markerCandidates.legacy
  ) return;

  const eventKey = claimNavigation(details);
  if (!eventKey) return;
  const capture = beginSourceCapture(details.tabId);
  const task = handleMarkedNavigation(
    details,
    markerCandidates,
    capture
  ).catch((error) => {
    console.error("[Bookmarks→NewTab] Bookmark navigation failed", error);
  }).finally(() => {
    if (inFlightNavigations.get(eventKey) === task) {
      inFlightNavigations.delete(eventKey);
    }
  });
  inFlightNavigations.set(eventKey, task);
}, {
  url: [
    {
      schemes: ["http", "https"],
      queryContains: `${UrlTools.MARKER_PARAMETER}=`,
    },
    {
      schemes: ["http", "https"],
      queryContains: `${UrlTools.V3_MARKER_PARAMETER}=${publicV3Token}`,
    },
    {
      schemes: ["http", "https"],
      urlMatches: "^https?://newtab(?:@|%40)",
    },
  ],
});

chrome.tabs.onCreated.addListener((tab) => {
  const includeUrls = isPotentiallyManagedUrl(tab.pendingUrl || tab.url);
  rememberTab(tab, {createdAt: Date.now()}, includeUrls);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const existing = sourceSnapshots.get(tabId);
  const includeUrls = Boolean(
    existing?.pendingUrl ||
    existing?.url ||
    isPotentiallyManagedUrl(changeInfo.pendingUrl || changeInfo.url)
  );
  rememberTab({...tab, ...changeInfo, id: tabId}, {}, includeUrls);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const existing = cachedSource(tabId) || {id: tabId};
  sourceSnapshots.set(tabId, {
    ...existing,
    windowId: removeInfo.windowId,
    removedAt: Date.now(),
    observedAt: Date.now(),
    windowClosing: removeInfo.isWindowClosing,
  });
  pruneSourceSnapshots();
});

chrome.tabs.onMoved?.addListener((tabId, moveInfo) => {
  const existing = cachedSource(tabId) || {id: tabId};
  rememberTab({
    ...existing,
    id: tabId,
    index: moveInfo.toIndex,
    windowId: moveInfo.windowId,
  });
});

chrome.tabs.onAttached?.addListener((tabId, attachInfo) => {
  const existing = cachedSource(tabId) || {id: tabId};
  rememberTab({
    ...existing,
    id: tabId,
    index: attachInfo.newPosition,
    windowId: attachInfo.newWindowId,
  });
});

// ─── Serialized Maintenance ────────────────────────────────────────────────

function queueMaintenance(label, operation) {
  const result = maintenanceTail.then(operation);
  maintenanceTail = result.catch((error) => {
    console.error(`[Bookmarks→NewTab] ${label} failed`, error);
  });
  return result;
}

chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  if (!bookmark.url || importInProgress) return;
  queueMaintenance("new bookmark", async () => {
    if (importInProgress) return;
    await synchronizeConfiguredSettings();
    if (!settings.enabled) return;
    await transformBookmarkById(
      id,
      (url) => ensureEnabledMarker(url, {
        allowLegacy: false,
        allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      })
    );
  });
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  if (!changeInfo.url) return;
  if (pendingBookmarkWrites.get(id) === changeInfo.url) {
    pendingBookmarkWrites.delete(id);
    return;
  }
  if (importInProgress) return;

  // Preserve the newest external URL even if a bulk write already began with
  // an older value. The queued pass reapplies the latest observed edit.
  deferredBookmarkUrls.set(id, changeInfo.url);
  queueMaintenance("changed bookmark", async () => {
    await synchronizeConfiguredSettings();
    const deferredUrl = deferredBookmarkUrls.get(id);
    if (!deferredUrl) return;
    const transform = settings.enabled
      ? (url) => ensureEnabledMarker(url, {
        allowLegacy: false,
        allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      })
      : (url) => restoreManagedUrl(url, {
        allowLegacy: false,
        allowAmbiguousSingle: legacyAllowAmbiguousSingle,
      });
    try {
      await transformBookmarkById(id, transform);
    } finally {
      if (deferredBookmarkUrls.get(id) === deferredUrl) {
        deferredBookmarkUrls.delete(id);
      }
    }
  });
});

chrome.bookmarks.onImportBegan.addListener(() => {
  importInProgress = true;
});

chrome.bookmarks.onImportEnded.addListener(() => {
  importInProgress = false;
  queueMaintenance("bookmark import", async () => {
    await synchronizeConfiguredSettings();
    return applyConfiguredState(true);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "sync" ||
    (!changes[SETTINGS_KEY] && !changes[SYNC_STATE_KEY])
  ) return;
  queueMaintenance("shared settings synchronization", async () => {
    let runtimeStateChanged = false;
    if (changes[SYNC_STATE_KEY]) {
      const previousSecret = markerSecret;
      const previousAccepted = acceptedMarkerSecrets.join(",");
      const previousCompatibility = legacyCompatibilityEnabled;
      const previousAmbiguous = legacyAllowAmbiguousSingle;
      const normalized = applySyncedRuntimeState(
        changes[SYNC_STATE_KEY].newValue
      );
      if (normalized.legacyCompatibilityEnabled !== null) {
        legacyCompatibilityEnabled =
          normalized.legacyCompatibilityEnabled;
      }
      if (normalized.legacyAllowAmbiguousSingle !== null) {
        legacyAllowAmbiguousSingle =
          normalized.legacyAllowAmbiguousSingle;
      }
      runtimeStateChanged = (
        previousSecret !== markerSecret ||
        previousAccepted !== acceptedMarkerSecrets.join(",") ||
        previousCompatibility !== legacyCompatibilityEnabled ||
        previousAmbiguous !== legacyAllowAmbiguousSingle
      );
      if (runtimeStateChanged) await persistSyncedRuntimeState();
    }

    const latestSettings = changes[SETTINGS_KEY]
      ? normalizeSettings(changes[SETTINGS_KEY].newValue)
      : await synchronizeSettingsFromStorage();
    if (!settingsAreEqual(settings, latestSettings)) {
      await transitionToSettings(latestSettings, {
        force: runtimeStateChanged,
      });
    } else if (runtimeStateChanged) {
      await applyConfiguredState(true);
    }
  });
});

async function synchronizeConfiguredSettings() {
  const latestSettings = await synchronizeSettingsFromStorage();
  if (!settingsAreEqual(settings, latestSettings)) {
    await transitionToSettings(latestSettings);
  }
  return settings;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getSettings") {
    maintenanceTail.then(async () => {
      await synchronizeConfiguredSettings();
      sendResponse({settings});
    }).catch((error) => {
      sendResponse({error: error.message});
    });
    return true;
  }

  if (message?.type === "updateSettings") {
    queueMaintenance("settings update", async () => {
      const patch = validateSettingsPatch(message.data);
      const previousSettings = settings;
      const nextSettings = {...settings, ...patch};
      let bookmarkResult = {examined: 0, changed: 0};

      try {
        bookmarkResult = await transitionToSettings(nextSettings, {
          persistSettings: true,
        });
      } catch (error) {
        try {
          await transitionToSettings(previousSettings, {
            force: true,
            persistSettings: true,
          });
        } catch (rollbackError) {
          throw new Error(
            `${error.message}; restoring the previous state also failed: ` +
            rollbackError.message
          );
        }
        throw error;
      }
      return {settings, bookmarkResult};
    }).then(sendResponse).catch((error) => {
      sendResponse({error: error.message});
    });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  queueMaintenance("installation reconciliation", async () => {
    await synchronizeConfiguredSettings();
    // prepareInterception persisted migration provenance before this queued
    // event. Do not infer legacy ownership from every future update.
    await applyConfiguredState(true);
  });
});

chrome.runtime.onStartup.addListener(() => {
  queueMaintenance("startup reconciliation", async () => {
    await synchronizeConfiguredSettings();
    return applyConfiguredState(false);
  });
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function prepareInterception() {
  await loadSettings();
  const [stored, session] = await Promise.all([
    chrome.storage.local.get(RUNTIME_STATE_KEY),
    chrome.storage.session?.get(SESSION_READY_KEY) || Promise.resolve({}),
  ]);
  const runtimeState = stored[RUNTIME_STATE_KEY] || {};
  if (
    isMarkerSecret(runtimeState.markerSecretApplied) &&
    runtimeState.markerSecretApplied !== markerSecret
  ) {
    acceptedMarkerSecrets = [...new Set([
      markerSecret,
      runtimeState.markerSecretApplied,
      ...acceptedMarkerSecrets,
    ])].slice(0, CURRENT_RULE_IDS.length);
  }
  const schemaMigration = (
    (runtimeState.bookmarkFormatVersion || 0) < BOOKMARK_FORMAT_VERSION ||
    runtimeState.pendingOperation?.type === "schemaMigration" ||
    runtimeState.migrationMode === "legacy"
  );
  legacyCompatibilityEnabled = syncedLegacyCompatibility ?? (
    typeof runtimeState.legacyCompatibilityEnabled === "boolean"
      ? runtimeState.legacyCompatibilityEnabled
      : schemaMigration && hadStoredSettings
  );
  legacyAllowAmbiguousSingle = legacyCompatibilityEnabled && (
    syncedLegacyAllowAmbiguousSingle ??
    (typeof runtimeState.migrationAllowAmbiguousSingle === "boolean"
      ? runtimeState.migrationAllowAmbiguousSingle
      : true)
  );
  // Persist ownership and migration provenance before rewriting anything so a
  // second device or interrupted first run reaches the same decision.
  await persistSyncedRuntimeState();

  const includePublicV3 = (
    runtimeState.bookmarkFormatVersion === 3 ||
    runtimeState.pendingOperation?.type === "schemaMigration"
  );
  const includeDraftV4 = (
    runtimeState.bookmarkFormatVersion === 4 ||
    runtimeState.pendingOperation?.allowDraftV4
  );
  const ownsNavigations = Boolean(
    settings.enabled || runtimeState.pendingOperation || schemaMigration
  );
  navigationEnabled = Boolean(
    settings.enabled || runtimeState.pendingOperation || schemaMigration
  );
  navigationSettings = {...settings};
  await setNavigationRules(
    ownsNavigations,
    schemaMigration && legacyCompatibilityEnabled,
    legacyAllowAmbiguousSingle,
    includePublicV3,
    includeDraftV4
  );
  return {
    runtimeState,
    sessionReady: session?.[SESSION_READY_KEY] === true,
  };
}

interceptionReadyPromise = prepareInterception();
maintenanceTail = interceptionReadyPromise.then(async ({
  runtimeState,
  sessionReady,
}) => {
  await cleanupExpiredLegacyBackup();
  const desiredState = settings.enabled ? "enabled" : "disabled";
  const mustReconcile = (
    !sessionReady ||
    Boolean(runtimeState.pendingOperation) ||
    (runtimeState.bookmarkFormatVersion || 0) < BOOKMARK_FORMAT_VERSION ||
    runtimeState.bookmarkState !== desiredState
  );
  await applyConfiguredState(mustReconcile);
  await chrome.storage.session?.set({[SESSION_READY_KEY]: true});
}).catch((error) => {
  console.error("[Bookmarks→NewTab] Startup reconciliation failed", error);
});

console.log("[Bookmarks→NewTab] Service worker listeners registered.");
