import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { replaceFile } from "../store/fileLock.js";
import { getAgentHome, isCheckoutHomeKey, legacyAgentHome } from "./agentHome.js";

export const HOME_META_FILE = "home.json";
const LEGACY_CLAIM = ".legacy-claim";

/** Max length for the human-readable home label shown in the title and settings. */
export const HOME_LABEL_MAX = 40;

export interface HomeMeta {
  /** Display name for this agent home. Empty means untitled. */
  label: string;
}

export interface LabeledHome {
  key: string;
  path: string;
  label: string;
}

export interface HomeInfo {
  path: string;
  key: string;
  label: string;
  /** Whether `home.json` exists (even with an empty label = intentionally unnamed). */
  decided: boolean;
  repoRoot: string | null;
  /** Other checkout homes that already have a label. */
  siblings: LabeledHome[];
  /**
   * Prompt only when this home has never written `home.json` and a sibling already
   * has a name. An empty label after decide means the official / default home.
   */
  needsLabel: boolean;
}

export interface HomeInfoOpts {
  /** Override `~/.long-task-agent` when listing sibling homes (tests). */
  legacyHome?: string;
}

function metaPath(home: string): string {
  return join(home, HOME_META_FILE);
}

export function normalizeHomeLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n\0]/g, "").trim().slice(0, HOME_LABEL_MAX);
}

export function homeMetaExists(home: string): boolean {
  return existsSync(metaPath(home));
}

export function readHomeMeta(home: string): HomeMeta {
  const path = metaPath(home);
  if (!existsSync(path)) return { label: "" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { label?: unknown };
    return { label: normalizeHomeLabel(raw.label) };
  } catch {
    return { label: "" };
  }
}

export async function writeHomeMeta(home: string, meta: HomeMeta): Promise<HomeMeta> {
  mkdirSync(home, { recursive: true });
  const next: HomeMeta = { label: normalizeHomeLabel(meta.label) };
  await replaceFile(metaPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function claimPath(legacyHome: string): string {
  const flat = join(legacyHome, LEGACY_CLAIM);
  if (existsSync(flat)) return flat;
  return join(legacyHome, "roots", LEGACY_CLAIM);
}

function readClaimRepoRoot(legacyHome: string, key: string): string | null {
  const path = claimPath(legacyHome);
  if (!existsSync(path)) return null;
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as { key?: unknown; repoRoot?: unknown };
    if (claim.key === key && typeof claim.repoRoot === "string" && claim.repoRoot.trim()) {
      return claim.repoRoot;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Sibling checkout homes under `~/.long-task-agent/<hash>/` that already have a non-empty label. */
export function listLabeledSiblingHomes(currentHome: string, legacyHome = legacyAgentHome()): LabeledHome[] {
  if (!isDir(legacyHome)) return [];
  const out: LabeledHome[] = [];
  for (const name of readdirSync(legacyHome)) {
    if (!isCheckoutHomeKey(name)) continue;
    const path = join(legacyHome, name);
    if (!isDir(path)) continue;
    if (path === currentHome) continue;
    const label = readHomeMeta(path).label;
    if (!label) continue;
    out.push({ key: name, path, label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "zh"));
}

export function getHomeInfo(home = getAgentHome(), opts: HomeInfoOpts = {}): HomeInfo {
  const legacyHome = opts.legacyHome ?? legacyAgentHome();
  const meta = readHomeMeta(home);
  const decided = homeMetaExists(home);
  const key = basename(home);
  const siblings = listLabeledSiblingHomes(home, legacyHome);
  return {
    path: home,
    key,
    label: meta.label,
    decided,
    repoRoot: readClaimRepoRoot(legacyHome, key),
    siblings,
    needsLabel: !decided && siblings.length > 0,
  };
}

/** Window / about title. Falls back to the product name when unlabeled. */
export function homeWindowTitle(label: string, product = "Long-Task Agent"): string {
  const name = normalizeHomeLabel(label);
  return name ? `${product} · ${name}` : product;
}
