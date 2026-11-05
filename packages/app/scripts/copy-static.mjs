import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "dist/src/renderer");
await mkdir(destDir, { recursive: true });
await copyFile(join(root, "src/renderer/index.html"), join(destDir, "index.html"));
await copyFile(join(root, "src/renderer/styles.css"), join(destDir, "styles.css"));

// Sandboxed preload must be CJS with a .cjs extension (package.json has "type":"module").
const electronDir = join(root, "dist/electron");
await mkdir(electronDir, { recursive: true });
await copyFile(join(root, "dist/preload-cjs/preload.js"), join(electronDir, "preload.cjs"));
