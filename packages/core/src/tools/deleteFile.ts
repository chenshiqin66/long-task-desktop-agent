import { unlink, stat } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.js";
import { resolveExistingFile } from "./fsSandbox.js";

export const deleteFileTool: Tool = {
  definition: {
    name: "delete_file",
    description: "Delete a single file inside the workspace (not directories).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace or absolute inside it",
        },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const requested = String(args.path ?? "");
    if (!requested) return { content: "Missing path", is_error: true };
    const resolved = await resolveExistingFile(ctx.workspacePath, requested);
    if ("error" in resolved) return { content: resolved.error, is_error: true };
    try {
      const st = await stat(resolved.realTarget);
      if (!st.isFile()) {
        return {
          content: `Not a file (directories not supported): ${requested}`,
          is_error: true,
        };
      }
      await unlink(resolved.realTarget);
      return { content: `Deleted ${requested}`, is_error: false };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
