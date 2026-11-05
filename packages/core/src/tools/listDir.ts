import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

const SKIP = new Set(["node_modules", ".git", ".agent"]);

export const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description:
      "List files and directories inside a workspace folder (skips node_modules, .git, .agent).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory relative to workspace; default is workspace root",
        },
      },
      required: [],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pathArg = args.path == null || String(args.path) === "" ? "." : String(args.path);
    try {
      const abs = resolveWithinWorkspace(ctx.workspacePath, pathArg);
      const realRoot = await realpath(ctx.workspacePath);
      let realTarget: string;
      try {
        realTarget = await realpath(abs);
      } catch (err) {
        return { content: String(err), is_error: true };
      }
      if (!isPathInside(realRoot, realTarget)) {
        return { content: `Path is outside workspace: ${pathArg}`, is_error: true };
      }
      const st = await stat(realTarget);
      if (!st.isDirectory()) {
        return { content: `Not a directory: ${pathArg}`, is_error: true };
      }
      const entries = await readdir(realTarget, { withFileTypes: true });
      const lines: string[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP.has(e.name)) continue;
        const child = join(realTarget, e.name);
        let kind = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
        try {
          const realChild = await realpath(child);
          if (!isPathInside(realRoot, realChild)) continue;
          const cst = await stat(realChild);
          kind = cst.isDirectory() ? "dir" : cst.isFile() ? "file" : "other";
        } catch {
          continue;
        }
        const rel = relative(ctx.workspacePath, child) || e.name;
        lines.push(`${kind === "dir" ? "dir " : "file"}  ${rel.replace(/\\/g, "/")}`);
      }
      const header = `Listing ${pathArg === "." ? "." : pathArg} (${lines.length} entries)`;
      const body = lines.length ? lines.join("\n") : "(empty)";
      return {
        content: truncateOutput(`${header}\n${body}`, ctx.maxToolOutputChars),
        is_error: false,
      };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
