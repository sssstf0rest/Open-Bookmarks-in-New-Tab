import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, RUNTIME_FILES, validateSource } from "./project.mjs";

const manifest = validateSource();
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
assert.equal(packageJson.version, manifest.version, "Package/manifest versions must match");
const scripts = [
  ...RUNTIME_FILES.filter((path) => path.endsWith(".js")),
  ...readdirSync(join(ROOT, "scripts")).filter((name) => name.endsWith(".mjs")).map((name) => `scripts/${name}`),
  ...readdirSync(join(ROOT, "tests")).filter((name) => name.endsWith(".cjs")).map((name) => `tests/${name}`),
];
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", join(ROOT, script)], { stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Syntax check failed: ${script}`);
}
console.log(`Validated ${RUNTIME_FILES.length} runtime assets and ${scripts.length} JavaScript files.`);
