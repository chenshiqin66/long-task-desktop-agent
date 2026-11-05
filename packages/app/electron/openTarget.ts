import { access, stat } from "node:fs/promises";
import { shell } from "electron";
import { normalizeOpenTarget, resolveLocalOpenPath } from "./openTargetNormalize.js";

export { decodeBasicEntities, normalizeOpenTarget, resolveLocalOpenPath } from "./openTargetNormalize.js";

/** Same resolution as a click. Missing paths are false; http(s) is not a local file. */
export async function localTargetsExist(
  targets: string[],
  workspacePath?: string | null,
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const list = targets.filter((item) => typeof item === "string").slice(0, 500);
  await Promise.all(
    list.map(async (raw) => {
      if (!raw || raw.length > 4096 || /^https?:\/\//i.test(raw)) {
        out[raw] = false;
        return;
      }
      const resolved = resolveLocalOpenPath(raw, workspacePath ?? null);
      if (!resolved.ok) {
        out[raw] = false;
        return;
      }
      try {
        await access(resolved.path);
        out[raw] = true;
      } catch {
        out[raw] = false;
      }
    }),
  );
  return out;
}

export async function openTarget(
  raw: string,
  workspacePath?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "Empty open target" };
  }
  if (raw.length > 4096) {
    return { ok: false, error: "Open target too long" };
  }

  const target = normalizeOpenTarget(raw);
  try {
    if (target.kind === "url") {
      if (!/^https?:\/\//i.test(target.value)) {
        return { ok: false, error: "Only http(s) URLs are allowed" };
      }
      await shell.openExternal(target.value);
      return { ok: true };
    }

    const resolved = resolveLocalOpenPath(raw, workspacePath ?? null);
    if (!resolved.ok) return resolved;
    try {
      await access(resolved.path);
    } catch {
      return { ok: false, error: `Path not found: ${resolved.path}` };
    }
    const info = await stat(resolved.path);
    if (info.isDirectory()) {
      const err = await shell.openPath(resolved.path);
      if (err) return { ok: false, error: err };
      return { ok: true };
    }
    // Select the file in its parent folder instead of launching it.
    shell.showItemInFolder(resolved.path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
