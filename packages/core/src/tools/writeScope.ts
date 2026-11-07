import { resolve } from "node:path";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";

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
  if (parts[0] === ".agent") return { ok: false, error: "output_dir cannot be inside .agent" };
  return { ok: true, dir: parts.join("/") };
}

/** True when one directory is the other, or either contains the other. */
export function outputDirsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const left = `${a}/`;
  const right = `${b}/`;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Reject a write that leaves a subagent's output_dir, or lands in a directory
 * claimed by a subagent started in the same parent tool batch.
 * Returns null when the path is outside the workspace; the file tool reports that itself.
 */
export function writeScopeError(opts: {
  workspacePath: string;
  requested: string;
  writeRoot?: string;
  blockedOutputDirs?: readonly string[];
}): string | null {
  if (!opts.writeRoot && !opts.blockedOutputDirs?.length) return null;
  if (!opts.requested.trim()) return null;
  let abs: string;
  try {
    abs = resolveWithinWorkspace(opts.workspacePath, opts.requested);
  } catch {
    return null;
  }
  if (opts.writeRoot) {
    const root = resolve(opts.workspacePath, opts.writeRoot);
    if (!isPathInside(root, abs)) {
      return `Path is outside the subagent output_dir ${opts.writeRoot}: ${opts.requested}`;
    }
  }
  for (const dir of opts.blockedOutputDirs ?? []) {
    const root = resolve(opts.workspacePath, dir);
    if (isPathInside(root, abs)) {
      return `Path is inside a subagent output_dir from this response (${dir}): ${opts.requested}`;
    }
  }
  return null;
}
