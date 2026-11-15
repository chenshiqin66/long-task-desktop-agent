import { readFile, stat } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";
import { locateToolPath } from "./skillPath.js";

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file in the workspace, or inside one installed skill. Set skill and a relative path, or pass an absolute path that is already inside that skill. An absolute path is accepted only when it lands in one skill, and the read stays inside that skill.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace path, a path relative to the skill when skill is set, or an absolute path inside one installed skill.",
        },
        skill: {
          type: "string",
          description: "Installed skill name. When set, path must stay inside that skill.",
        },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const requested = String(args.path ?? "");
      const skill = typeof args.skill === "string" ? args.skill.trim() : "";
      if (skill && !requested.trim()) return { content: "缺少路径", is_error: true };
      const located = await locateToolPath(requested, skill, ctx);
      if ("error" in located) return { content: located.error, is_error: true };
      const info = await stat(located.target);
      if (!info.isFile()) return { content: `Not a file: ${requested}`, is_error: true };
      const raw = await readFile(located.target, "utf8");
      return { content: truncateOutput(raw, ctx.maxReadChars), is_error: false };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
