import { readFile, realpath } from "node:fs/promises";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace.",
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
    try {
      const requested = String(args.path ?? "");
      const abs = resolveWithinWorkspace(ctx.workspacePath, requested);
      const realRoot = await realpath(ctx.workspacePath);
      let realTarget: string;
      try {
        realTarget = await realpath(abs);
      } catch (err) {
        return { content: String(err), is_error: true };
      }
      if (!isPathInside(realRoot, realTarget)) {
        return {
          content: `Path is outside workspace: ${requested}`,
          is_error: true,
        };
      }
      const raw = await readFile(realTarget, "utf8");
      return { content: truncateOutput(raw, ctx.maxReadChars), is_error: false };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
