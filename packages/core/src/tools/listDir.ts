import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathInside } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";
import { locateToolPath } from "./skillPath.js";

const SKIP = new Set(["node_modules", ".git", ".agent"]);

export const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description:
      "List one workspace folder, or one folder inside an installed skill. Skips node_modules, .git, and .agent. Set skill and a relative path, or pass an absolute path that is already inside that skill. The listing stays inside that skill.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace directory, a directory relative to the skill when skill is set, or an absolute path inside one installed skill. Default is the workspace root.",
        },
        skill: {
          type: "string",
          description: "Installed skill name. When set, path must stay inside that skill. Omit path to list that skill.",
        },
      },
      required: [],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pathArg = args.path == null || String(args.path) === "" ? "" : String(args.path);
    const skillArg = typeof args.skill === "string" ? args.skill.trim() : "";
    const shown = pathArg.trim() || ".";
    try {
      const located = await locateToolPath(pathArg, skillArg, ctx);
      if ("error" in located) return { content: located.error, is_error: true };
      const st = await stat(located.target);
      if (!st.isDirectory()) return { content: `Not a directory: ${shown}`, is_error: true };
      const entries = await readdir(located.target, { withFileTypes: true });
      const lines: string[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP.has(e.name)) continue;
        const child = join(located.target, e.name);
        let kind = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
        try {
          const realChild = await realpath(child);
          if (!isPathInside(located.boundary, realChild)) continue;
          const cst = await stat(realChild);
          kind = cst.isDirectory() ? "dir" : cst.isFile() ? "file" : "other";
        } catch {
          continue;
        }
        const rel = relative(located.displayRoot, child) || e.name;
        lines.push(`${kind === "dir" ? "dir " : "file"}  ${rel.replace(/\\/g, "/")}`);
      }
      const relShown = located.skill
        ? relative(located.displayRoot, located.target).replace(/\\/g, "/") || "."
        : shown;
      const where = located.skill
        ? `skill ${located.skill}${relShown === "." ? "" : `/${relShown}`}`
        : shown;
      const header = `Listing ${where} (${lines.length} entries)`;
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
