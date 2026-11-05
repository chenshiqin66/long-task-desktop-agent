import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("electron");
console.log("electron module resolvable");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = spawnSync(process.execPath, [join(root, "scripts/test-run-event-gate.mjs")], {
  encoding: "utf8",
});
if (gate.status !== 0) {
  process.stderr.write(gate.stdout + gate.stderr);
  process.exit(gate.status ?? 1);
}
process.stdout.write(gate.stdout);
console.log("app smoke ok");
