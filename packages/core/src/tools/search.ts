import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

const SKIP = new Set(["node_modules", ".git", ".agent"]);
/** One call should carry the terms for one path, not a second scan per word. */
const MAX_TERMS = 8;

function collectTerms(args: Record<string, unknown>): { terms: string[]; omitted: number } | { error: string } {
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const term = value.trim();
    if (term && !found.includes(term)) found.push(term);
  };
  const from = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    push(value);
  };
  from(args.queries);
  from(args.query);
  if (found.length === 0) return { error: "Missing query. Pass query or queries." };
  return { terms: found.slice(0, MAX_TERMS), omitted: Math.max(0, found.length - MAX_TERMS) };
}

async function safeReal(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export const searchTool: Tool = {
  definition: {
    name: "keyword_search",
    description:
      "Search one workspace file or directory for every given term in a single call. Pass path as the narrowest file or directory the task names. Put all terms in queries. Do not call again for another term in that same path. Omit path only when the location is unknown; that scans the whole workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative file or directory. Pass the narrowest path. Use . only when you do not know where to look.",
        },
        query: {
          type: "string",
          description: "One term. Prefer queries when there is more than one term.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Every term to find under path. One call searches all of them.",
        },
      },
      required: [],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const parsed = collectTerms(args);
    if ("error" in parsed) return { content: parsed.error, is_error: true };
    const { terms, omitted } = parsed;
    const pathArg = typeof args.path === "string" ? args.path.trim() : "";
    const requested = pathArg || ".";
    if (ctx.signal?.aborted) return { content: "Search cancelled", is_error: true };

    try {
      const realRoot = await realpath(ctx.workspacePath);
      const abs = resolveWithinWorkspace(ctx.workspacePath, requested);
      const realStart = await safeReal(abs);
      if (!realStart || !isPathInside(realRoot, realStart)) {
        return { content: `Path is outside workspace: ${requested}`, is_error: true };
      }
      const startStat = await stat(realStart);
      const hits: string[] = [];
      const seen = new Set<string>();
      let cancelled = false;

      const considerFile = async (file: string, realFile: string): Promise<void> => {
        if (hits.length >= ctx.maxSearchResults) return;
        const info = await stat(realFile);
        if (!info.isFile() || info.size > 1_000_000) return;
        let text: string;
        try {
          text = await readFile(realFile, "utf8");
        } catch {
          return;
        }
        const showTerm = terms.length > 1;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          const matched = terms.find((term) => line.includes(term));
          if (!matched) continue;
          const rel = relative(ctx.workspacePath, file).replace(/\\/g, "/");
          hits.push(showTerm ? `${rel}:${i + 1}:${matched}:${line}` : `${rel}:${i + 1}:${line}`);
          if (hits.length >= ctx.maxSearchResults) return;
        }
      };

      const walk = async (dir: string): Promise<void> => {
        if (cancelled || hits.length >= ctx.maxSearchResults) return;
        if (ctx.signal?.aborted) {
          cancelled = true;
          return;
        }
        const realDir = await safeReal(dir);
        if (!realDir || !isPathInside(realRoot, realDir) || seen.has(realDir)) return;
        seen.add(realDir);
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (cancelled || hits.length >= ctx.maxSearchResults) return;
          if (ctx.signal?.aborted) {
            cancelled = true;
            return;
          }
          if (SKIP.has(entry.name)) continue;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(child);
            continue;
          }
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          const realFile = await safeReal(child);
          if (!realFile || !isPathInside(realRoot, realFile) || seen.has(realFile)) continue;
          const info = await stat(realFile);
          if (info.isDirectory()) {
            await walk(child);
            continue;
          }
          seen.add(realFile);
          await considerFile(child, realFile);
        }
      };

      if (startStat.isDirectory()) await walk(abs);
      else if (startStat.isFile()) {
        if (ctx.signal?.aborted) cancelled = true;
        else await considerFile(abs, realStart);
      } else {
        return { content: `Not a file or directory: ${requested}`, is_error: true };
      }

      if (cancelled) return { content: "Search cancelled", is_error: true };

      const notes: string[] = [];
      if (!pathArg) {
        notes.push("No path was given, so this searched the whole workspace. Pass path next time.");
      }
      if (omitted > 0) {
        notes.push(`Only the first ${MAX_TERMS} terms were searched. ${omitted} terms were left out.`);
      }
      const note = notes.length ? `\n${notes.join(" ")}` : "";
      const body = hits.length ? hits.join("\n") : "No matches";
      const room = Math.max(0, ctx.maxToolOutputChars - note.length);
      return { content: truncateOutput(body, room) + note, is_error: false };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
