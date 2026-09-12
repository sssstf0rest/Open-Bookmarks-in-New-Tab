const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = join(__dirname, "..");
const source = readFileSync(join(root, "js/background.js"), "utf8");
const cancelUrl = "chrome-extension://test-extension/cancel.html";
const marked = "https://newtab@example.com/";
const clean = "https://example.com/";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const listeners = {};
  const timers = [];
  const calls = { create: [], update: [], back: [], rules: [], bookmarks: [] };
  const tabs = new Map([[1, {
    id: 1, url: "https://source.example/", windowId: 7, index: 2, active: true,
  }], ...(options.tabs || [])]);
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://test-extension/" + path,
      onMessage: event("message"), onInstalled: event("installed"),
    },
    storage: {
      sync: {
        get: () => options.settingsPromise || Promise.resolve({ settings: options.settings }),
        set: async () => {},
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: event("storage"),
    },
    bookmarks: {
      onCreated: event("bookmarkCreated"), onChanged: event("bookmarkChanged"),
      getTree: async () => options.tree || [],
      get: async () => [],
      update: async (id, props) => calls.bookmarks.push([id, plain(props)]),
    },
    declarativeNetRequest: {
      getEnabledRulesets: async () => ["newtab_redirect"],
      updateEnabledRulesets: async (props) => calls.rules.push(plain(props)),
    },
    webNavigation: {
      onBeforeNavigate: event("before"), onCommitted: event("commit"),
      onErrorOccurred: event("error"),
    },
    tabs: {
      get: async (id) => {
        if (options.getTab) return options.getTab(id, tabs);
        if (!tabs.has(id)) throw new Error("Tab closed");
        return tabs.get(id);
      },
      create: async (props) => {
        calls.create.push(plain(props));
        if (options.create) await options.create(props);
        return { id: 99, ...props };
      },
      update: async (id, props) => {
        calls.update.push([id, plain(props)]);
        if (options.update) await options.update(id, props, listeners);
      },
      goBack: async (id) => {
        calls.back.push(id);
        if (options.backFails) throw new Error("No history");
      },
      onRemoved: event("removed"),
      // Intentionally no remove/query/downloads/alarms APIs: using them fails.
    },
  };
  const context = vm.createContext({
    chrome, URL, Response,
    self: { addEventListener(name, fn) { listeners[name] = fn; } },
    console: { log() {}, warn() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    listeners, calls, tabs, timers,
    navigate: (url = marked, tabId = 1) => listeners.before({ frameId: 0, tabId, url }),
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test("DNR and manifest expose only the non-download cancellation endpoint", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json")));
  const rules = JSON.parse(readFileSync(join(root, "rules.json")));
  assert(!manifest.permissions.some((p) => p.startsWith("downloads") || p === "alarms"));
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["cancel.html"]);
  assert.equal(rules[0].action.redirect.extensionPath, "/cancel.html");
  assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
  assert(new RegExp(rules[0].condition.regexFilter).test(marked));
  assert(!new RegExp(rules[0].condition.regexFilter).test(clean));
  assert.doesNotMatch(source, /chrome\.(downloads|alarms)\b|empty\.zip/);
  assert.match(readFileSync(join(root, "cancel.html"), "utf8"), /<!doctype html>/i);
});

test("fetch returns a bodyless HTML 204 synchronously, even before settings load", async () => {
  const gate = deferred();
  const h = harness({ settingsPromise: gate.promise });
  let response;
  h.listeners.fetch({ request: { url: cancelUrl, method: "GET" }, respondWith(r) { response = r; } });
  assert(response instanceof Response);
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Disposition"), null);
  assert.equal(h.calls.create.length, 0);
  gate.resolve({});
});

test("fetch ignores unrelated resources, remote URLs, query variants and methods", () => {
  const h = harness();
  for (const [url, method] of [
    [clean, "GET"], [cancelUrl + "?x=1", "GET"],
    [cancelUrl.replace("cancel.html", "popup.html"), "GET"], [cancelUrl, "POST"],
  ]) {
    h.listeners.fetch({ request: { url, method }, respondWith() { assert.fail("Unexpected interception"); } });
  }
});

for (const focusNewTab of [true, false]) {
  test(`occupied tab opens once with focus=${focusNewTab} and source-window placement`, async () => {
    const h = harness({ settings: { focusNewTab, position: "right" } });
    await h.navigate();
    assert.deepEqual(h.calls.create, [{ url: clean, active: focusNewTab, windowId: 7, index: 3 }]);
    assert.deepEqual(h.calls.update, []);
    assert.deepEqual(h.calls.back, []);
  });
}

for (const url of ["chrome://newtab/", "about:blank", ""]) {
  test(`blank/native tab (${JSON.stringify(url)}) is reused, not duplicated`, async () => {
    const h = harness({ tabs: [[1, { id: 1, url, pendingUrl: marked, active: false }]] });
    await h.navigate();
    assert.deepEqual(h.calls.update, [[1, { url: clean }]]);
    assert.equal(h.calls.create.length, 0);
  });
}

test("native new tab still reuses after the 204 clears pendingUrl", async () => {
  const h = harness({ tabs: [[1, { id: 1, url: "" }]] });
  await h.navigate();
  assert.deepEqual(h.calls.update, [[1, { url: clean }]]);
});

test("unavailable committed URL is not treated as a blank page", async () => {
  const h = harness({ tabs: [[1, { id: 1, windowId: 7, active: false }]] });
  await h.navigate();
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.create[0].active, false);
  assert.equal(h.calls.update.length, 0);
});

test("folder opens preserve every native tab, including repeated destinations", async () => {
  const h = harness({ tabs: [2, 3, 4].map((id) => [id, { id, url: "", pendingUrl: marked, active: false }]) });
  await Promise.all([2, 3, 4].map((id) => h.navigate(marked, id)));
  assert.deepEqual(h.calls.update.map(([id]) => id), [2, 3, 4]);
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.back.length, 0);
});

test("LAN and existing Gmail wrappers retain clean destinations", async () => {
  const h = harness();
  const lan = "http://192.168.1.2:8080/admin";
  await h.navigate(lan.replace("http://", "http://newtab@"));
  const gmail = "https://mail.google.com/mail/u/0/#inbox";
  const proxy = "https://newtab@sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/redirect.html?url=";
  await h.navigate(proxy + encodeURIComponent(gmail));
  assert.deepEqual(h.calls.create.map((t) => t.url), [lan, gmail]);
});

test("cold navigation waits for stored focus/position instead of defaults", async () => {
  const gate = deferred();
  const h = harness({ settingsPromise: gate.promise });
  const pending = h.navigate();
  await flush();
  assert.equal(h.calls.create.length, 0);
  gate.resolve({ settings: { enabled: true, focusNewTab: false, position: "right" } });
  await pending;
  assert.deepEqual(h.calls.create, [{ url: clean, active: false, windowId: 7, index: 3 }]);
});

test("paused cold worker cleans a stale marker in place", async () => {
  const h = harness({ settings: { enabled: false } });
  await h.navigate();
  assert.deepEqual(h.calls.update, [[1, { url: clean }]]);
  assert.equal(h.calls.create.length, 0);
});

test("204 abort before tab lookup resolves does not drop the destination", async () => {
  const gate = deferred();
  const h = harness({ getTab: () => gate.promise });
  const pending = h.navigate();
  h.listeners.error({ frameId: 0, tabId: 1, url: cancelUrl, error: "net::ERR_ABORTED" });
  gate.resolve({ id: 1, url: "https://source.example/", windowId: 7, active: true });
  await pending;
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.evaluate("handledTabs.size"), 0);
  await h.listeners.commit({ frameId: 0, tabId: 1, url: "https://later.example/" });
  assert.deepEqual(h.calls.back, []);
});

test("204 abort after opening clears stale restore state", async () => {
  const h = harness();
  await h.navigate();
  h.listeners.error({ frameId: 0, tabId: 1, url: marked, error: "net::ERR_ABORTED" });
  assert.equal(h.evaluate("handledTabs.size"), 0);
});

test("new user navigation supersedes an unresolved bookmark handoff", async () => {
  const gate = deferred();
  const h = harness({ getTab: () => gate.promise });
  const pending = h.navigate();
  h.navigate("https://later.example/");
  gate.resolve({ id: 1, url: "https://source.example/", windowId: 7 });
  await pending;
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.update.length, 0);
});

test("repeated clicks open once each; older expiry cannot erase the latest handoff", async () => {
  const h = harness();
  await h.navigate();
  await h.navigate();
  h.timers[0]();
  assert.equal(h.evaluate("handledTabs.size"), 1);
  assert.equal(h.calls.create.length, 2);
});

test("subframe events do not clear top-level handoffs", async () => {
  const h = harness();
  await h.navigate();
  h.listeners.before({ frameId: 2, tabId: 1, url: clean });
  h.listeners.error({ frameId: 2, tabId: 1, url: marked });
  await h.listeners.commit({ frameId: 2, tabId: 1, url: clean });
  assert.equal(h.evaluate("handledTabs.size"), 1);
  assert.equal(h.calls.back.length, 0);
});

test("reused-tab redirected commit cannot restore or close the destination", async () => {
  let committing;
  const h = harness({
    tabs: [[1, { id: 1, url: "chrome://newtab/" }]],
    update: async (id, props, listeners) => {
      committing = listeners.commit({ frameId: 0, tabId: id, url: "https://redirected.example/" });
    },
  });
  await h.navigate();
  await committing;
  assert.deepEqual(h.calls.back, []);
  assert.equal(h.calls.create.length, 0);
});

test("missed interception cleans the committed tab without creating duplicates", async () => {
  const h = harness();
  await h.listeners.commit({ frameId: 0, tabId: 1, url: marked });
  assert.deepEqual(h.calls.update, [[1, { url: clean }]]);
  assert.equal(h.calls.create.length, 0);
});

test("DNR-bypass fallback waits for opening; failed history restoration never closes tabs", async () => {
  const gate = deferred();
  const h = harness({ create: () => gate.promise, backFails: true });
  const pending = h.navigate();
  const committing = h.listeners.commit({ frameId: 0, tabId: 1, url: clean });
  gate.resolve();
  await Promise.all([pending, committing]);
  assert.equal(h.calls.create.length, 1);
  assert.deepEqual(h.calls.back, [1]);
  assert.deepEqual(h.calls.update, []);
});

test("closed source does not create a ghost tab in another window", async () => {
  const h = harness();
  h.tabs.delete(1);
  await h.navigate();
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.evaluate("handledTabs.size"), 0);
});

test("tab removal invalidates pending handoffs", async () => {
  const gate = deferred();
  const h = harness({ getTab: () => gate.promise });
  const pending = h.navigate();
  h.listeners.removed(1);
  gate.resolve({ id: 1, url: "https://source.example/" });
  await pending;
  assert.equal(h.calls.create.length, 0);
});

test("pause restores existing markers and disables DNR", async () => {
  const h = harness({ tree: [{ children: [{ id: "b1", url: marked }] }] });
  await flush();
  await h.evaluate("disableExtension()");
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: clean }]]);
  assert.deepEqual(h.calls.rules.at(-1), { disableRulesetIds: ["newtab_redirect"] });
});
