import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** Claim file under `~/.long-task-agent/roots/`. The first checkout to start after this feature ships adopts the old flat home. */
const LEGACY_CLAIM = ".legacy-claim";

/** The pre-roots location still used when no desktop-agent package root can be found. */
export function legacyAgentHome(): string {
  return join(homedir(), ".long-task-agent");
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

/**
 * If this checkout's home is still empty and the old flat `~/.long-task-agent/config.json` exists,
 * the first process to create `.legacy-claim` copies that tree into this home. Later checkouts
 * see the claim and start empty — so a clone no longer shares writes with the original.
 */
function adoptLegacyHomeIfNeeded(home: string, legacy: string, key: string, repoRoot: string): void {
  if (existsSync(join(home, "config.json"))) return;
  if (!existsSync(join(legacy, "config.json"))) return;
  const rootsDir = join(legacy, "roots");
  mkdirSync(rootsDir, { recursive: true });
  const claimPath = join(rootsDir, LEGACY_CLAIM);

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
      mayCopy = true;
    } catch {
      return;
    }
  }
  if (!mayCopy) return;

  // Entry-by-entry: a locked browser-explain folder must not abort config / mcp / skills.
  for (const name of readdirSync(legacy)) {
    if (name === "roots") continue;
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
 * 2. `~/.long-task-agent/roots/<hash-of-repo-path>/` when this code lives inside a desktop-agent checkout
 * 3. `~/.long-task-agent` as a last resort
 */
export function getAgentHome(): string {
  const fromEnv = process.env.LONG_TASK_AGENT_HOME?.trim();
  if (fromEnv) return fromEnv.replace(/[\\/]+$/, "");

  const legacy = legacyAgentHome();
  const repoRoot = detectDesktopAgentRoot();
  if (!repoRoot) return legacy;

  const key = rootKey(repoRoot);
  const home = join(legacy, "roots", key);
  mkdirSync(home, { recursive: true });
  adoptLegacyHomeIfNeeded(home, legacy, key, repoRoot);
  return home;
}

/** Same as `getAgentHome`; kept for callers that already imported this name from the memory store. */
export function defaultAgentHome(): string {
  return getAgentHome();
}
