import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, RUNTIME_FILES, validateSource } from "./project.mjs";

export function copyRuntime(destination) {
  validateSource();
  for (const path of RUNTIME_FILES) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, path), target);
  }
  validateSource(destination);
}

// Only the fixed generated folder is rebuilt; never accept a user-supplied
// deletion target. Refuse symlinks to avoid deleting/copying outside dist.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateSource();
  const dist = join(ROOT, "dist");
  const output = join(dist, "extension");
  for (const path of [dist, output]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) {
      throw new Error(`Build path must be a real directory: ${path}`);
    }
  }
  if (existsSync(output)) rmSync(output, { recursive: true });
  copyRuntime(output);
  console.log(`Built ${RUNTIME_FILES.length} runtime files in ${output}`);
}
