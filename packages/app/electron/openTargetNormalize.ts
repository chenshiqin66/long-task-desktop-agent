import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWithinWorkspace } from "@agent/core";

/** Decode entities that may appear in markdown-escaped href payloads. */
export function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Normalize agent-written paths for the host OS.
 * Handles http(s), file://, Windows paths, and WSL /mnt/c/... style paths.
 */
export function normalizeOpenTarget(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): { kind: "url" | "path"; value: string } {
  let s = decodeBasicEntities(raw).trim();
  s = s.replace(/^['"`]+|['"`]+$/g, "");

  if (/^https?:\/\//i.test(s)) {
    return { kind: "url", value: s };
  }

  if (/^file:\/\//i.test(s)) {
    try {
      return { kind: "path", value: fileURLToPath(s) };
    } catch {
      return { kind: "url", value: s };
    }
  }

  const mnt = s.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) {
    const drive = mnt[1]!.toUpperCase();
    const rest = mnt[2]!.replace(/\//g, "\\");
    return { kind: "path", value: `${drive}:\\${rest}` };
  }

  // /c/Users/... (Git Bash style) on Windows hosts
  const gitBash = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBash && platform === "win32") {
    const drive = gitBash[1]!.toUpperCase();
    const rest = gitBash[2]!.replace(/\//g, "\\");
    return { kind: "path", value: `${drive}:\\${rest}` };
  }

  return { kind: "path", value: s };
}

/**
 * Turn an agent-written file reference into an absolute path.
 * Relative names are resolved inside the workspace; `..` that escapes is rejected.
 */
export function resolveLocalOpenPath(
  raw: string,
  workspacePath: string | null,
  platform: NodeJS.Platform = process.platform,
): { ok: true; path: string } | { ok: false; error: string } {
  const target = normalizeOpenTarget(raw, platform);
  if (target.kind === "url") return { ok: false, error: "Not a file path" };
  if (!isAbsolute(target.value)) {
    if (!workspacePath) return { ok: false, error: "未选择工作区" };
    try {
      return { ok: true, path: resolveWithinWorkspace(workspacePath, target.value) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, path: target.value };
}
