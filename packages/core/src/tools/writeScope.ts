import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveWithinWorkspace } from "../pathSandbox.js";

/** Workspace-relative directory a worker may write. Rejects the workspace root and `.agent`. */
export function normalizeOutputDir(
  raw: string,
): { ok: true; dir: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return { ok: false, error: "worker requires output_dir" };
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, error: "output_dir must be a workspace-relative directory" };
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return { ok: false, error: "output_dir cannot be the workspace root" };
  if (parts.some((part) => part === "..")) {
    return { ok: false, error: "output_dir cannot contain .." };
  }
  if (parts[0]!.toLowerCase() === ".agent") return { ok: false, error: "output_dir cannot be inside .agent" };
  return { ok: true, dir: parts.join("/") };
}

/** True when one directory is the other, or either contains the other. Case-blind, as on NTFS and APFS. */
export function outputDirsOverlap(a: string, b: string): boolean {
  const left = `${a.toLowerCase()}/`;
  const right = `${b.toLowerCase()}/`;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * The path the filesystem will actually touch: the existing part goes through
 * realpath, which resolves links, junctions, letter case and 8.3 short names.
 */
async function canonicalPath(abs: string): Promise<string> {
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      return join(await realpath(probe), ...tail);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return abs;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/** Forward-slash path under root, or null when target is outside it. */
function relativeUnder(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/** `dir` and `rel` are workspace-relative; `dir` empty means the workspace itself. */
function isUnder(dir: string, rel: string, foldCase: boolean): boolean {
  const d = foldCase ? dir.toLowerCase() : dir;
  const r = foldCase ? rel.toLowerCase() : rel;
  return r === d || r.startsWith(`${d}/`);
}

/**
 * Reject a write into `.agent`, a path outside a subagent's output_dir, or a
 * directory claimed by a subagent started in the same parent tool batch.
 * Checks that forbid a path ignore letter case; the output_dir allowance does not,
 * so a case-sensitive filesystem cannot widen it.
 * Returns null when the path is outside the workspace; the file tool reports that itself.
 */
export async function writeScopeError(opts: {
  workspacePath: string;
  requested: string;
  writeRoot?: string;
  blockedOutputDirs?: readonly string[];
}): Promise<string | null> {
  if (!opts.requested.trim()) return null;
  let abs: string;
  try {
    abs = resolveWithinWorkspace(opts.workspacePath, opts.requested);
  } catch {
    return null;
  }
  const root = await canonicalPath(resolve(opts.workspacePath));
  const rel = relativeUnder(root, await canonicalPath(abs));
  if (rel === null) return null;
  // Session state, including the task list. File tools must not bypass claim_task / complete_task.
  if (isUnder(".agent", rel, true)) {
    return "Path is inside .agent session state. Use the task tools to change tasks.";
  }
  const underDir = async (dir: string, foldCase: boolean) => {
    const canonicalDir = relativeUnder(root, await canonicalPath(resolve(root, dir)));
    return canonicalDir !== null && isUnder(canonicalDir, rel, foldCase);
  };
  if (opts.writeRoot && !(await underDir(opts.writeRoot, false))) {
    return `Path is outside the subagent output_dir ${opts.writeRoot}: ${opts.requested}`;
  }
  for (const dir of opts.blockedOutputDirs ?? []) {
    if (await underDir(dir, true)) {
      return `Path is inside a subagent output_dir that is still in use (${dir}): ${opts.requested}`;
    }
  }
  return null;
}
