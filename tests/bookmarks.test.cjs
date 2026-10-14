const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = join(__dirname, "..");
const source = readFileSync(join(root, "js/background.js"), "utf8");
const workerScripts = [...source.matchAll(/"(worker\/[^\"]+\.js)"/g)]
  .map((match) => match[1]);
const clean = "https://example.com/";
const marked = "https://newtab@example.com/";
const pendingKey = "pendingBookmarkMarks";
const readinessKey = "bookmarkSessionReady";
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const nodes = new Map((options.bookmarks || []).map((node) => [node.id, plain(node)]));
  const tabs = new Map((options.tabs || [{
    id: 1, url: "https://other.example/", windowId: 7, active: true,
  }]).map((tab) => [tab.id, plain(tab)]));
  const session = plain(options.session === undefined ? { [readinessKey]: true } : options.session);
  const calls = { bookmarks: [], queries: [], session: [], trees: 0 };
  let timerId = 0;
  let now = 100000;
  const event = (name) => ({
    addListener(fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
  });
  const emit = (name, ...args) => Promise.all(
    (listeners.get(name) || []).map((fn) => fn(...args))
  );
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://test-extension/" + path,
      onMessage: event("message"), onInstalled: event("installed"),
    },
    storage: {
      sync: {
        get: async () => ({ settings: options.settings }),
        set: async () => {},
      },
      session: {
        get: async (keys) => {
          if (options.readSession) return options.readSession(keys, session);
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) =>
            [key, session[key] === undefined ? undefined : plain(session[key])]
          ));
        },
        set: async (values) => {
          const snapshot = plain(values);
          calls.session.push(snapshot);
          Object.assign(session, snapshot);
        },
      },
      onChanged: event("storage"),
    },
    bookmarks: {
      onCreated: event("bookmarkCreated"), onChanged: event("bookmarkChanged"),
      onRemoved: event("bookmarkRemoved"), onMoved: event("bookmarkMoved"),
      getTree: async () => {
        calls.trees++;
        if (options.readTree) return options.readTree(nodes);
        return [{ id: "root", children: [...nodes.values()].map(plain) }];
      },
      get: async (id) => {
        if (options.readBookmark) return options.readBookmark(id, nodes);
        if (!nodes.has(id)) throw new Error("Bookmark removed");
        return [plain(nodes.get(id))];
      },
      update: async (id, props) => {
        if (!nodes.has(id)) throw new Error("Bookmark removed");
        calls.bookmarks.push([id, plain(props)]);
        if (options.writeBookmark) await options.writeBookmark(id, props);
        Object.assign(nodes.get(id), props);
        await emit("bookmarkChanged", id, plain(props));
        return plain(nodes.get(id));
      },
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("Tab closed");
        return plain(tabs.get(id));
      },
      query: async (query) => {
        calls.queries.push(plain(query));
        if (options.queryTabs) return options.queryTabs(query, tabs);
        return [...tabs.values()].filter((tab) =>
          (query.active === undefined || tab.active === query.active) &&
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (!(query.currentWindow || query.lastFocusedWindow) || tab.windowId === 7)
        ).map(plain);
      },
      create: async () => ({ id: 99 }), update: async () => {}, goBack: async () => {},
      onActivated: event("activated"), onUpdated: event("updated"),
      onRemoved: event("removed"),
    },
    declarativeNetRequest: {
      getEnabledRulesets: async () => ["newtab_redirect"],
      updateEnabledRulesets: async () => {},
    },
    webNavigation: {
      onBeforeNavigate: event("before"), onCommitted: event("commit"),
      onErrorOccurred: event("error"),
    },
  };
  class ClockDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    importScripts: (...paths) => {
      for (const path of paths) {
        assert(workerScripts.includes(path), "Only declared local scripts can be imported");
        vm.runInContext(readFileSync(join(root, "js", path), "utf8"), context, { filename: path });
      }
    },
    chrome, URL, Response, Date: ClockDate,
    self: { addEventListener(name, fn) { event(name).addListener(fn); } },
    console: { log() {}, warn() {} },
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    calls, nodes, tabs, session, timers, emit,
    evaluate: (code) => vm.runInContext(code, context),
    async flush() { await flush(); await flush(); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        const [id, timer] = next;
        now = timer.due;
        timers.delete(id);
        timer.fn();
        await flush();
        await flush();
      }
      now = target;
      await flush();
    },
    async create(node) {
      nodes.set(node.id, plain(node));
      await emit("bookmarkCreated", node.id, plain(node));
    },
    async change(id, props) {
      Object.assign(nodes.get(id), props);
      await emit("bookmarkChanged", id, plain(props));
    },
    async activate(id) {
      const selected = tabs.get(id);
      for (const tab of tabs.values()) {
        if (tab.windowId === selected.windowId) tab.active = tab.id === id;
      }
      await emit("activated", { tabId: id, windowId: selected.windowId });
    },
    async updateTab(id, props) {
      Object.assign(tabs.get(id), props);
      await emit("updated", id, plain(props), plain(tabs.get(id)));
    },
    async removeTab(id) {
      tabs.delete(id);
      await emit("removed", id, { windowId: 7, isWindowClosing: false });
    },
    async removeBookmark(id, node = nodes.get(id)) {
      const removeNodes = (entry) => {
        nodes.delete(entry.id);
        for (const child of entry.children || []) removeNodes(child);
      };
      removeNodes(node);
      await emit("bookmarkRemoved", id, { parentId: "root", index: 0, node: plain(node) });
    },
    pause: () => emit("message", { type: "updateSettings", data: { enabled: false } }, {}, () => {}),
    pendingIds: () => (session[pendingKey] || []).map((entry) =>
      typeof entry === "string" ? entry : entry.id).sort(),
  };
}

test("new bookmarks wait five seconds and own URL updates do not keep queuing work", async () => {
  const h = harness();
  await h.flush();
  await h.create({ id: "b1", title: "Example", url: clean });
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.advance(4999);
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(1);
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: marked }]]);
  assert.deepEqual(h.pendingIds(), []);
  await h.advance(60000);
  assert.equal(h.calls.bookmarks.length, 1);
  assert.equal(h.timers.size, 0);
});

test("editing a pending title restarts the settling interval", async () => {
  const h = harness();
  await h.flush();
  await h.create({ id: "b1", title: "Example", url: clean });
  await h.advance(4000);
  await h.change("b1", { title: "Renamed in save dialog" });
  await h.advance(4999);
  assert.equal(h.calls.bookmarks.length, 0);
  await h.advance(1);
  assert.equal(h.nodes.get("b1").title, "Renamed in save dialog");
  assert.equal(h.nodes.get("b1").url, marked);
});

test("moving a pending bookmark restarts the settling interval", async () => {
  const h = harness();
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(4000);
  await h.emit("bookmarkMoved", "b1", { parentId: "chosen-folder", index: 0 });
  await h.advance(4999);
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(1);
  assert.equal(h.nodes.get("b1").url, marked);
});

test("an active saved page stays untouched indefinitely and switches release deferred work", async () => {
  const h = harness({ tabs: [
    { id: 1, url: clean, active: true, windowId: 7 },
    { id: 2, url: "https://other.example/", active: false, windowId: 7 },
  ] });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(120000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  assert.equal(h.timers.size, 0, "Blocked editors must not cause periodic polling");
  await h.activate(2);
  await h.advance(4999);
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(1);
  assert.equal(h.nodes.get("b1").url, marked);
  assert.deepEqual(h.pendingIds(), []);
});

test("active tabs in another window and their pending navigation URLs protect the editor", async () => {
  const h = harness({ tabs: [
    { id: 1, url: "https://other.example/", active: true, windowId: 7 },
    { id: 2, url: "https://previous.example/", pendingUrl: clean, active: true, windowId: 8 },
  ] });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.removeTab(2);
  await h.advance(5000);
  assert.equal(h.nodes.get("b1").url, marked);
});

for (const props of [{ url: "https://elsewhere.example/" }, { status: "complete" }]) {
  test(`tab update ${JSON.stringify(props)} retries previously blocked work after settling`, async () => {
    const h = harness({ tabs: [{ id: 1, url: clean, active: true, windowId: 7 }] });
    await h.flush();
    await h.create({ id: "b1", url: clean });
    await h.advance(5000);
    h.tabs.get(1).url = "https://elsewhere.example/";
    await h.updateTab(1, props);
    await h.advance(4999);
    assert.deepEqual(h.calls.bookmarks, []);
    await h.advance(1);
    assert.equal(h.nodes.get("b1").url, marked);
  });
}

test("bulk migration shares editor protection, including legacy Gmail markers", async () => {
  const gmail = "https://mail.google.com/mail/u/0/#inbox";
  const legacy = gmail.replace("https://", "https://newtab@");
  const h = harness({
    bookmarks: [{ id: "b1", url: clean }, { id: "gmail", url: legacy }],
    tabs: [{ id: 1, url: gmail, active: true, windowId: 7 }],
  });
  await h.flush();
  await h.evaluate("prefixAllBookmarks()");
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(5000);
  assert.equal(h.nodes.get("b1").url, marked);
  assert.equal(h.nodes.get("gmail").url, legacy);
  assert.deepEqual(h.pendingIds(), ["gmail"]);
  await h.updateTab(1, { url: "https://elsewhere.example/" });
  await h.advance(5000);
  assert.equal(h.nodes.get("gmail").url,
    "https://newtab@sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/redirect.html?url=" +
    encodeURIComponent(gmail));
});

test("an existing bookmark URL edit is queued and its latest destination is used", async () => {
  const h = harness({ bookmarks: [{ id: "b1", url: marked }] });
  await h.flush();
  await h.change("b1", { url: "https://edited.example/" });
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(4000);
  await h.change("b1", { url: "https://latest.example/" });
  await h.advance(4999);
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(1);
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: "https://newtab@latest.example/" }]]);
});

test("editing a pending destination retains protection for the page that opened its editor", async () => {
  const h = harness({ tabs: [{ id: 1, url: clean, active: true, windowId: 7 }] });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  await h.change("b1", { url: "https://edited.example/" });
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.updateTab(1, { url: "https://elsewhere.example/" });
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: "https://newtab@edited.example/" }]]);
});

for (const pending of [["b1", "b2"], [
  { id: "b1", urls: [clean] }, { id: "b2", urls: ["https://second.example/"] },
]]) {
  test(`worker recovery rearms persisted ${typeof pending[0] === "string" ? "legacy IDs" : "records"}`, async () => {
    const h = harness({
      bookmarks: [{ id: "b1", url: clean }, { id: "b2", url: "https://second.example/" }],
      session: { [pendingKey]: pending },
    });
    await h.flush();
    assert.deepEqual(h.calls.bookmarks, []);
    assert.deepEqual(h.pendingIds(), ["b1", "b2"]);
    await h.advance(4999);
    assert.deepEqual(h.calls.bookmarks, []);
    await h.advance(1);
    assert.deepEqual(h.calls.bookmarks.map(([id]) => id).sort(), ["b1", "b2"]);
    assert.deepEqual(h.pendingIds(), []);
  });
}

test("restart recovery preserves active editor protection", async () => {
  const h = harness({
    bookmarks: [{ id: "b1", url: clean }],
    session: { [pendingKey]: [{ id: "b1", urls: [clean] }] },
    tabs: [{ id: 1, url: clean, active: true, windowId: 7 }],
  });
  await h.flush();
  await h.advance(60000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  assert.equal(h.timers.size, 0);
});

test("a fresh browser session rediscovers a clean bookmark without cutting off its active editor", async () => {
  const h = harness({
    bookmarks: [{ id: "b1", url: clean }],
    session: {},
    tabs: [
      { id: 1, url: clean, active: true, windowId: 7 },
      { id: 2, url: "https://other.example/", active: false, windowId: 7 },
    ],
  });
  await h.flush();
  assert.equal(h.calls.trees, 1);
  assert.equal(h.session[readinessKey], true);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.advance(60000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.activate(2);
  await h.advance(5000);
  assert.equal(h.nodes.get("b1").url, marked);
  assert.deepEqual(h.pendingIds(), []);
});

test("fresh-session reconciliation combines saved pending work with clean background bookmarks", async () => {
  const h = harness({
    bookmarks: [
      { id: "active", url: clean },
      { id: "background", url: "https://background.example/" },
      { id: "recovered", url: "https://recovered.example/" },
    ],
    session: { [pendingKey]: [{ id: "recovered", urls: ["https://recovered.example/"] }] },
    tabs: [{ id: 1, url: clean, active: true, windowId: 7 }],
  });
  await h.flush();
  assert.equal(h.calls.trees, 1);
  assert.equal(h.session[readinessKey], true);
  assert.deepEqual(h.pendingIds(), ["active", "background", "recovered"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks.map(([id]) => id).sort(), ["background", "recovered"]);
  assert.deepEqual(h.pendingIds(), ["active"]);
});

test("an ordinary worker wake restores pending records without rescanning the bookmark tree", async () => {
  const h = harness({
    bookmarks: [{ id: "pending", url: clean }, { id: "unrelated", url: "https://unrelated.example/" }],
    session: { [readinessKey]: true, [pendingKey]: ["pending"] },
  });
  await h.flush();
  assert.equal(h.calls.trees, 0);
  assert.deepEqual(h.pendingIds(), ["pending"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["pending", { url: marked }]]);
  assert.equal(h.nodes.get("unrelated").url, "https://unrelated.example/");
});

test("a failed fresh-session tree read leaves reconciliation incomplete for the next wake", async () => {
  const h = harness({
    session: {},
    readTree: async () => { throw new Error("Bookmark tree unavailable"); },
  });
  await h.flush();
  assert.equal(h.calls.trees, 1);
  assert.notEqual(h.session[readinessKey], true);
  assert.deepEqual(h.calls.bookmarks, []);
});

test("a deferred fresh-session tree read cannot publish readiness before it finishes", async () => {
  const gate = deferred();
  const h = harness({
    bookmarks: [{ id: "b1", url: clean }],
    session: {},
    readTree: () => gate.promise,
  });
  await h.flush();
  assert.equal(h.calls.trees, 1);
  assert.notEqual(h.session[readinessKey], true);
  gate.resolve([{ id: "root", children: [{ id: "b1", url: clean }] }]);
  await h.flush();
  assert.equal(h.session[readinessKey], true);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(5000);
  assert.equal(h.nodes.get("b1").url, marked);
});

test("new bookmark events during session recovery are retained with recovered work", async () => {
  const gate = deferred();
  const h = harness({
    bookmarks: [{ id: "old", url: clean }],
    readSession: () => gate.promise,
  });
  await h.flush();
  const created = h.create({ id: "new", url: "https://new.example/" });
  await h.flush();
  gate.resolve({ [pendingKey]: ["old"] });
  await created;
  await h.flush();
  assert.deepEqual(h.pendingIds(), ["new", "old"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks.map(([id]) => id).sort(), ["new", "old"]);
});

test("pause cancels queued marking before restoring existing markers", async () => {
  const h = harness({ bookmarks: [{ id: "existing", url: marked }] });
  await h.flush();
  await h.create({ id: "new", url: "https://new.example/" });
  await h.pause();
  await h.flush();
  assert.equal(h.nodes.get("existing").url, clean);
  assert.deepEqual(h.pendingIds(), []);
  await h.advance(60000);
  assert.deepEqual(h.calls.bookmarks, [["existing", { url: clean }]]);
  await h.emit("activated", { tabId: 1, windowId: 7 });
  await h.advance(5000);
  assert.equal(h.nodes.get("new").url, "https://new.example/");
});

test("a URL edit during an asynchronous bookmark lookup invalidates the old write", async () => {
  const gate = deferred();
  let first = true;
  const h = harness({ readBookmark: (id, nodes) => {
    if (first) { first = false; return gate.promise; }
    return Promise.resolve([plain(nodes.get(id))]);
  } });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  await h.change("b1", { url: "https://latest.example/" });
  gate.resolve([{ id: "b1", url: clean }]);
  await h.flush();
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: "https://newtab@latest.example/" }]]);
});

test("an external marked URL edit invalidates an asynchronous lookup too", async () => {
  const gate = deferred();
  let first = true;
  const h = harness({ readBookmark: (id, nodes) => {
    if (first) { first = false; return gate.promise; }
    return Promise.resolve([plain(nodes.get(id))]);
  } });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  await h.change("b1", { url: "https://newtab@latest.example/" });
  gate.resolve([{ id: "b1", url: clean }]);
  await h.flush();
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.equal(h.nodes.get("b1").url, "https://newtab@latest.example/");
  assert.deepEqual(h.pendingIds(), []);
});

test("pause during active-tab lookup prevents a trailing rewrite", async () => {
  const gate = deferred();
  const h = harness({ queryTabs: () => gate.promise });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  const pausing = h.pause();
  await h.flush();
  gate.resolve([]);
  await pausing;
  await h.flush();
  await h.advance(60000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.equal(h.nodes.get("b1").url, clean);
  assert.deepEqual(h.pendingIds(), []);
});

test("a loading tab invalidates the active-page snapshot before a bookmark read finishes", async () => {
  const gate = deferred();
  let first = true;
  const h = harness({ readBookmark: (id, nodes) => {
    if (first) { first = false; return gate.promise; }
    return Promise.resolve([plain(nodes.get(id))]);
  } });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  h.tabs.get(1).pendingUrl = clean;
  await h.updateTab(1, { status: "loading" });
  gate.resolve([{ id: "b1", url: clean }]);
  await h.flush();
  assert.deepEqual(h.calls.bookmarks, []);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  assert.equal(h.timers.size, 0);
});

test("pause waits for an already submitted bookmark write before restoring it", async () => {
  const gate = deferred();
  const h = harness({ writeBookmark: (id, props) => {
    if (props.url === marked) return gate.promise;
  } });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: marked }]]);
  await h.pause();
  await h.flush();
  gate.resolve();
  await h.flush();
  assert.deepEqual(h.calls.bookmarks, [["b1", { url: marked }], ["b1", { url: clean }]]);
  assert.equal(h.nodes.get("b1").url, clean);
  assert.deepEqual(h.pendingIds(), []);
});

test("active-tab query failures preserve work for a later tab event", async () => {
  let fail = true;
  const h = harness({ queryTabs: async () => {
    if (fail) throw new Error("Tabs unavailable");
    return [];
  } });
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, []);
  assert.deepEqual(h.pendingIds(), ["b1"]);
  assert.equal(h.timers.size, 0);
  fail = false;
  await h.emit("activated", { tabId: 1, windowId: 7 });
  await h.advance(5000);
  assert.equal(h.nodes.get("b1").url, marked);
});

test("a large bookmark burst shares timers, tab queries and session writes", async () => {
  const count = 2000;
  const h = harness({ tabs: [{ id: 1, url: clean, active: true, windowId: 7 }] });
  await h.flush();
  h.calls.session.length = 0;
  await Promise.all(Array.from({ length: count }, (_, index) =>
    h.create({ id: "b" + index, url: clean })
  ));
  await h.flush();
  assert.equal(h.pendingIds().length, count);
  assert.equal(h.timers.size, 1, "A creation burst should share one settling timer");
  assert(h.calls.session.length <= 3, "Session writes should coalesce a synchronous burst");
  await h.advance(120000);
  assert.equal(h.calls.queries.length, 1, "One active-tab query should cover the entire due batch");
  assert.deepEqual(h.calls.bookmarks, []);
  assert.equal(h.pendingIds().length, count);
  assert.equal(h.timers.size, 0, "Blocked bookmarks should wait for tab events without polling");
  await h.updateTab(1, { url: "https://elsewhere.example/" });
  assert.equal(h.timers.size, 1, "A retry burst should share one settling timer");
  await h.advance(5000);
  assert.equal(h.calls.queries.length, 2);
  assert.equal(h.calls.bookmarks.length, count);
  assert.deepEqual(h.pendingIds(), []);
  assert.equal(h.timers.size, 0);
});

test("removing a folder clears all queued descendants without bookmark writes", async () => {
  const h = harness();
  await h.flush();
  await h.create({ id: "b1", url: clean });
  await h.create({ id: "b2", url: "https://second.example/" });
  await h.removeBookmark("folder", { id: "folder", children: [
    { id: "b1", url: clean }, { id: "nested", children: [{ id: "b2", url: "https://second.example/" }] },
  ] });
  assert.deepEqual(h.pendingIds(), []);
  await h.advance(60000);
  assert.deepEqual(h.calls.bookmarks, []);
});

test("a removal that wakes the worker preserves unrelated recovered work", async () => {
  const h = harness({
    bookmarks: [{ id: "removed", url: clean }, { id: "retained", url: "https://retained.example/" }],
    session: { [pendingKey]: ["removed", "retained"] },
  });
  await h.removeBookmark("removed");
  await h.flush();
  assert.deepEqual(h.pendingIds(), ["retained"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["retained", { url: "https://newtab@retained.example/" }]]);
});

test("a removal during recovery is applied after the saved queue is loaded", async () => {
  const gate = deferred();
  const h = harness({
    bookmarks: [{ id: "removed", url: clean }, { id: "retained", url: "https://retained.example/" }],
    readSession: () => gate.promise,
  });
  await h.flush();
  const removed = h.removeBookmark("removed");
  await h.flush();
  gate.resolve({ [pendingKey]: ["removed", "retained"] });
  await removed;
  await h.flush();
  assert.deepEqual(h.pendingIds(), ["retained"]);
  await h.advance(5000);
  assert.deepEqual(h.calls.bookmarks, [["retained", { url: "https://newtab@retained.example/" }]]);
});

test("paused workers ignore new bookmarks and unsupported URLs never get rewritten", async () => {
  const paused = harness({ settings: { enabled: false } });
  await paused.flush();
  await paused.create({ id: "b1", url: clean });
  await paused.advance(5000);
  assert.deepEqual(paused.calls.bookmarks, []);
  assert.deepEqual(paused.pendingIds(), []);
  const enabled = harness();
  await enabled.flush();
  await enabled.create({ id: "folder", title: "Folder" });
  await enabled.create({ id: "internal", url: "chrome://settings/" });
  await enabled.advance(5000);
  assert.deepEqual(enabled.calls.bookmarks, []);
  assert.deepEqual(enabled.pendingIds(), []);
});
