const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.OBNT_TEST_ROOT
  ? path.resolve(process.env.OBNT_TEST_ROOT)
  : path.join(__dirname, "..");
const BACKGROUND_PATH = path.join(ROOT, "js/background.js");
const URL_UTILS_PATH = path.join(ROOT, "js/url-utils.js");
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TARGET_MARKER_PARAMETER = "__obnt_v4";
const LEGACY_V3_MARKER_PARAMETER = "__obnt_v3";
const KNOWN_MARKER_SECRET = "0123456789abcdef0123456789abcdef";
const PREVIOUS_MARKER_SECRET = "fedcba9876543210fedcba9876543210";
const FOREIGN_MARKER_SECRET = "11111111111111111111111111111111";
const KNOWN_MARKER_NONCE =
  "0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186";
const KNOWN_MARKER_CAPABILITY =
  `${KNOWN_MARKER_SECRET}_m_${KNOWN_MARKER_NONCE}`;
const TARGET_URL_TOOLS = fs.existsSync(URL_UTILS_PATH)
  ? require(URL_UTILS_PATH)
  : null;
const backgroundSource = fs.readFileSync(BACKGROUND_PATH, "utf8");
const BACKGROUND_USES_TARGET_MARKER =
  backgroundSource.includes(TARGET_MARKER_PARAMETER) ||
  backgroundSource.includes("url-utils.js");

class ChromeEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  async emit(...args) {
    const pending = this.listeners.map((listener) => listener(...args));
    await Promise.all(pending.map((result) => Promise.resolve(result)));
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function selectStorage(data, keys) {
  if (keys === null || keys === undefined) return clone(data);
  if (typeof keys === "string") return {[keys]: clone(data[keys])};
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, clone(data[key])]));
  }

  const result = {...keys};
  for (const key of Object.keys(keys)) {
    if (key in data) result[key] = clone(data[key]);
  }
  return result;
}

function legacyMarkedUrl(originalUrl) {
  const parsed = new URL(originalUrl);
  if (parsed.hostname === "mail.google.com") {
    const proxy =
      "sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/redirect.html";
    return `https://newtab@${proxy}?url=${encodeURIComponent(originalUrl)}`;
  }
  return originalUrl.replace(/^(https?:\/\/)/i, "$1newtab@");
}

function markerCapability(
  owner = KNOWN_MARKER_SECRET,
  mode = "m",
  nonce = KNOWN_MARKER_NONCE
) {
  return `${owner}_${mode}_${nonce}`;
}

function markedUrl(originalUrl, mode = "m") {
  const markerMode = mode === "p" ? "p" : "m";
  if (BACKGROUND_USES_TARGET_MARKER && TARGET_URL_TOOLS?.markUrl) {
    return TARGET_URL_TOOLS.markUrl(
      originalUrl,
      markerCapability(KNOWN_MARKER_SECRET, markerMode)
    );
  }
  return legacyMarkedUrl(originalUrl);
}

function legacyV3MarkedUrl(originalUrl) {
  const fragmentIndex = originalUrl.indexOf("#");
  const base = fragmentIndex === -1
    ? originalUrl
    : originalUrl.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : originalUrl.slice(fragmentIndex);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${LEGACY_V3_MARKER_PARAMETER}=${EXTENSION_ID}` +
    fragment;
}

function draftV4MarkedUrl(originalUrl, nonce = KNOWN_MARKER_NONCE) {
  const fragmentIndex = originalUrl.indexOf("#");
  const base = fragmentIndex === -1
    ? originalUrl
    : originalUrl.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : originalUrl.slice(fragmentIndex);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${TARGET_MARKER_PARAMETER}=${nonce}${fragment}`;
}

function createHarness(options = {}) {
  const settings = {
    enabled: true,
    focusNewTab: false,
    position: "end",
    ...options.settings,
  };
  const localData = clone({
    settings,
    runtimeState: {
      bookmarkFormatVersion: 5,
      bookmarkState: settings.enabled ? "enabled" : "disabled",
    },
    ...options.localData,
  });
  const syncDefaults = {
    settings,
    syncStateV4: {
      markerSecret: KNOWN_MARKER_SECRET,
      previousMarkerSecrets: [],
    },
  };
  if (options.omitSyncState) delete syncDefaults.syncStateV4;
  const syncData = clone({...syncDefaults, ...options.syncData});
  const sessionData = clone(options.sessionData || {});
  const bookmarkMap = new Map(
    (options.bookmarks || []).map((bookmark) => [String(bookmark.id), {
      ...bookmark,
      id: String(bookmark.id),
    }])
  );
  const tabMap = new Map(
    (options.tabs || []).map((tab) => [tab.id, {...tab}])
  );
  const dynamicRules = clone(options.dynamicRules || []);
  const fetchListeners = [];
  const calls = {
    alarmClears: [],
    alarmCreates: [],
    bookmarkUpdateStarts: [],
    createdTabs: [],
    downloadCancels: [],
    downloadErases: [],
    downloadUiOptions: [],
    dynamicRuleUpdates: [],
    enabledRulesetUpdates: [],
    goBacks: [],
    queries: [],
    removedTabs: [],
    storageSets: [],
    tabCreateAttempts: [],
    tabGroups: [],
    updatedTabs: [],
  };
  let nextTabId = 1000;

  const events = {
    alarm: new ChromeEvent(),
    beforeNavigate: new ChromeEvent(),
    bookmarkChanged: new ChromeEvent(),
    bookmarkCreated: new ChromeEvent(),
    committed: new ChromeEvent(),
    downloadCreated: new ChromeEvent(),
    importBegan: new ChromeEvent(),
    importEnded: new ChromeEvent(),
    installed: new ChromeEvent(),
    message: new ChromeEvent(),
    startup: new ChromeEvent(),
    storageChanged: new ChromeEvent(),
    tabCreated: new ChromeEvent(),
    tabRemoved: new ChromeEvent(),
    tabUpdated: new ChromeEvent(),
  };

  function bookmarkTree() {
    return [{
      id: "0",
      children: [{
        id: "1",
        children: [...bookmarkMap.values()].map((bookmark) => ({...bookmark})),
      }],
    }];
  }

  function storageArea(data, areaName) {
    return {
      get: async (keys) => {
        if (options.storageGetDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.storageGetDelayMs));
        }
        if (typeof options.storageGetFailure === "function") {
          const failure = options.storageGetFailure({areaName, keys});
          if (failure) {
            throw failure instanceof Error
              ? failure
              : new Error(String(failure));
          }
        }
        return selectStorage(data, keys);
      },
      set: async (items) => {
        const setCall = {
          areaName,
          items: clone(items),
          index: calls.storageSets.length,
        };
        calls.storageSets.push(setCall);
        if (typeof options.storageSetFailure === "function") {
          const failure = options.storageSetFailure(setCall);
          if (failure) {
            throw failure instanceof Error
              ? failure
              : new Error(String(failure));
          }
        }
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = {
            oldValue: clone(data[key]),
            newValue: clone(value),
          };
        }
        Object.assign(data, clone(items));
        void events.storageChanged.emit(changes, areaName);
      },
      remove: async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) delete data[key];
      },
    };
  }

  const chrome = {
    alarms: {
      clear: async (name) => {
        calls.alarmClears.push(name);
        return true;
      },
      create: async (name, alarmInfo) => {
        calls.alarmCreates.push({name, alarmInfo: clone(alarmInfo)});
      },
      onAlarm: events.alarm,
    },
    bookmarks: {
      get: async (id) => {
        const bookmark = bookmarkMap.get(String(id));
        if (!bookmark) throw new Error("Bookmark not found");
        return [{...bookmark}];
      },
      getTree: async () => bookmarkTree(),
      onChanged: events.bookmarkChanged,
      onCreated: events.bookmarkCreated,
      onImportBegan: events.importBegan,
      onImportEnded: events.importEnded,
      search: async ({url}) => [...bookmarkMap.values()]
        .filter((bookmark) => bookmark.url === url)
        .map((bookmark) => ({...bookmark})),
      update: async (id, changes) => {
        const bookmark = bookmarkMap.get(String(id));
        if (!bookmark) throw new Error("Bookmark not found");
        calls.bookmarkUpdateStarts.push({id: String(id), changes: clone(changes)});
        if (typeof options.bookmarkUpdateFailure === "function") {
          const failure = options.bookmarkUpdateFailure({
            id: String(id),
            changes: clone(changes),
            index: calls.bookmarkUpdateStarts.length - 1,
          });
          if (failure) {
            throw failure instanceof Error
              ? failure
              : new Error(String(failure));
          }
        }
        if (options.bookmarkUpdateGate) {
          await options.bookmarkUpdateGate;
        }
        if (options.bookmarkUpdateDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.bookmarkUpdateDelayMs));
        }
        Object.assign(bookmark, changes);
        if (changes.url) {
          void events.bookmarkChanged.emit(String(id), {url: changes.url});
        }
        return {...bookmark};
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => clone(dynamicRules),
      isRegexSupported: async (details) => {
        if (typeof options.regexSupportFailure === "function") {
          const reason = options.regexSupportFailure(clone(details));
          if (reason) return {isSupported: false, reason: String(reason)};
        }
        return {isSupported: true};
      },
      updateDynamicRules: async ({removeRuleIds = [], addRules = []}) => {
        calls.dynamicRuleUpdates.push({
          removeRuleIds: clone(removeRuleIds),
          addRules: clone(addRules),
        });
        for (const id of removeRuleIds) {
          const index = dynamicRules.findIndex((rule) => rule.id === id);
          if (index !== -1) dynamicRules.splice(index, 1);
        }
        dynamicRules.push(...clone(addRules));
      },
      updateEnabledRulesets: async (update) => {
        calls.enabledRulesetUpdates.push(clone(update));
      },
    },
    downloads: {
      cancel: async (id) => calls.downloadCancels.push(id),
      erase: async (query) => {
        calls.downloadErases.push(clone(query));
        return [];
      },
      onCreated: events.downloadCreated,
      setUiOptions: async (optionsValue) => {
        calls.downloadUiOptions.push(clone(optionsValue));
      },
    },
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({version: "2.4.0"}),
      getURL: (resource) =>
        `chrome-extension://${EXTENSION_ID}/${resource.replace(/^\//, "")}`,
      onInstalled: events.installed,
      onMessage: events.message,
      onStartup: events.startup,
    },
    storage: {
      local: storageArea(localData, "local"),
      onChanged: events.storageChanged,
      session: storageArea(sessionData, "session"),
      sync: storageArea(syncData, "sync"),
    },
    tabs: {
      create: async (createOptions) => {
        calls.tabCreateAttempts.push(clone(createOptions));
        if (
          Number.isInteger(options.tabCreateFailureCount) &&
          calls.tabCreateAttempts.length <= options.tabCreateFailureCount
        ) {
          throw new Error("Simulated tabs.create failure");
        }
        const tab = {id: nextTabId, ...clone(createOptions)};
        nextTabId += 1;
        calls.createdTabs.push(tab);
        tabMap.set(tab.id, tab);
        return {...tab};
      },
      get: async (id) => {
        if (options.tabGetDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.tabGetDelayMs));
        }
        const tab = tabMap.get(id);
        if (!tab) throw new Error("Tab not found");
        return {...tab};
      },
      goBack: async (id) => {
        calls.goBacks.push(id);
        throw new Error("No history entry");
      },
      group: async (groupOptions) => {
        calls.tabGroups.push(clone(groupOptions));
        return groupOptions.groupId ?? 500;
      },
      query: async (queryInfo) => {
        calls.queries.push(clone(queryInfo));
        return [...tabMap.values()]
          .filter((tab) => !queryInfo.active || tab.active)
          .map((tab) => ({...tab}));
      },
      remove: async (id) => {
        calls.removedTabs.push(id);
        tabMap.delete(id);
      },
      update: async (id, changes) => {
        if (options.tabUpdateDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.tabUpdateDelayMs));
        }
        const current = tabMap.get(id);
        if (!current) throw new Error("Tab not found");
        const updated = {...current, ...clone(changes)};
        tabMap.set(id, updated);
        calls.updatedTabs.push({id, ...clone(changes)});
        return {...updated};
      },
      onCreated: events.tabCreated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
    },
    webNavigation: {
      onBeforeNavigate: events.beforeNavigate,
      onCommitted: events.committed,
    },
  };

  let context;
  let timerId = 0;
  let randomFillCount = 0;
  const sandbox = {
    BookmarkUrl: TARGET_URL_TOOLS,
    Date,
    Promise,
    Response,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    chrome,
    clearTimeout: () => {},
    console: options.console || {
      error: () => {},
      log: () => {},
      warn: () => {},
    },
    crypto: options.crypto || {
      getRandomValues: (array) => {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = (
            index * 37 + 11 + randomFillCount * 17
          ) & 0xff;
        }
        randomFillCount += 1;
        return array;
      },
      randomUUID: () => "0b30557a-9fc4-49ee-9338-5d82a7ccf116",
    },
    globalThis: null,
    importScripts: (...resources) => {
      for (const resource of resources) {
        const scriptPath = path.join(ROOT, "js", path.basename(resource));
        const source = fs.readFileSync(scriptPath, "utf8");
        vm.runInContext(source, context, {filename: resource});
      }
    },
    self: {
      addEventListener: (type, listener) => {
        if (type === "fetch") fetchListeners.push(listener);
      },
    },
    setTimeout: () => {
      timerId += 1;
      return timerId;
    },
  };
  sandbox.globalThis = sandbox;
  context = vm.createContext(sandbox);
  vm.runInContext(backgroundSource, context, {filename: "background.js"});

  async function settle(milliseconds = 60) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function emitDummyDownload(id, referrer) {
    const emptyZipUrl = chrome.runtime.getURL("empty.zip");
    await events.downloadCreated.emit({
      id,
      finalUrl: emptyZipUrl,
      referrer,
      url: emptyZipUrl,
    });
  }

  async function sendRuntimeMessage(message) {
    const [listener] = events.message.listeners;
    if (!listener) throw new Error("No runtime message listener registered");

    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        settled = true;
        resolve(clone(response));
      };
      try {
        const keepChannelOpen = listener(message, {}, sendResponse);
        if (!keepChannelOpen && !settled) resolve(undefined);
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    bookmarkMap,
    calls,
    dynamicRules,
    emitDummyDownload,
    events,
    fetchListeners,
    localData,
    sendRuntimeMessage,
    sessionData,
    settle,
    syncData,
    tabMap,
  };
}

function destinationActions(harness, destinations) {
  return [
    ...harness.calls.createdTabs.map((tab) => ({
      id: tab.id,
      kind: "create",
      url: tab.url,
    })),
    ...harness.calls.updatedTabs.map((update) => ({
      id: update.id,
      kind: "update",
      url: update.url,
    })),
  ].filter((action) => destinations.includes(action.url));
}

async function navigateAndRedirect(harness, details, downloadId) {
  await harness.events.beforeNavigate.emit(details);
  await harness.settle();
  if (harness.events.downloadCreated.listeners.length > 0) {
    await harness.emitDummyDownload(downloadId, details.url);
    await harness.settle();
  }
}

async function waitUntil(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function currentMarkerToken(url) {
  try {
    return new URL(url).searchParams.get(TARGET_MARKER_PARAMETER);
  } catch {
    return null;
  }
}

async function testSettingsUseSyncAsCanonicalStorage() {
  const syncedSettings = {
    enabled: true,
    focusNewTab: true,
    position: "end",
  };
  const staleLocalSettings = {
    enabled: false,
    focusNewTab: false,
    position: "right",
  };
  const harness = createHarness({
    localData: {settings: staleLocalSettings},
    syncData: {settings: syncedSettings},
  });
  await harness.settle();

  const initial = await harness.sendRuntimeMessage({type: "getSettings"});
  assert.deepEqual(initial.settings, syncedSettings);

  const expected = {
    enabled: true,
    focusNewTab: false,
    position: "right",
  };
  const result = await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {focusNewTab: false, position: "right"},
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.settings, expected);
  assert.deepEqual(harness.syncData.settings, expected);
  assert.equal(
    harness.calls.storageSets.some(({areaName, items}) =>
      areaName === "local" && Object.hasOwn(items, "settings")),
    false,
    "settings must never be written back to device-local storage"
  );
}

async function testFreshPerBookmarkNoncesArePrivate() {
  const originals = [
    "https://example.com/private-marker/one#proof",
    "https://example.net/private-marker/two?view=proof",
  ];
  const harness = createHarness({
    bookmarks: originals.map((url, index) => ({
      id: `private-${index}`,
      title: `private ${index}`,
      url,
    })),
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 5,
        bookmarkState: "enabled",
      },
    },
  });

  await waitUntil(
    () => originals.every((original, index) => {
      const url = harness.bookmarkMap.get(`private-${index}`).url;
      return currentMarkerToken(url) && url !== original;
    }),
    "cold initialization did not assign private per-bookmark nonces"
  );
  const markedUrls = originals.map((original, index) => ({
    marked: harness.bookmarkMap.get(`private-${index}`).url,
    original,
  }));
  const tokens = markedUrls.map(({marked}) => currentMarkerToken(marked));
  assert.equal(new Set(tokens).size, originals.length);
  for (let index = 0; index < tokens.length; index += 1) {
    assert.match(tokens[index], /^[a-f0-9]{32}_[mp]_[a-f0-9]{64}$/);
    assert.equal(tokens[index].split("_", 1)[0], KNOWN_MARKER_SECRET);
    assert.notEqual(tokens[index], EXTENSION_ID);
    assert.equal(
      TARGET_URL_TOOLS.getOriginalUrl(markedUrls[index].marked),
      originals[index]
    );
  }

  const rule = harness.dynamicRules.find((candidate) =>
    candidate.action?.redirect?.extensionPath === "/cancel.html");
  assert.ok(rule);
  assert.match(rule.condition.regexFilter, /__obnt_v4/);
  assert.equal(rule.condition.regexFilter.includes(EXTENSION_ID), false);
  for (const token of tokens) {
    assert.equal(rule.condition.regexFilter.includes(token), false);
  }
  const rulePattern = new RegExp(rule.condition.regexFilter, "i");
  for (const {marked} of markedUrls) {
    assert.equal(rulePattern.test(marked), true);
  }
}

async function testV3AndMixedLegacyLayersMigrateForUpgrade() {
  const originals = [
    "https://example.com/public-v3?view=old#proof",
    "https://mail.google.com/mail/u/0/#inbox",
  ];
  const publicV3 = legacyV3MarkedUrl(originals[0]);
  const mixed = legacyMarkedUrl(legacyMarkedUrl(
    legacyV3MarkedUrl(originals[1])
  ));
  const harness = createHarness({
    bookmarks: [
      {id: "public-v3", title: "public v3", url: publicV3},
      {id: "mixed", title: "mixed", url: mixed},
    ],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 3,
        bookmarkState: "enabled",
        legacyCompatibilityEnabled: true,
      },
    },
    tabs: [{
      id: 111,
      active: true,
      index: 1,
      url: "https://example.org/source",
      windowId: 17,
    }],
  });
  await harness.events.installed.emit({
    previousVersion: "2.4.0",
    reason: "update",
  });
  await waitUntil(
    () => ["public-v3", "mixed"].every((id, index) => {
      const migrated = harness.bookmarkMap.get(id).url;
      return TARGET_URL_TOOLS.getOriginalUrl(migrated) === originals[index];
    }),
    "public v3 and mixed legacy/v3 bookmarks did not migrate to v4"
  );
  const migratedMixed = harness.bookmarkMap.get("mixed").url;

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 111,
    timeStamp: 1110,
    url: migratedMixed,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [originals[1]]), [{
    id: 1000,
    kind: "create",
    url: originals[1],
  }]);

  const paused = await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(paused.error, undefined);
  assert.equal(
    harness.bookmarkMap.get("mixed").url,
    originals[1],
    "pausing after upgrade must recursively restore every owned layer"
  );
}

async function testPauseTransitionStillOwnsMarkedClick() {
  const original = "https://example.com/click-during-pause";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarkUpdateDelayMs: 180,
    bookmarks: [{id: "pause", title: "pause", url: marked}],
    tabs: [{
      id: 112,
      active: true,
      index: 2,
      url: "https://open.spotify.com/collection/tracks",
      windowId: 18,
    }],
  });
  await harness.settle();

  const pausePromise = harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  await waitUntil(
    () => harness.calls.bookmarkUpdateStarts.length > 0,
    "pause did not begin restoring its marked bookmark"
  );
  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 112,
    timeStamp: 1120,
    url: marked,
  });
  await harness.settle(40);

  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }], "an in-flight pause must not navigate the existing source document");

  const paused = await pausePromise;
  assert.equal(paused.error, undefined);
  assert.equal(harness.bookmarkMap.get("pause").url, original);
}

async function testLegacyBackupLimitsAndFailuresDoNotBlockMigration() {
  const hugeOriginal = `https://example.com/${"x".repeat(2 * 1024 * 1024)}`;
  const cases = [
    {name: "oversized backup", original: hugeOriginal},
    {
      name: "storage failure",
      original: "https://example.com/backup-write-failure",
      storageSetFailure: ({areaName, items}) => (
        areaName === "local" &&
        Object.hasOwn(items, "legacyMigrationBackupV2") &&
        new Error("Simulated backup quota failure")
      ),
    },
  ];

  for (const testCase of cases) {
    const legacy = legacyMarkedUrl(testCase.original);
    const harness = createHarness({
      bookmarks: [{id: "legacy-backup", title: testCase.name, url: legacy}],
      localData: {
        runtimeState: {
          bookmarkFormatVersion: 2,
          bookmarkState: "enabled",
        },
      },
      storageSetFailure: testCase.storageSetFailure,
    });
    await harness.events.installed.emit({
      previousVersion: "2.3.0",
      reason: "update",
    });
    await waitUntil(
      () => TARGET_URL_TOOLS.getOriginalUrl(
        harness.bookmarkMap.get("legacy-backup").url
      ) === testCase.original,
      `${testCase.name} prevented legacy bookmark migration`,
      3000
    );
    assert.equal(
      harness.localData.runtimeState.bookmarkFormatVersion,
      5,
      `${testCase.name} must not leave migration incomplete`
    );
  }
}

async function testPreV3ColdStartInstallsLegacyRuleImmediately() {
  const harness = createHarness({
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
      },
    },
  });
  await harness.settle();

  assert.ok(harness.calls.dynamicRuleUpdates.length > 0);
  assert.equal(
    harness.calls.dynamicRuleUpdates[0].addRules.some((rule) =>
      /newtab/i.test(rule.condition?.regexFilter || "")),
    true,
    "legacy interception must be in the first cold-start rule transaction"
  );
}

async function testInterruptedOperationResumesOnColdStart() {
  const original = "https://example.com/resume-pause";
  const marked = markedUrl(original);
  const neverResolve = new Promise(() => {});
  const first = createHarness({
    bookmarkUpdateGate: neverResolve,
    bookmarks: [{id: "resume", title: "resume", url: marked}],
  });
  await first.settle();

  void first.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  await waitUntil(
    () => (
      first.calls.bookmarkUpdateStarts.length > 0 &&
      first.localData.runtimeState?.pendingOperation?.targetEnabled === false
    ),
    "disable did not persist its resumable operation before bookmark writes"
  );

  const second = createHarness({
    bookmarks: [...first.bookmarkMap.values()].map(clone),
    localData: clone(first.localData),
    settings: clone(first.syncData.settings),
    syncData: clone(first.syncData),
  });
  await waitUntil(
    () => second.bookmarkMap.get("resume").url === original,
    "cold initialization did not resume the interrupted operation"
  );
  assert.equal(
    second.localData.runtimeState.pendingOperation ?? null,
    null,
    "the operation journal must clear only after reconciliation commits"
  );
  assert.deepEqual(second.dynamicRules, []);
}

async function testPauseResumesFailedSchemaMigrationBeforeCommitting() {
  const originals = [
    "https://example.com/failed-schema-legacy",
    "https://example.com/failed-schema-current",
  ];
  const harness = createHarness({
    bookmarkUpdateFailure: ({index}) => (
      index === 0 ? new Error("Simulated first schema write failure") : null
    ),
    bookmarks: [
      {id: "schema-legacy", title: "legacy", url: legacyMarkedUrl(originals[0])},
      {id: "schema-current", title: "current", url: markedUrl(originals[1])},
    ],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
        legacyCompatibilityEnabled: true,
      },
    },
  });
  await waitUntil(
    () => harness.localData.runtimeState?.pendingOperation?.type === "schemaMigration",
    "the failed schema pass did not leave its journal pending"
  );
  await harness.settle(100);

  const paused = await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(paused.error, undefined);
  assert.deepEqual(
    ["schema-legacy", "schema-current"].map((id) => (
      harness.bookmarkMap.get(id).url
    )),
    originals,
    "Pause must restore every released/current layer before clearing schema state"
  );
  assert.equal(harness.localData.runtimeState.bookmarkFormatVersion, 5);
  assert.equal(harness.localData.runtimeState.pendingOperation, null);
  assert.deepEqual(harness.dynamicRules, []);
}

async function testColdReenableReconcilesNewCleanBookmark() {
  const original = "https://example.com/added-while-extension-off";
  const harness = createHarness({
    bookmarks: [{id: "reenable", title: "reenable", url: original}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 5,
        bookmarkState: "enabled",
      },
    },
  });
  await waitUntil(
    () => TARGET_URL_TOOLS.getOriginalUrl(
      harness.bookmarkMap.get("reenable").url
    ) === original,
    "cold direct re-enable did not reconcile a bookmark added while disabled"
  );
}

async function testForeignAuthenticatedMarkerRoundTripsInsideOwnedMarker() {
  const original = "https://example.com/foreign-owner?view=shared#proof";
  const foreign = TARGET_URL_TOOLS.markUrl(
    original,
    markerCapability(FOREIGN_MARKER_SECRET, "m", "c".repeat(64))
  );
  const intactSource = "https://source.example/foreign-owner-test";
  const harness = createHarness({
    bookmarks: [{id: "foreign", title: "foreign", url: foreign}],
    tabs: [{
      id: 116,
      active: true,
      index: 1,
      pendingUrl: foreign,
      url: intactSource,
      windowId: 19,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  const ownedOuter = harness.bookmarkMap.get("foreign").url;
  const ownedMarker = TARGET_URL_TOOLS.readMarker(ownedOuter);
  assert.ok(ownedMarker);
  assert.equal(ownedMarker.owner, KNOWN_MARKER_SECRET);
  assert.equal(ownedMarker.mode, "m");
  assert.equal(ownedMarker.originalUrl, foreign);
  assert.equal(
    harness.dynamicRules.some((rule) =>
      rule.condition?.regexFilter?.includes(FOREIGN_MARKER_SECRET)),
    false,
    "DNR must never intercept another installation's owner namespace"
  );

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 116,
    timeStamp: 1160,
    url: foreign,
  });
  await harness.settle();
  assert.deepEqual(harness.calls.createdTabs, []);
  assert.deepEqual(harness.calls.updatedTabs, []);
  assert.deepEqual(harness.calls.tabCreateAttempts, []);
  assert.equal(harness.tabMap.get(116).url, intactSource);

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 116,
    timeStamp: 1161,
    url: ownedOuter,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [foreign]), [{
    id: 1000,
    kind: "create",
    url: foreign,
  }]);

  const paused = await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(paused.error, undefined);
  assert.equal(
    harness.bookmarkMap.get("foreign").url,
    foreign,
    "removing our outer marker must preserve the foreign URL byte-for-byte"
  );
}

async function testLegacyCompatibilityProvenanceSyncsAcrossDevices() {
  const original = "https://example.com/synced-legacy-provenance";
  const legacy = legacyMarkedUrl(original);
  const firstDevice = createHarness({
    bookmarks: [{id: "legacy-sync", title: "legacy", url: legacy}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
      },
    },
    omitSyncState: true,
  });
  await firstDevice.sendRuntimeMessage({type: "getSettings"});

  const syncedProvenance = firstDevice.syncData.syncStateV4;
  assert.match(syncedProvenance.markerSecret, /^[a-f0-9]{32}$/);
  assert.equal(syncedProvenance.legacyCompatibilityEnabled, true);
  assert.equal(syncedProvenance.legacyAllowAmbiguousSingle, true);

  const secondDevice = createHarness({
    bookmarks: [...firstDevice.bookmarkMap.values()].map(clone),
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 5,
        bookmarkState: "enabled",
        markerSecretApplied: syncedProvenance.markerSecret,
      },
    },
    settings: clone(firstDevice.syncData.settings),
    syncData: clone(firstDevice.syncData),
  });
  await secondDevice.sendRuntimeMessage({type: "getSettings"});
  const hasLegacyRule = () => secondDevice.dynamicRules.some((rule) =>
    /^\^https\?/.test(rule.condition?.regexFilter || "") &&
    /newtab/i.test(rule.condition.regexFilter)
  );
  assert.equal(
    hasLegacyRule(),
    false,
    "broad legacy interception must end when schema migration commits"
  );

  await secondDevice.events.installed.emit({reason: "install"});
  await secondDevice.sendRuntimeMessage({type: "getSettings"});
  await secondDevice.events.installed.emit({
    previousVersion: "2.4.0",
    reason: "update",
  });
  await secondDevice.sendRuntimeMessage({type: "getSettings"});

  assert.equal(
    secondDevice.syncData.syncStateV4.legacyCompatibilityEnabled,
    true
  );
  assert.equal(
    secondDevice.syncData.syncStateV4.legacyAllowAmbiguousSingle,
    true
  );
  assert.equal(
    hasLegacyRule(),
    false,
    "future updates must not re-enable broad legacy interception"
  );
}

async function testPostMigrationBasicAuthBookmarkRoundTripsIntact() {
  const original = "https://newtab@example.com/private?view=raw#credentials";
  const harness = createHarness({
    bookmarks: [{id: "basic-auth", title: "basic auth", url: original}],
    tabs: [{
      id: 118,
      active: true,
      index: 1,
      url: "https://source.example/basic-auth",
      windowId: 21,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  const marked = harness.bookmarkMap.get("basic-auth").url;
  const marker = TARGET_URL_TOOLS.readMarker(marked);
  assert.ok(marker);
  assert.equal(marker.owner, KNOWN_MARKER_SECRET);
  assert.equal(marker.mode, "p");
  assert.equal(marker.originalUrl, original);
  assert.equal(
    harness.dynamicRules.some((rule) =>
      rule.condition?.regexFilter === "^https?://newtab(?:@|%40)"),
    false
  );

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 118,
    timeStamp: 1180,
    url: marked,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);

  const paused = await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(paused.error, undefined);
  assert.equal(harness.bookmarkMap.get("basic-auth").url, original);
}

async function testOrdinaryLegacyPrefixAroundManagedMarkerCleans() {
  const original = "https://example.com/ordinary-2-3-peer#clean";
  const inner = markedUrl(original, "m");
  const prefixed = legacyMarkedUrl(inner);
  const harness = createHarness({
    bookmarks: [{id: "prefix-mixed", title: "prefix", url: prefixed}],
    sessionData: {sessionReadyV5: true},
    tabs: [{
      id: 119,
      active: true,
      index: 2,
      url: "https://source.example/prefix",
      windowId: 21,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});
  assert.equal(harness.bookmarkMap.get("prefix-mixed").url, prefixed);

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 119,
    timeStamp: 1190,
    url: prefixed,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);

  await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(harness.bookmarkMap.get("prefix-mixed").url, original);
}

async function testExactLegacyWrapperAroundManagedMarkerCleans() {
  const original = "https://mail.google.com/mail/u/0/#inbox";
  const inner = markedUrl(original, "m");
  const wrapper = legacyMarkedUrl(inner);
  const harness = createHarness({
    bookmarks: [{id: "wrapper-mixed", title: "wrapper", url: wrapper}],
    sessionData: {sessionReadyV5: true},
    tabs: [{
      id: 120,
      active: true,
      index: 3,
      url: "https://source.example/wrapper",
      windowId: 21,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});
  assert.equal(harness.bookmarkMap.get("wrapper-mixed").url, wrapper);
  assert.equal(
    harness.dynamicRules.some((rule) => (
      rule.condition?.urlFilter?.includes("redirect.html?url=*") &&
      rule.condition.urlFilter.includes(KNOWN_MARKER_SECRET) &&
      rule.condition.requestDomains?.includes("sssstf0rest.github.io")
    )),
    true,
    "the exact mixed-wrapper rule must survive after broad migration ends"
  );

  const writesBeforePeerChange = harness.calls.bookmarkUpdateStarts.length;
  await harness.events.bookmarkChanged.emit("wrapper-mixed", {url: wrapper});
  await harness.settle();
  assert.equal(
    harness.bookmarkMap.get("wrapper-mixed").url,
    wrapper,
    "2.4 must not unwrap a wrapper that a synchronized 2.3 peer will re-add"
  );
  assert.equal(
    harness.calls.bookmarkUpdateStarts.length,
    writesBeforePeerChange,
    "mixed-version wrapper handling must not create a sync write loop"
  );

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 120,
    timeStamp: 1200,
    url: wrapper,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);

  await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(harness.bookmarkMap.get("wrapper-mixed").url, original);
}

async function testPureLegacyWrapperArrivingAfterMigrationIsAuthenticated() {
  const original = "https://mail.google.com/mail/u/0/#late-sync";
  const current = markedUrl(original, "m");
  const legacyWrapper = legacyMarkedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "late-wrapper", title: "late wrapper", url: current}],
    sessionData: {sessionReadyV5: true},
    tabs: [{
      id: 121,
      active: true,
      index: 3,
      url: "https://source.example/late-wrapper",
      windowId: 21,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  harness.bookmarkMap.get("late-wrapper").url = legacyWrapper;
  await harness.events.bookmarkChanged.emit("late-wrapper", {url: legacyWrapper});
  await harness.settle();
  const authenticatedWrapper = harness.bookmarkMap.get("late-wrapper").url;
  const wrapperMarker = TARGET_URL_TOOLS.readMarker(authenticatedWrapper);
  assert.equal(wrapperMarker?.mode, "m");
  assert.equal(wrapperMarker?.originalUrl, legacyWrapper);

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 121,
    timeStamp: 1210,
    url: authenticatedWrapper,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);

  await harness.sendRuntimeMessage({
    type: "updateSettings",
    data: {enabled: false},
  });
  assert.equal(harness.bookmarkMap.get("late-wrapper").url, original);
}

async function testDraftV4MarkerMigratesToAuthenticatedFormat() {
  const original = "https://example.com/draft-v4?view=old#proof";
  const draft = draftV4MarkedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "draft-v4", title: "draft", url: draft}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 4,
        bookmarkState: "enabled",
      },
    },
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  const migrated = harness.bookmarkMap.get("draft-v4").url;
  const marker = TARGET_URL_TOOLS.readMarker(migrated);
  assert.ok(marker);
  assert.equal(marker.owner, KNOWN_MARKER_SECRET);
  assert.equal(marker.originalUrl, original);
  assert.notEqual(migrated, draft);
  assert.equal(harness.localData.runtimeState.bookmarkFormatVersion, 5);
}

async function testNewBookmarkHandlingStartsWithoutTimer() {
  const original = "https://example.com/created-immediately";
  const harness = createHarness({
    sessionData: {sessionReadyV5: true},
  });
  await harness.sendRuntimeMessage({type: "getSettings"});
  const updatesBefore = harness.calls.bookmarkUpdateStarts.length;
  const bookmark = {
    id: "created-now",
    title: "created now",
    url: original,
  };
  harness.bookmarkMap.set(bookmark.id, {...bookmark});

  await harness.events.bookmarkCreated.emit(bookmark.id, {...bookmark});
  await waitUntil(
    () => harness.calls.bookmarkUpdateStarts.length > updatesBefore,
    "new bookmark handling was deferred behind a timer"
  );

  const marker = TARGET_URL_TOOLS.readMarker(
    harness.bookmarkMap.get(bookmark.id).url
  );
  assert.ok(marker);
  assert.equal(marker.owner, KNOWN_MARKER_SECRET);
  assert.equal(marker.originalUrl, original);
}

async function testChangedBookmarkUsesFreshChromeValue() {
  const initial = "https://example.com/change-initial";
  const latest = "https://example.com/change-latest?revision=2#final";
  const stalePayload = "https://example.com/change-stale?revision=1";
  const harness = createHarness({
    bookmarks: [{id: "changed-fresh", title: "changed", url: markedUrl(initial)}],
    sessionData: {sessionReadyV5: true},
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  harness.bookmarkMap.get("changed-fresh").url = latest;
  await harness.events.bookmarkChanged.emit("changed-fresh", {
    url: stalePayload,
  });
  await waitUntil(() => {
    const marker = TARGET_URL_TOOLS.readMarker(
      harness.bookmarkMap.get("changed-fresh").url
    );
    return marker?.originalUrl === latest;
  }, "changed-bookmark repair replayed a stale event payload");

  const repaired = harness.bookmarkMap.get("changed-fresh").url;
  assert.equal(TARGET_URL_TOOLS.readMarker(repaired).owner, KNOWN_MARKER_SECRET);
  assert.equal(repaired.includes("change-stale"), false);
}

async function testSecretRotationAcceptsAndRewritesPreviousOwner() {
  const original = "https://example.com/rotated-owner";
  const previousCapability =
    markerCapability(PREVIOUS_MARKER_SECRET);
  const previousMarked = TARGET_URL_TOOLS.markUrl(
    original,
    previousCapability
  );
  const harness = createHarness({
    bookmarks: [{id: "rotated", title: "rotated", url: previousMarked}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 5,
        bookmarkState: "enabled",
        markerSecretApplied: PREVIOUS_MARKER_SECRET,
      },
    },
    syncData: {
      syncStateV4: {
        markerSecret: KNOWN_MARKER_SECRET,
        previousMarkerSecrets: [PREVIOUS_MARKER_SECRET],
        legacyCompatibilityEnabled: false,
        legacyAllowAmbiguousSingle: false,
      },
    },
    tabs: [{
      id: 117,
      active: true,
      index: 2,
      url: "https://source.example/rotation",
      windowId: 20,
    }],
  });
  await harness.sendRuntimeMessage({type: "getSettings"});

  const rewritten = harness.bookmarkMap.get("rotated").url;
  const rewrittenMarker = TARGET_URL_TOOLS.readMarker(rewritten);
  assert.ok(rewrittenMarker);
  assert.equal(rewrittenMarker.owner, KNOWN_MARKER_SECRET);
  assert.equal(rewrittenMarker.originalUrl, original);
  assert.equal(
    harness.syncData.syncStateV4.previousMarkerSecrets.includes(
      PREVIOUS_MARKER_SECRET
    ),
    true
  );
  for (const owner of [KNOWN_MARKER_SECRET, PREVIOUS_MARKER_SECRET]) {
    assert.equal(
      harness.dynamicRules.some((rule) =>
        rule.condition?.regexFilter?.includes(owner)),
      true,
      `navigation rules must accept owner ${owner}`
    );
  }

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 117,
    timeStamp: 1170,
    url: previousMarked,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);
}

async function testFocusDisabledHasOneOpener() {
  const original = "https://example.com/report?month=august#summary";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "1", title: "report", url: marked}],
    settings: {focusNewTab: false},
    tabs: [{
      id: 10,
      active: true,
      index: 2,
      url: "https://open.spotify.com/collection/tracks",
      windowId: 7,
    }],
  });
  await harness.settle();

  await navigateAndRedirect(
    harness,
    {frameId: 0, tabId: 10, url: marked},
    101
  );

  const actions = destinationActions(harness, [original]);
  assert.equal(actions.length, 1, "one bookmark click must have one opener");
  assert.equal(actions[0].kind, "create");
  assert.equal(harness.calls.createdTabs[0].active, false);
  assert.equal(harness.calls.createdTabs[0].windowId, 7);
  assert.equal(harness.calls.updatedTabs.length, 0);
}

async function testCraftedMarkerStaysInExactSource() {
  const original = "https://example.com/copied-marker?view=shared#section";
  const crafted = markedUrl(original);
  const harness = createHarness({
    tabs: [{
      id: 11,
      active: true,
      index: 4,
      url: "https://unrelated.example/source",
      windowId: 3,
    }],
  });
  await harness.settle();

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 11,
    timeStamp: 1100,
    url: crafted,
  });
  await harness.settle();

  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 11,
    kind: "update",
    url: original,
  }]);
  assert.deepEqual(
    harness.calls.createdTabs,
    [],
    "an unbookmarked marker must not gain new-tab behavior"
  );
  assert.deepEqual(
    harness.calls.queries,
    [],
    "crafted-marker recovery must update only the exact source tab"
  );
}

async function testLeakedNonceCannotUpgradeCleanBookmarkToNewTab() {
  const original = "https://example.com/bookmarked-without-capability";
  const leaked = TARGET_URL_TOOLS.markUrl(
    original,
    markerCapability(KNOWN_MARKER_SECRET, "m", "b".repeat(64))
  );
  const harness = createHarness({
    tabs: [{
      id: 115,
      active: true,
      index: 4,
      url: "https://unrelated.example/source",
      windowId: 3,
    }],
  });
  await harness.settle();

  // Model a clean URL arriving from sync after startup. The destination is a
  // bookmark, but the leaked current-shaped capability URL is not.
  harness.bookmarkMap.set("clean-only", {
    id: "clean-only",
    title: "clean only",
    url: original,
  });
  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 115,
    timeStamp: 1150,
    url: leaked,
  });
  await harness.settle();

  assert.deepEqual(harness.calls.createdTabs, []);
  assert.deepEqual(harness.calls.tabCreateAttempts, []);
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 115,
    kind: "update",
    url: original,
  }], "a leaked nonce may recover only its exact source tab");
}

async function testWrongAndMiddleMarkersAreIgnored() {
  const original = "https://example.com/marker-shape";
  const finalMarker = markedUrl(original);
  const markerPair =
    `${TARGET_MARKER_PARAMETER}=${KNOWN_MARKER_CAPABILITY}`;
  const wrongNonce = "a".repeat(64);
  const candidates = [
    finalMarker.replace(KNOWN_MARKER_NONCE, wrongNonce),
    finalMarker.replace(markerPair, `${markerPair}&ordinary=1`),
  ];
  const harness = createHarness({
    bookmarks: [{id: "marker-shape", title: "marker", url: finalMarker}],
    tabs: candidates.map((url, index) => ({
      id: 12 + index,
      active: index === 0,
      index,
      pendingUrl: url,
      url: "https://unrelated.example/source",
      windowId: 3,
    })),
  });
  await harness.settle();

  for (let index = 0; index < candidates.length; index += 1) {
    await harness.events.beforeNavigate.emit({
      frameId: 0,
      tabId: 12 + index,
      timeStamp: 1200 + index,
      url: candidates[index],
    });
  }
  await harness.settle();

  assert.deepEqual(harness.calls.createdTabs, []);
  assert.deepEqual(harness.calls.tabCreateAttempts, []);
}

async function testDuplicateTimestampDoesNotSuppressLaterClick() {
  const original = "https://example.com/repeat-click";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "14", title: "repeat", url: marked}],
    tabs: [{
      id: 14,
      active: true,
      index: 1,
      url: "https://unrelated.example/source",
      windowId: 6,
    }],
  });
  await harness.settle();

  const event = {
    frameId: 0,
    tabId: 14,
    timeStamp: 1400,
    url: marked,
  };
  await harness.events.beforeNavigate.emit(event);
  await harness.settle();
  await harness.events.beforeNavigate.emit({...event});
  await harness.settle();
  assert.equal(
    destinationActions(harness, [original]).length,
    1,
    "the same browser event must be claimed only once"
  );

  await harness.events.beforeNavigate.emit({...event, timeStamp: 1401});
  await harness.settle();
  assert.equal(
    destinationActions(harness, [original]).length,
    2,
    "a later click with a distinct browser timestamp must still open"
  );
}

async function testFocusAndPositionMatrix() {
  const cases = [
    {focusNewTab: false, position: "right"},
    {focusNewTab: true, position: "right"},
    {focusNewTab: false, position: "end"},
    {focusNewTab: true, position: "end"},
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const original = `https://example.com/placement/${index}`;
    const marked = markedUrl(original);
    const harness = createHarness({
      bookmarks: [{id: String(20 + index), title: "place", url: marked}],
      settings: testCase,
      tabs: [{
        id: 20 + index,
        active: true,
        index: 5,
        url: "https://unrelated.example/source",
        windowId: 10,
      }],
    });
    await harness.settle();
    await harness.events.beforeNavigate.emit({
      frameId: 0,
      tabId: 20 + index,
      timeStamp: 2000 + index,
      url: marked,
    });
    await harness.settle();

    assert.equal(harness.calls.createdTabs.length, 1);
    const [created] = harness.calls.createdTabs;
    assert.equal(created.active, testCase.focusNewTab);
    assert.equal(created.windowId, 10);
    if (testCase.position === "right") {
      assert.equal(created.index, 6);
    } else {
      assert.equal(
        Object.hasOwn(created, "index"),
        false,
        "end placement must let Chrome append the tab"
      );
    }
  }
}

async function testWindowClosingSourceSuppressesReplacement() {
  const original = "https://example.com/window-closing";
  const marked = markedUrl(original);
  const source = {
    id: 30,
    active: false,
    index: 2,
    pendingUrl: marked,
    url: "about:blank",
    windowId: 12,
  };
  const harness = createHarness({
    bookmarks: [{id: "30", title: "closing", url: marked}],
    tabUpdateDelayMs: 30,
    tabs: [source],
  });
  await harness.settle();
  await harness.events.tabCreated.emit({...source});

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 30,
    timeStamp: 3000,
    url: marked,
  });
  harness.tabMap.delete(30);
  await harness.events.tabRemoved.emit(30, {
    isWindowClosing: true,
    windowId: 12,
  });
  await harness.settle(120);

  assert.deepEqual(destinationActions(harness, [original]), []);
  assert.deepEqual(
    harness.calls.tabCreateAttempts,
    [],
    "closing a window must not resurrect its cancelled source elsewhere"
  );
}

async function testTabCreationRetriesAtMostOnce() {
  const original = "https://example.com/create-retry";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "31", title: "retry", url: marked}],
    settings: {focusNewTab: false, position: "right"},
    tabCreateFailureCount: 3,
    tabs: [{
      id: 31,
      active: true,
      index: 7,
      url: "https://unrelated.example/source",
      windowId: 13,
    }],
  });
  await harness.settle();

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 31,
    timeStamp: 3100,
    url: marked,
  });
  await harness.settle(120);

  assert.equal(
    harness.calls.tabCreateAttempts.length,
    2,
    "a failed same-window creation may have only one context-free retry"
  );
  assert.equal(harness.calls.tabCreateAttempts[0].windowId, 13);
  assert.equal(harness.calls.tabCreateAttempts[0].index, 8);
  assert.equal(
    Object.hasOwn(harness.calls.tabCreateAttempts[1], "windowId"),
    false
  );
  assert.equal(
    Object.hasOwn(harness.calls.tabCreateAttempts[1], "index"),
    false
  );
  assert.deepEqual(harness.calls.createdTabs, []);
}

async function testReplacementRestoresExistingGroup() {
  const original = "https://example.com/grouped-replacement";
  const marked = markedUrl(original);
  const source = {
    id: 32,
    active: false,
    groupId: 37,
    index: 3,
    pendingUrl: marked,
    url: "about:blank",
    windowId: 14,
  };
  const harness = createHarness({
    bookmarks: [{id: "32", title: "grouped", url: marked}],
    tabUpdateDelayMs: 30,
    tabs: [source],
  });
  await harness.settle();
  await harness.events.tabCreated.emit({...source});

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 32,
    timeStamp: 3200,
    url: marked,
  });
  harness.tabMap.delete(32);
  await harness.events.tabRemoved.emit(32, {
    isWindowClosing: false,
    windowId: 14,
  });
  await harness.settle(160);

  const [replacement] = harness.calls.createdTabs.filter(
    (tab) => tab.url === original
  );
  assert.ok(replacement, "the vanished grouped source needs a replacement");
  assert.deepEqual(harness.calls.tabGroups, [{
    groupId: 37,
    tabIds: replacement.id,
  }]);
}

async function testOpenAllKeepsIndependentSourceTabs() {
  const originals = [
    "https://example.com/folder/one",
    "https://example.net/folder/two",
    "http://192.168.8.9:8080/folder/three",
  ];
  const marked = originals.map(markedUrl);
  const bookmarks = marked.map((url, index) => ({
    id: String(index + 1),
    title: `folder ${index + 1}`,
    url,
  }));
  const tabs = marked.map((url, index) => ({
    id: 21 + index,
    active: false,
    index: 3 + index,
    pendingUrl: url,
    url: "about:blank",
    windowId: 5,
  }));
  tabs.push({
    id: 99,
    active: true,
    index: 0,
    url: "chrome://newtab/",
    windowId: 5,
  });
  const harness = createHarness({bookmarks, tabs});
  await harness.settle();

  await Promise.all(marked.map((url, index) => harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 21 + index,
    url,
  })));
  await harness.settle();
  if (harness.events.downloadCreated.listeners.length > 0) {
    await Promise.all(marked.map((url, index) =>
      harness.emitDummyDownload(200 + index, url)));
    await harness.settle();
  }

  const actions = destinationActions(harness, originals);
  assert.equal(actions.length, 3, "Open all must preserve all three destinations");
  for (let index = 0; index < originals.length; index += 1) {
    assert.deepEqual(
      actions.filter((action) => action.url === originals[index]),
      [{id: 21 + index, kind: "update", url: originals[index]}]
    );
  }
  assert.equal(
    harness.calls.updatedTabs.some((update) => update.id === 99),
    false,
    "a source-less fallback must not overwrite the active blank tab"
  );
  assert.equal(harness.calls.queries.length, 0, "source identity must not use active-tab lookup");
  assert.deepEqual(harness.calls.goBacks, []);
  assert.deepEqual(harness.calls.removedTabs, []);
}

async function testGmailAndLanOpenExactlyOnce() {
  const originals = [
    "https://mail.google.com/mail/u/0/#inbox",
    "http://192.168.1.42:3000/admin?view=network#status",
  ];
  const marked = originals.map(markedUrl);
  const harness = createHarness({
    bookmarks: marked.map((url, index) => ({
      id: String(40 + index),
      title: index === 0 ? "Gmail" : "Router",
      url,
    })),
    tabs: marked.map((url, index) => ({
      id: 40 + index,
      active: index === 0,
      index,
      pendingUrl: url,
      url: "https://example.org/source",
      windowId: 4,
    })),
  });
  await harness.settle();

  for (let index = 0; index < marked.length; index += 1) {
    await navigateAndRedirect(
      harness,
      {frameId: 0, tabId: 40 + index, url: marked[index]},
      300 + index
    );
  }

  const actions = destinationActions(harness, originals);
  assert.equal(actions.length, 2);
  for (const original of originals) {
    assert.equal(
      actions.filter((action) => action.url === original).length,
      1,
      `${original} must open exactly once`
    );
  }
}

async function testOpenAllRecoversTransientTabsRemovedByCancellation() {
  const originals = [
    "https://example.com/recover/one",
    "https://example.net/recover/two",
    "http://192.168.10.5/recover/three",
  ];
  const marked = originals.map(markedUrl);
  const sources = marked.map((url, index) => ({
    id: 61 + index,
    active: false,
    index: 4 + index,
    pendingUrl: url,
    url: "about:blank",
    windowId: 8,
  }));
  const harness = createHarness({
    bookmarks: marked.map((url, index) => ({
      id: String(61 + index),
      title: `recover ${index + 1}`,
      url,
    })),
    tabGetDelayMs: 25,
    tabUpdateDelayMs: 25,
    tabs: [
      ...sources,
      {id: 69, active: true, index: 0, url: "chrome://newtab/", windowId: 8},
    ],
  });
  await harness.settle();
  await Promise.all(sources.map((tab) => harness.events.tabCreated.emit({...tab})));

  const navigationPromises = marked.map((url, index) =>
    harness.events.beforeNavigate.emit({frameId: 0, tabId: 61 + index, url}));
  await Promise.resolve();
  for (const source of sources) {
    harness.tabMap.delete(source.id);
    await harness.events.tabRemoved.emit(source.id, {
      isWindowClosing: false,
      windowId: 8,
    });
  }
  await Promise.all(navigationPromises);
  await harness.settle(120);

  const actions = destinationActions(harness, originals);
  assert.equal(
    actions.length,
    3,
    "each cancelled transient source must receive exactly one replacement"
  );
  for (const original of originals) {
    const [replacement] = harness.calls.createdTabs.filter(
      (tab) => tab.url === original
    );
    assert.ok(replacement, `${original} must not disappear with its source tab`);
    assert.equal(replacement.active, false);
    assert.equal(replacement.windowId, 8);
  }
  assert.equal(
    harness.calls.updatedTabs.some((update) => update.id === 69),
    false,
    "replacement recovery must not converge on the active blank tab"
  );
  assert.equal(harness.calls.queries.length, 0);
  assert.deepEqual(harness.calls.removedTabs, []);
}

async function testNavigationDoesNotWaitForBookmarkMaintenance() {
  const original = "https://example.com/maintenance-independent";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarkUpdateDelayMs: 250,
    bookmarks: [
      {id: "70", title: "destination", url: marked},
      {id: "71", title: "being edited", url: "https://example.net/before"},
    ],
    tabs: [{
      id: 70,
      active: true,
      index: 0,
      url: "https://example.org/source",
      windowId: 6,
    }],
  });
  await harness.settle();

  harness.bookmarkMap.get("71").url = "https://example.net/after";
  await harness.events.bookmarkChanged.emit("71", {
    url: "https://example.net/after",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.calls.bookmarkUpdateStarts.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.calls.bookmarkUpdateStarts.length, 1);

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 70,
    timeStamp: 1000,
    url: marked,
  });
  await harness.settle();
  const actions = destinationActions(harness, [original]);
  assert.equal(
    actions.length,
    1,
    "navigation ownership must not queue behind a slow bookmark write"
  );
  await harness.settle(260);
}

async function testColdLegacyMigrationStateStillOwnsClick() {
  const original = "https://example.com/legacy-cold-start";
  const legacy = legacyMarkedUrl(original);
  const harness = createHarness({
    bookmarkUpdateDelayMs: 120,
    bookmarks: [{id: "80", title: "legacy", url: legacy}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
        migrationAllowAmbiguousSingle: true,
        migrationMode: "legacy",
      },
    },
    tabs: [{
      id: 80,
      active: true,
      index: 0,
      url: "https://example.org/source",
      windowId: 9,
    }],
  });

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 80,
    timeStamp: 2000,
    url: legacy,
  });
  await harness.settle(70);
  const actions = destinationActions(harness, [original]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "create");
  await harness.settle(150);
}

async function testLegacyCompatibilityRequiresBookmarkProof() {
  const legitimate = "https://newtab@example.com/private";
  const intactSource = "https://source.example/keep-this-document";
  const migrationGate = new Promise(() => {});
  const unverified = createHarness({
    bookmarkUpdateGate: migrationGate,
    bookmarks: [{
      id: "migration-blocker",
      title: "migration blocker",
      url: legacyMarkedUrl("https://example.com/migration-blocker"),
    }],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
        legacyCompatibilityEnabled: true,
        migrationAllowAmbiguousSingle: true,
        migrationMode: "legacy",
      },
    },
    tabs: [{
      id: 81,
      active: true,
      index: 1,
      pendingUrl: legitimate,
      url: intactSource,
      windowId: 9,
    }],
  });
  await waitUntil(
    () => unverified.dynamicRules.some((rule) =>
      rule.condition?.regexFilter === "^https?://newtab(?:@|%40)"),
    "schema migration never activated broad legacy interception"
  );

  await unverified.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 81,
    timeStamp: 2010,
    url: legitimate,
  });
  await unverified.settle();

  assert.deepEqual(unverified.calls.createdTabs, []);
  assert.deepEqual(unverified.calls.updatedTabs, []);
  assert.deepEqual(unverified.calls.tabCreateAttempts, []);
  assert.equal(unverified.tabMap.get(81).url, intactSource);
  assert.equal(
    unverified.tabMap.get(81).pendingUrl,
    legitimate,
    "an unverified Basic Auth username must never be stripped"
  );

  const original = "https://example.com/verified-legacy-blank-source";
  const legacy = legacyMarkedUrl(original);
  const blankSource = {
    id: 82,
    active: false,
    index: 2,
    pendingUrl: legacy,
    url: "about:blank",
    windowId: 9,
  };
  const verified = createHarness({
    bookmarkUpdateDelayMs: 120,
    bookmarks: [{id: "82", title: "verified legacy", url: legacy}],
    localData: {
      runtimeState: {
        bookmarkFormatVersion: 2,
        bookmarkState: "enabled",
        legacyCompatibilityEnabled: true,
        migrationAllowAmbiguousSingle: true,
        migrationMode: "legacy",
      },
    },
    tabs: [blankSource],
  });
  await verified.events.tabCreated.emit({...blankSource});
  await verified.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 82,
    timeStamp: 2020,
    url: legacy,
  });
  await verified.settle(180);

  assert.deepEqual(verified.calls.createdTabs, []);
  assert.deepEqual(destinationActions(verified, [original]), [{
    id: 82,
    kind: "update",
    url: original,
  }], "a verified legacy blank source must reuse its exact tab");
}

async function testColdReplacementUsesStoredFocusSetting() {
  const original = "https://example.com/cold-focus-setting";
  const marked = markedUrl(original);
  const source = {
    id: 90,
    active: false,
    index: 3,
    pendingUrl: marked,
    url: "about:blank",
    windowId: 11,
  };
  const harness = createHarness({
    bookmarks: [{id: "90", title: "cold", url: marked}],
    settings: {focusNewTab: false},
    storageGetDelayMs: 80,
    tabUpdateDelayMs: 25,
    tabs: [source],
  });
  await harness.events.tabCreated.emit({...source});

  const navigation = harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 90,
    timeStamp: 3000,
    url: marked,
  });
  await Promise.resolve();
  harness.tabMap.delete(90);
  await harness.events.tabRemoved.emit(90, {
    isWindowClosing: false,
    windowId: 11,
  });
  await navigation;
  await harness.settle(220);

  const [replacement] = harness.calls.createdTabs.filter(
    (tab) => tab.url === original
  );
  assert.ok(replacement);
  assert.equal(
    replacement.active,
    false,
    "a cold-worker replacement must honor stored focusNewTab=false"
  );
}

async function testPersistedOwnerRuleRecoversAfterInitializationFailure() {
  const original = "https://example.com/init-failure-recovery";
  const marked = markedUrl(original);
  const forged = markedUrl("https://example.com/not-bookmarked");
  const harness = createHarness({
    bookmarks: [{id: "init-failure", title: "verified", url: marked}],
    dynamicRules: [{
      id: 1,
      priority: 1,
      action: {type: "redirect", redirect: {extensionPath: "/cancel.html"}},
      condition: {
        regexFilter: TARGET_URL_TOOLS.markerRegexFilter(KNOWN_MARKER_SECRET),
        resourceTypes: ["main_frame"],
      },
    }],
    storageGetFailure: ({areaName}) => (
      areaName === "sync" ? new Error("Simulated sync storage outage") : null
    ),
    tabs: [{
      id: 83,
      active: true,
      index: 2,
      url: "https://open.spotify.com/collection/tracks",
      windowId: 7,
    }],
  });
  await harness.settle();

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 83,
    timeStamp: 830,
    url: marked,
  });
  await harness.settle();
  assert.deepEqual(destinationActions(harness, [original]), [{
    id: 1000,
    kind: "create",
    url: original,
  }]);
  assert.equal(harness.tabMap.get(83).url, "https://open.spotify.com/collection/tracks");

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 83,
    timeStamp: 831,
    url: forged,
  });
  await harness.settle();
  assert.equal(
    harness.calls.createdTabs.length,
    1,
    "a persisted owner alone must not grant unbookmarked URLs new-tab behavior"
  );
  assert.equal(harness.tabMap.get(83).url, "https://open.spotify.com/collection/tracks");
}

async function testAcceptedOwnerWithoutRuleCannotDuplicateOnInitFailure() {
  const original = "https://example.com/pre-rule-init-failure";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "pre-rule-failure", title: "verified", url: marked}],
    regexSupportFailure: () => "simulatedRuleInstallFailure",
    tabs: [{
      id: 84,
      active: true,
      index: 4,
      url: "https://open.spotify.com/collection/tracks",
      windowId: 7,
    }],
  });
  await harness.settle();
  assert.deepEqual(harness.dynamicRules, []);

  await harness.events.beforeNavigate.emit({
    frameId: 0,
    tabId: 84,
    timeStamp: 840,
    url: marked,
  });
  await harness.settle();
  assert.deepEqual(harness.calls.createdTabs, []);
  assert.equal(
    harness.tabMap.get(84).url,
    original,
    "without a persisted cancel rule, recovery must stay in the exact source"
  );
}

async function testCommittedNavigationNeverDestroysSourceTab() {
  const original = "https://example.com/no-history";
  const marked = markedUrl(original);
  const harness = createHarness({
    bookmarks: [{id: "50", title: "safe", url: marked}],
    tabs: [{
      id: 50,
      active: true,
      index: 0,
      url: "https://example.org/source",
      windowId: 3,
    }],
  });
  await harness.settle();

  await harness.events.beforeNavigate.emit({frameId: 0, tabId: 50, url: marked});
  await harness.settle();
  await harness.events.committed.emit({frameId: 0, tabId: 50, url: original});
  await harness.settle();

  assert.deepEqual(harness.calls.goBacks, [], "the extension must not mutate history");
  assert.deepEqual(harness.calls.removedTabs, [], "the extension must never remove source tabs");
  assert.equal(harness.tabMap.has(50), true);
}

async function testCancellationUsesTypedNoContentResponse() {
  const harness = createHarness();
  await harness.settle();
  assert.equal(harness.fetchListeners.length, 1);

  let responsePromise;
  harness.fetchListeners[0]({
    request: {url: `chrome-extension://${EXTENSION_ID}/cancel.html`},
    respondWith: (value) => {
      responsePromise = Promise.resolve(value);
    },
  });
  const response = await responsePromise;
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Content-Disposition"), null);

  const rule = harness.dynamicRules.find((candidate) =>
    candidate.action?.redirect?.extensionPath === "/cancel.html");
  assert.ok(rule, "a dynamic main-frame rule must redirect markers to cancel.html");
  assert.deepEqual(clone(rule.condition.resourceTypes), ["main_frame"]);
}

async function testPackageContainsNoDownloadMechanism() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "manifest.json"),
    "utf8"
  ));
  const harness = createHarness();
  await harness.settle();

  assert.equal(manifest.version, "2.4.0");
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.permissions.includes("alarms"), false);
  assert.equal("declarative_net_request" in manifest, false);
  assert.equal(fs.existsSync(path.join(ROOT, "empty.zip")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "rules.json")), false);
  assert.equal(
    fs.existsSync(path.join(ROOT, "_metadata/generated_indexed_rulesets/_ruleset1")),
    false
  );
  assert.equal(harness.events.downloadCreated.listeners.length, 0);
  assert.equal(harness.events.alarm.listeners.length, 0);
  assert.deepEqual(harness.calls.alarmCreates, []);
  assert.deepEqual(harness.calls.downloadUiOptions, []);
  assert.equal(backgroundSource.includes("chrome.downloads"), false);
  assert.equal(backgroundSource.includes("chrome.alarms"), false);
  assert.match(
    JSON.stringify(manifest.web_accessible_resources),
    /cancel\.html/
  );
  assert.equal(
    markedUrl("https://example.com/path#fragment").includes(
      `${TARGET_MARKER_PARAMETER}=${KNOWN_MARKER_CAPABILITY}`
    ),
    true,
    "2.4 bookmarks must use the namespaced query marker"
  );
}

const tests = [
  ["settings use sync as canonical storage", testSettingsUseSyncAsCanonicalStorage],
  ["fresh per-bookmark nonces are private", testFreshPerBookmarkNoncesArePrivate],
  ["v3 and mixed legacy layers migrate cleanly", testV3AndMixedLegacyLayersMigrateForUpgrade],
  ["pause transition still owns marked clicks", testPauseTransitionStillOwnsMarkedClick],
  ["backup limits and failures do not block migration", testLegacyBackupLimitsAndFailuresDoNotBlockMigration],
  ["pre-v3 cold start installs legacy interception first", testPreV3ColdStartInstallsLegacyRuleImmediately],
  ["interrupted operation resumes on cold start", testInterruptedOperationResumesOnColdStart],
  ["Pause completes a failed schema migration", testPauseResumesFailedSchemaMigrationBeforeCommitting],
  ["cold direct re-enable reconciles clean bookmarks", testColdReenableReconcilesNewCleanBookmark],
  ["foreign markers round-trip inside the owned marker", testForeignAuthenticatedMarkerRoundTripsInsideOwnedMarker],
  ["legacy provenance syncs across devices", testLegacyCompatibilityProvenanceSyncsAcrossDevices],
  ["post-migration Basic Auth bookmarks round-trip", testPostMigrationBasicAuthBookmarkRoundTripsIntact],
  ["ordinary 2.3 prefixes around m markers clean", testOrdinaryLegacyPrefixAroundManagedMarkerCleans],
  ["exact 2.3 wrappers around owned markers clean", testExactLegacyWrapperAroundManagedMarkerCleans],
  ["late pure 2.3 wrappers are authenticated", testPureLegacyWrapperArrivingAfterMigrationIsAuthenticated],
  ["draft v4 markers migrate to authenticated format", testDraftV4MarkerMigratesToAuthenticatedFormat],
  ["new bookmark handling starts without a timer", testNewBookmarkHandlingStartsWithoutTimer],
  ["changed bookmarks use the fresh Chrome value", testChangedBookmarkUsesFreshChromeValue],
  ["secret rotation rewrites and accepts the previous owner", testSecretRotationAcceptsAndRewritesPreviousOwner],
  ["focus disabled has one opener", testFocusDisabledHasOneOpener],
  ["crafted marker stays in its exact source", testCraftedMarkerStaysInExactSource],
  ["leaked nonce cannot upgrade a clean bookmark", testLeakedNonceCannotUpgradeCleanBookmarkToNewTab],
  ["wrong nonce never opens and middle marker is ignored", testWrongAndMiddleMarkersAreIgnored],
  ["event dedup preserves a legitimate later click", testDuplicateTimestampDoesNotSuppressLaterClick],
  ["focus and position settings form the expected matrix", testFocusAndPositionMatrix],
  ["window-closing sources suppress replacement", testWindowClosingSourceSuppressesReplacement],
  ["tab creation retries at most once", testTabCreationRetriesAtMostOnce],
  ["replacement restores an existing tab group", testReplacementRestoresExistingGroup],
  ["Open all keeps independent source tabs", testOpenAllKeepsIndependentSourceTabs],
  ["Gmail and LAN bookmarks open once", testGmailAndLanOpenExactlyOnce],
  ["Open all recovers transient source tabs", testOpenAllRecoversTransientTabsRemovedByCancellation],
  ["navigation bypasses bookmark maintenance", testNavigationDoesNotWaitForBookmarkMaintenance],
  ["cold legacy state still owns its click", testColdLegacyMigrationStateStillOwnsClick],
  ["legacy compatibility requires bookmark proof", testLegacyCompatibilityRequiresBookmarkProof],
  ["cold replacement honors stored focus setting", testColdReplacementUsesStoredFocusSetting],
  ["persisted rules recover after initialization failure", testPersistedOwnerRuleRecoversAfterInitializationFailure],
  ["accepted owners without rules cannot duplicate", testAcceptedOwnerWithoutRuleCannotDuplicateOnInitFailure],
  ["committed navigation never destroys source tabs", testCommittedNavigationNeverDestroysSourceTab],
  ["cancellation uses a typed 204 response", testCancellationUsesTypedNoContentResponse],
  ["package contains no download mechanism", testPackageContainsNoDownloadMechanism],
];

(async () => {
  const failures = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push({name, error});
      console.error(`not ok - ${name}`);
      console.error(error.stack || error);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${tests.length} regression tests failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${tests.length} background regression tests passed.`);
})();
