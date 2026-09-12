const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

function listFiles(path, prefix = "") {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? listFiles(join(path, entry.name), name + "/") : [name];
  }).sort();
}

test("runtime package is complete, byte-identical, and excludes development/history files", async (t) => {
  const { ROOT, RUNTIME_FILES, validateSource } = await import("../scripts/project.mjs");
  const { copyRuntime } = await import("../scripts/build.mjs");
  const output = mkdtempSync(join(tmpdir(), "bookmarks-package-test-"));
  t.after(() => rmSync(output, { recursive: true }));
  copyRuntime(output);
  assert.deepEqual(listFiles(output), [...RUNTIME_FILES].sort());
  for (const path of RUNTIME_FILES) {
    assert.deepEqual(readFileSync(join(output, path)), readFileSync(join(ROOT, path)), path);
  }
  assert.equal(validateSource(output).version, validateSource(ROOT).version);
  assert(!listFiles(output).some((path) => /\.zip$|^docs\/|^tests\/|^scripts\/|^_metadata\//.test(path)));
});
