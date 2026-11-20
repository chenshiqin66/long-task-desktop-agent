import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("electron");
console.log("electron module resolvable");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = [
  ["test-run-event-gate.mjs"],
  ["test-stream-paint.mjs"],
  ["test-escape-key.mjs"],
  ["test-image-viewer.mjs"],
  ["test-send-button.mjs"],
  ["test-thinking-hint.mjs"],
  ["test-error-summary.mjs"],
  ["test-add-button.mjs"],
  ["test-sticky-turns.mjs"],
  ["test-memory-view.mjs"],
  ["test-model-kind-label.mjs"],
  ["test-composer-model-fit.mjs"],
  ["test-explain-icons.mjs"],
  ["test-composer-resize.mjs"],
  ["test-browser-policy.mjs"],
  ["test-taskbar-attention.mjs"],
  ["test-taskbar-icon-win.mjs", "--experimental-test-module-mocks"],
];
for (const [script, ...flags] of scripts) {
  const gate = spawnSync(process.execPath, [...flags, join(root, "scripts", script)], {
    encoding: "utf8",
  });
  if (gate.status !== 0) {
    process.stderr.write(gate.stdout + gate.stderr);
    process.exit(gate.status ?? 1);
  }
  process.stdout.write(gate.stdout);
}
console.log("app smoke ok");
