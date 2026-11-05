import { access, stat } from "node:fs/promises";
import { shell } from "electron";
import { normalizeOpenTarget, resolveLocalOpenPath } from "./openTargetNormalize.js";

export { decodeBasicEntities, normalizeOpenTarget, resolveLocalOpenPath } from "./openTargetNormalize.js";

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
