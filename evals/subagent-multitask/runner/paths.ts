import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Walk up from this module until the workspace root that owns packages/core. */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "packages", "core", "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot find the repo root above ${start}. Run this from the long-task-desktop-agent checkout.`);
    }
    dir = parent;
  }
}

export function caseFileDefault(): string {
  return join(findRepoRoot(), "evals", "subagent-multitask", "cases.json");
}

/** Import a file from the built @agent/core package without hard-coding a relative depth. */
export function coreDistUrl(relativePath: string): string {
  return pathToFileURL(join(findRepoRoot(), "packages", "core", "dist", relativePath)).href;
}
