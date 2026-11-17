import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { nowIso } from "../ids.js";
import { normalizeWorkspacePath } from "../runtime/sessionRuntimePool.js";
import { errorCode } from "../store/fileLock.js";

export interface ProjectInfo {
  /** Directory name under `~/.long-task-agent/projects/`. */
  key: string;
  /** Repository root, or the workspace itself outside git. */
  root: string;
  isGit: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The common git directory behind one `.git` entry: the directory itself, or
 * where a worktree or submodule `.git` file points, followed through
 * `commondir`. "invalid" is a `.git` that exists but cannot be followed.
 */
async function gitCommonDir(dotGit: string): Promise<string | null | "invalid"> {
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) return "invalid";
  let text: string;
  try {
    text = await readFile(dotGit, "utf8");
  } catch {
    return "invalid";
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return "invalid";
  const gitDir = resolve(dirname(dotGit), match[1]!);
  if (!(await isDirectory(gitDir))) return "invalid";
  let common = gitDir;
  try {
    const pointer = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (pointer) common = resolve(gitDir, pointer);
  } catch {
    // Without commondir the git directory is its own common directory.
  }
  return (await isDirectory(common)) ? common : "invalid";
}

/**
 * Walks up from the workspace to the first `.git`. A common directory named
 * `.git` belongs to its parent; any other (a submodule under
 * `.git/modules/`) belongs to the directory that holds the `.git` file.
 * `ceiling` ends the walk early; tests use it to stay inside a temp folder.
 */
export async function findProjectRoot(
  workspacePath: string,
  ceiling?: string,
): Promise<{ root: string; isGit: boolean }> {
  const start = resolve(workspacePath);
  const stop = ceiling ? resolve(ceiling) : null;
  let dir = start;
  for (;;) {
    const common = await gitCommonDir(join(dir, ".git"));
    if (common === "invalid") return { root: start, isGit: false };
    if (common) return { root: basename(common).toLowerCase() === ".git" ? dirname(common) : dir, isGit: true };
    const parent = dirname(dir);
    if (parent === dir || dir === stop) return { root: start, isGit: false };
    dir = parent;
  }
}

export function projectKeyFor(root: string): string {
  const normalized = normalizeWorkspacePath(root);
  const last = normalized.split("/").filter(Boolean).pop() ?? "";
  const name = last.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${name}-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export async function resolveProject(workspacePath: string): Promise<ProjectInfo> {
  const found = await findProjectRoot(workspacePath);
  return { key: projectKeyFor(found.root), ...found };
}

/** Records which root a key belongs to, since the hash cannot be read back. Never overwritten. */
export async function writeProjectFile(projectDir: string, info: ProjectInfo): Promise<void> {
  const body = `${JSON.stringify({ root: info.root, is_git: info.isGit, created_at: nowIso() }, null, 2)}\n`;
  try {
    await writeFile(join(projectDir, "project.json"), body, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
}