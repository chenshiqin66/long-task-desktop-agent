import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.js";
import {
  MAX_WRITE_CHARS,
  assertStillInside,
  resolveExistingFile,
} from "./fsSandbox.js";
import { writeScopeError } from "./writeScope.js";

export const strReplaceTool: Tool = {
  definition: {
    name: "str_replace",
    description:
      "Replace an exact substring in a workspace text file. Use for surgical edits; prefer over rewriting the whole file with write_file or the shell.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace or absolute inside it",
        },
        old_string: {
          type: "string",
          description: "Exact text to find (must be unique unless replace_all)",
        },
        new_string: {
          type: "string",
          description: "Replacement text",
        },
        replace_all: {
          type: "boolean",
          description: "If true, replace every occurrence; default false",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const requested = String(args.path ?? "");
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    const replaceAll = Boolean(args.replace_all);
    if (!requested) return { content: "Missing path", is_error: true };
    if (!oldString) return { content: "Missing old_string", is_error: true };
    const scoped = await writeScopeError({
      workspacePath: ctx.workspacePath,
      requested,
      writeRoot: ctx.writeRoot,
      blockedOutputDirs: ctx.blockedOutputDirs,
    });
    if (scoped) return { content: scoped, is_error: true };

    const resolved = await resolveExistingFile(ctx.workspacePath, requested);
    if ("error" in resolved) return { content: resolved.error, is_error: true };

    try {
      const before = await readFile(resolved.realTarget, "utf8");
      const count = before.split(oldString).length - 1;
      if (count === 0) {
        return { content: `old_string not found in ${requested}`, is_error: true };
      }
      if (count > 1 && !replaceAll) {
        return {
          content: `old_string found ${count} times in ${requested}; pass replace_all=true or provide a more unique string`,
          is_error: true,
        };
      }
      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);
      if (after.length > MAX_WRITE_CHARS) {
        return {
          content: `Resulting file too large (${after.length} chars; max ${MAX_WRITE_CHARS})`,
          is_error: true,
        };
      }
      await writeFile(resolved.realTarget, after, "utf8");
      const outside = await assertStillInside(
        resolved.realRoot,
        resolved.realTarget,
        requested,
      );
      if (outside) return { content: outside, is_error: true };
      return {
        content: `Updated ${requested} (${replaceAll ? count : 1} replacement${count === 1 || !replaceAll ? "" : "s"})`,
        is_error: false,
      };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
