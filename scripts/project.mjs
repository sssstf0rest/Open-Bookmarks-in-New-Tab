import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit package boundary: documentation, tests, tooling and historical
// artifacts must never leak into the extension loaded by Chrome.
export const RUNTIME_FILES = [
  "manifest.json",
  "rules.json",
  "cancel.html",
  "popup.html",
  "css/popup.css",
  "js/background.js",
  "js/popup.js",
  "js/worker/config.js",
  "js/worker/settings.js",
  "js/worker/urls.js",
  "js/worker/bookmarks.js",
  "js/worker/navigation.js",
  "js/worker/lifecycle.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

export function validateSource(root = ROOT) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  const rules = JSON.parse(read("rules.json"));
  const entry = read(manifest.background.service_worker);
  const included = new Set(RUNTIME_FILES);
  for (const path of RUNTIME_FILES) {
    assert(statSync(resolve(root, path)).isFile(), `Missing runtime file: ${path}`);
  }
  const requirePackaged = (path) => assert(included.has(path), `Unpackaged resource: ${path}`);
  requirePackaged(manifest.background.service_worker);
  requirePackaged(manifest.action.default_popup);
  for (const path of Object.values(manifest.icons)) requirePackaged(path);
  for (const path of Object.values(manifest.action.default_icon)) requirePackaged(path);
  for (const resource of manifest.declarative_net_request.rule_resources) requirePackaged(resource.path);
  for (const resource of manifest.web_accessible_resources) {
    for (const path of resource.resources) requirePackaged(path);
  }
  const imported = [...entry.matchAll(/"(worker\/[^"\n]+\.js)"/g)].map((match) => `js/${match[1]}`);
  assert.equal(imported.length, 6, "Expected six synchronously loaded worker scripts");
  for (const path of imported) requirePackaged(path);
  for (const match of read("popup.html").matchAll(/(?:src|href)="([^"]+)"/g)) {
    requirePackaged(match[1]);
  }
  assert.equal(manifest.manifest_version, 3);
  assert(!manifest.background.type, "Preserve the classic worker's synchronous imports");
  assert.equal(rules[0].action.redirect.extensionPath, "/cancel.html");
  assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["cancel.html"]);
  assert(!manifest.permissions.some((p) => p.startsWith("downloads") || p === "alarms"));
  assert.doesNotMatch([entry, ...imported.map(read)].join("\n"), /chrome\.(downloads|alarms)\b|empty\.zip/);
  return manifest;
}
