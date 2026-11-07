import { writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.js";
import {
  MAX_WRITE_CHARS,
  assertStillInside,
  resolveWritableFile,
} from "./fsSandbox.js";
import { writeScopeError } from "./writeScope.js";

export const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the workspace. Prefer this over shell here-strings or redirection for file content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace or absolute inside it",
        },
        content: {
          type: "string",
          description: "Full file contents to write",
        },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const requested = String(args.path ?? "");
    const content = args.content == null ? "" : String(args.content);
    if (!requested) return { content: "Missing path", is_error: true };
    const scoped = writeScopeError({
      workspacePath: ctx.workspacePath,
      requested,
      writeRoot: ctx.writeRoot,
      blockedOutputDirs: ctx.blockedOutputDirs,
    });
    if (scoped) return { content: scoped, is_error: true };
    if (content.length > MAX_WRITE_CHARS) {
      return {
        content: `Content too large (${content.length} chars; max ${MAX_WRITE_CHARS}). Split the file or shorten content.`,
        is_error: true,
      };
    }
    const resolved = await resolveWritableFile(ctx.workspacePath, requested);
    if ("error" in resolved) return { content: resolved.error, is_error: true };
    try {
      await writeFile(resolved.abs, content, "utf8");
      const outside = await assertStillInside(resolved.realRoot, resolved.abs, requested);
      if (outside) return { content: outside, is_error: true };
      return {
        content: `Wrote ${content.length} chars to ${requested}`,
        is_error: false,
      };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
