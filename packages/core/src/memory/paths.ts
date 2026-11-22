import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** User-scope memory: `.md`, `journal.jsonl`, `.lock` — not mixed with `projects/`. */
export function userMemoryDir(home: string): string {
  return join(home, "memory", "user");
}

/**
 * Project-scope memory for one key. Flat on purpose: `.md`, `journal.jsonl`, `.lock`, and
 * `project.json` sit in this folder — there is no nested `memory/` under it.
 */
export function projectMemoryDir(home: string, key: string): string {
  return join(home, "memory", "projects", key);
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function copyIfAbsent(from: string, to: string): boolean {
  if (existsSync(to)) return false;
  cpSync(from, to, { recursive: true });
  return true;
}

/** Node `rmSync` can no-op on some Windows setups; rename first, then delete. */
function removeDirTree(path: string): void {
  if (!existsSync(path)) return;
  const trash = `${path}.deleted-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, trash);
  } catch {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      return;
    }
    if (!existsSync(path) || process.platform !== "win32") return;
    try {
      execFileSync("cmd", ["/c", "rd", "/s", "/q", path], { stdio: "ignore" });
    } catch {
      /* leave for next launch */
    }
    return;
  }

  try {
    rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* fall through */
  }
  if (!existsSync(trash)) return;
  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "rd", "/s", "/q", trash], { stdio: "ignore" });
    } catch {
      /* leave trash; the public path is already gone */
    }
  }
}

/**
 * Old project layout: `{home}/projects/<key>/memory/*` (+ sibling `project.json`).
 * New layout: `{home}/memory/projects/<key>/*` (flat).
 *
 * Old user layout: `{home}/memory/*` next to a `projects/` folder.
 * New layout: `{home}/memory/user/*`.
 *
 * Safe to call more than once.
 */
export function migrateMemoryLayout(home: string): void {
  migrateProjectMemoryLayout(home);
  migrateUserMemoryLayout(home);
}

/** @deprecated Prefer {@link migrateMemoryLayout}. */
export function migrateProjectMemoryLayout(home: string): void {
  const legacyRoot = join(home, "projects");
  if (!isDir(legacyRoot)) return;

  for (const name of readdirSync(legacyRoot)) {
    if (name.startsWith(".")) continue;
    const legacyKeyDir = join(legacyRoot, name);
    if (!isDir(legacyKeyDir)) continue;

    const dest = projectMemoryDir(home, name);
    mkdirSync(dest, { recursive: true });

    const nested = join(legacyKeyDir, "memory");
    if (isDir(nested)) {
      try {
        for (const file of readdirSync(nested)) {
          copyIfAbsent(join(nested, file), join(dest, file));
        }
      } catch {
        // Skip a locked nested folder; retry next launch.
      }
    }

    for (const file of readdirSync(legacyKeyDir)) {
      if (file === "memory") continue;
      try {
        copyIfAbsent(join(legacyKeyDir, file), join(dest, file));
      } catch {
        // Skip locked files.
      }
    }
  }

  removeDirTree(legacyRoot);
}

function migrateUserMemoryLayout(home: string): void {
  const root = join(home, "memory");
  if (!isDir(root)) return;

  const loose = readdirSync(root).filter((name) => name !== "projects" && name !== "user");
  if (!loose.length) return;

  const dest = userMemoryDir(home);
  mkdirSync(dest, { recursive: true });
  for (const name of loose) {
    const from = join(root, name);
    const to = join(dest, name);
    if (existsSync(to)) {
      removeDirTree(from);
      if (existsSync(from) && !isDir(from)) {
        try {
          rmSync(from, { force: true });
        } catch {
          /* retry next launch */
        }
      }
      continue;
    }
    try {
      renameSync(from, to);
    } catch {
      try {
        cpSync(from, to, { recursive: true });
        if (isDir(from)) removeDirTree(from);
        else rmSync(from, { force: true });
      } catch {
        // Retry next launch if a file is locked.
      }
    }
  }
}
