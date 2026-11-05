import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathInside } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".agent") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, files);
    else files.push(p);
  }
}

export const searchTool: Tool = {
  definition: {
    name: "keyword_search",
    description: "Search workspace text files for a keyword; returns matching lines.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (!query) return { content: "Missing query", is_error: true };
    try {
      const realRoot = await realpath(ctx.workspacePath);
      const files: string[] = [];
      await walk(ctx.workspacePath, files);
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= ctx.maxSearchResults) break;
        let realTarget: string;
        try {
          realTarget = await realpath(file);
        } catch {
          continue;
        }
        if (!isPathInside(realRoot, realTarget)) continue;
        const st = await stat(realTarget);
        if (st.size > 1_000_000) continue;
        let text: string;
        try {
          text = await readFile(realTarget, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            hits.push(`${relative(ctx.workspacePath, file)}:${i + 1}:${lines[i]}`);
            if (hits.length >= ctx.maxSearchResults) break;
          }
        }
      }
      const content = hits.length ? hits.join("\n") : "No matches";
      return {
        content: truncateOutput(content, ctx.maxToolOutputChars),
        is_error: false,
      };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
