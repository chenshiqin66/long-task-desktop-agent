import { access, mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";

export const MAX_WRITE_CHARS = 500_000;

/** Resolve an existing path and ensure it stays inside the workspace after realpath. */
export async function resolveExistingFile(
  workspacePath: string,
  relativeOrAbsolute: string,
): Promise<{ abs: string; realRoot: string; realTarget: string } | { error: string }> {
  try {
    const abs = resolveWithinWorkspace(workspacePath, relativeOrAbsolute);
    const realRoot = await realpath(workspacePath);
    let realTarget: string;
    try {
      realTarget = await realpath(abs);
    } catch (err) {
      return { error: String(err) };
    }
    if (!isPathInside(realRoot, realTarget)) {
      return { error: `Path is outside workspace: ${relativeOrAbsolute}` };
    }
    return { abs, realRoot, realTarget };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Resolve a path for create/overwrite. Ensures the nearest existing ancestor
 * stays inside the workspace, then creates missing parent directories.
 */
export async function resolveWritableFile(
  workspacePath: string,
  relativeOrAbsolute: string,
): Promise<{ abs: string; realRoot: string } | { error: string }> {
  try {
    const abs = resolveWithinWorkspace(workspacePath, relativeOrAbsolute);
    const realRoot = await realpath(workspacePath);

    let probe = dirname(abs);
    for (;;) {
      try {
        await access(probe);
        const realProbe = await realpath(probe);
        if (!isPathInside(realRoot, realProbe)) {
          return { error: `Path is outside workspace: ${relativeOrAbsolute}` };
        }
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) {
          return { error: `Path is outside workspace: ${relativeOrAbsolute}` };
        }
        probe = parent;
      }
    }

    await mkdir(dirname(abs), { recursive: true });
    const realParent = await realpath(dirname(abs));
    if (!isPathInside(realRoot, realParent)) {
      return { error: `Path is outside workspace: ${relativeOrAbsolute}` };
    }
    return { abs, realRoot };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function assertStillInside(
  realRoot: string,
  absPath: string,
  requested: string,
): Promise<string | null> {
  try {
    const realTarget = await realpath(absPath);
    if (!isPathInside(realRoot, realTarget)) {
      return `Path is outside workspace: ${requested}`;
    }
    return null;
  } catch (err) {
    return String(err);
  }
}
