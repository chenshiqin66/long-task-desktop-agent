import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** Claim file under `~/.long-task-agent/`. The first checkout to start after isolation ships adopts the old flat home. */
const LEGACY_CLAIM = ".legacy-claim";

/** Checkout home dirs are `sha256(repoPath).slice(0, 16)`. */
const HOME_KEY_RE = /^[0-9a-f]{16}$/i;

/** Top-level names that belong to the shell, not to a checkout home. */
const SHELL_META = new Set([LEGACY_CLAIM, "roots"]);

/** The pre-isolation location still used when no desktop-agent package root can be found. */
export function legacyAgentHome(): string {
  return join(homedir(), ".long-task-agent");
}

export function isCheckoutHomeKey(name: string): boolean {
  return HOME_KEY_RE.test(name);
}

/**
 * Walks up from a file under this monorepo until `package.json` names `long-task-desktop-agent`.
 * Each git clone / worktree has its own absolute path, so each gets its own agent home.
 */
export function detectDesktopAgentRoot(
  from = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let dir = from;
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "long-task-desktop-agent") return dir;
      } catch {
        // Keep walking: a broken package.json is not the repo root.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function rootKey(repoRoot: string): string {
  return createHash("sha256").update(normalize(repoRoot).toLowerCase()).digest("hex").slice(0, 16);
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function removePath(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* fall through */
  }
  if (!existsSync(path)) return;
  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "rd", "/s", "/q", path], { stdio: "ignore" });
    } catch {
      try {
        execFileSync("cmd", ["/c", "del", "/f", "/q", path], { stdio: "ignore" });
      } catch {
        /* leave */
      }
    }
  }
}

/**
 * Old layout: `~/.long-task-agent/roots/<hash>/`.
 * New layout: `~/.long-task-agent/<hash>/` (no `roots/` wrapper).
 * Also lifts `.legacy-claim` to the shell root. Safe to call more than once.
 */
export function migrateRootsShell(legacy = legacyAgentHome()): void {
  const roots = join(legacy, "roots");
  if (!isDir(roots)) {
    // Already flat, or never used roots — still drop stray marker files under a leftover roots stub.
    return;
  }

  for (const name of readdirSync(roots)) {
    const from = join(roots, name);
    if (name === LEGACY_CLAIM || name.startsWith(".")) {
      const dest = join(legacy, name === LEGACY_CLAIM ? LEGACY_CLAIM : name);
      if (name === LEGACY_CLAIM && !existsSync(dest)) {
        try {
          renameSync(from, dest);
        } catch {
          try {
            cpSync(from, dest);
            removePath(from);
          } catch {
            /* retry next launch */
          }
        }
      } else {
        removePath(from);
      }
      continue;
    }
    if (!isCheckoutHomeKey(name) && !isDir(from)) {
      removePath(from);
      continue;
    }
    const dest = join(legacy, name);
    if (existsSync(dest)) {
      // Prefer the already-lifted copy; drop the nested duplicate.
      removePath(from);
      continue;
    }
    try {
      renameSync(from, dest);
    } catch {
      try {
        cpSync(from, dest, { recursive: true });
        removePath(from);
      } catch {
        /* retry next launch */
      }
    }
  }

  try {
    if (isDir(roots) && readdirSync(roots).length === 0) removePath(roots);
    else if (isDir(roots)) removePath(roots);
  } catch {
    /* leave stub */
  }
}

/**
 * After homes live under `<hash>/`, the old flat files at the shell root are stale twins.
 * Keeps only checkout homes, `.legacy-claim`, and any remaining `roots/` stub cleanup.
 */
export function cleanAgentHomeShell(legacy = legacyAgentHome()): void {
  if (!isDir(legacy)) return;
  for (const name of readdirSync(legacy)) {
    if (SHELL_META.has(name) || name.startsWith(".")) {
      if (name === "roots") removePath(join(legacy, name));
      continue;
    }
    if (isCheckoutHomeKey(name)) continue;
    removePath(join(legacy, name));
  }
}

/**
 * If this checkout's home is still empty and the old flat `~/.long-task-agent/config.json` exists,
 * the first process to create `.legacy-claim` copies that tree into this home. Later checkouts
 * see the claim and start empty — so a clone no longer shares writes with the original.
 */
function adoptLegacyHomeIfNeeded(home: string, legacy: string, key: string, repoRoot: string): void {
  if (existsSync(join(home, "config.json"))) return;
  if (!existsSync(join(legacy, "config.json"))) return;
  const claimPath = join(legacy, LEGACY_CLAIM);

  let mayCopy = false;
  if (existsSync(claimPath)) {
    try {
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { key?: string };
      // Broken half-claim for this key: finish the copy. Other keys stay empty.
      mayCopy = claim.key === key;
    } catch {
      return;
    }
  } else {
    try {
      writeFileSync(
        claimPath,
        `${JSON.stringify({ key, repoRoot, at: new Date().toISOString() })}\n`,
        { flag: "wx" },
      );
    } catch {
      return;
    }
  }
  if (!mayCopy) return;

  // Entry-by-entry: a locked browser-explain folder must not abort config / mcp / skills.
  for (const name of readdirSync(legacy)) {
    if (name === "roots" || name === LEGACY_CLAIM || isCheckoutHomeKey(name) || name.startsWith(".")) {
      continue;
    }
    try {
      cpSync(join(legacy, name), join(home, name), { recursive: true });
    } catch {
      // Skip locked paths.
    }
  }
  preferConfigBackup(legacy, home);
  if (!existsSync(join(home, "config.json"))) {
    try {
      rmSync(claimPath, { force: true });
    } catch {
      /* next start retries */
    }
  }
}

function configHasKey(text: string): boolean {
  try {
    const cfg = JSON.parse(text) as { apiKey?: unknown; models?: Array<{ apiKey?: unknown }> };
    if (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) return true;
    return Boolean(cfg.models?.some((row) => typeof row?.apiKey === "string" && row.apiKey.trim()));
  } catch {
    return false;
  }
}

function preferConfigBackup(legacy: string, home: string): void {
  const bakPath = join(legacy, "config.json.bak");
  const livePath = join(legacy, "config.json");
  if (!existsSync(bakPath) || !existsSync(livePath)) return;
  try {
    const bakText = readFileSync(bakPath, "utf8");
    const liveText = readFileSync(livePath, "utf8");
    if (configHasKey(bakText) && !configHasKey(liveText)) {
      copyFileSync(bakPath, join(home, "config.json"));
    }
  } catch {
    // Keep the copied live file.
  }
}

/**
 * Directory for config.json, skills/, mcp-servers.json, memory/, browser-tabs.json, …
 *
 * Resolution order:
 * 1. `LONG_TASK_AGENT_HOME` (explicit override)
 * 2. `~/.long-task-agent/<hash-of-repo-path>/` when this code lives inside a desktop-agent checkout
 * 3. `~/.long-task-agent` as a last resort
 */
export function getAgentHome(): string {
  const fromEnv = process.env.LONG_TASK_AGENT_HOME?.trim();
  if (fromEnv) return fromEnv.replace(/[\\/]+$/, "");

  const legacy = legacyAgentHome();
  migrateRootsShell(legacy);

  const repoRoot = detectDesktopAgentRoot();
  if (!repoRoot) return legacy;

  const key = rootKey(repoRoot);
  const home = join(legacy, key);
  mkdirSync(home, { recursive: true });
  adoptLegacyHomeIfNeeded(home, legacy, key, repoRoot);
  cleanAgentHomeShell(legacy);
  return home;
}

/** Same as `getAgentHome`; kept for callers that already imported this name from the memory store. */
export function defaultAgentHome(): string {
  return getAgentHome();
}
