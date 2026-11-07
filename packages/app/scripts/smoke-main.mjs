import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("electron");
console.log("electron module resolvable");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const script of ["test-run-event-gate.mjs", "test-taskbar-attention.mjs"]) {
  const gate = spawnSync(process.execPath, [join(root, "scripts", script)], {
    encoding: "utf8",
  });
  if (gate.status !== 0) {
    process.stderr.write(gate.stdout + gate.stderr);
    process.exit(gate.status ?? 1);
  }
  process.stdout.write(gate.stdout);
}
console.log("app smoke ok");
