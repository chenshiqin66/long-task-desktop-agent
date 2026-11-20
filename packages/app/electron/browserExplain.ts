import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { sessionDir } from "@agent/core";

/**
 * What the renderer sends in place of a workspace and a session when the explain pane works for the
 * browser. The browser has no session of its own, so its explanations get a separate record under the
 * app's own data folder, never inside a workspace. Keep these two in step with
 * `src/renderer/browserExplain.ts`; a test compares them.
 */
export const BROWSER_EXPLAIN_WORKSPACE = "browser:explain";
export const BROWSER_EXPLAIN_SESSION = "browser-explain";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The explain store keeps its files beside a session's, so it needs a session to sit beside. This makes one
 * under `base` the first time and leaves it alone afterwards. Returns the folder to use as the workspace.
 */
export async function ensureBrowserExplainStore(base: string): Promise<string> {
  const dir = sessionDir(base, BROWSER_EXPLAIN_SESSION);
  const meta = join(dir, "meta.json");
  if (!(await exists(meta))) {
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      meta,
      JSON.stringify(
        {
          session_id: BROWSER_EXPLAIN_SESSION,
          workspace_path: base,
          created_at: now,
          updated_at: now,
          title: "浏览器解释",
        },
        null,
        2,
      ),
      "utf8",
    );
    for (const name of ["messages.jsonl", "trace.jsonl", "context.jsonl"]) {
      await writeFile(join(dir, name), "", "utf8");
    }
  }
  return base;
}
