import { readFile, stat } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.js";
import { locateToolPath } from "./skillPath.js";

/** Lines split on \n. A final newline does not start another line. A \r stays with its line. */
export function splitLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function positiveInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Whole file. A long file is cut at a line boundary and the rest is dropped. The note sends
 * the model to keyword_search for line numbers and then to a line range, not to page on from here.
 */
function fullRead(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const lines = splitLines(raw);
  let used = 0;
  let shown = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max) break;
    used += line.length + 1;
    shown += 1;
  }
  if (shown === 0) {
    return `${raw.slice(0, max)}\n...[truncated: the first line alone is longer than ${max} characters]`;
  }
  return `${lines.slice(0, shown).join("\n")}\n...[cut after line ${shown} of ${lines.length}: one read returns at most ${max} characters and the rest was not returned. To reach another part, find its line numbers with keyword_search (hits are path:line:text), then call read_file with offset and limit for just that range. Do not page through the file from here.]`;
}

/**
 * A line range. Each line is numbered, and the numbers are not part of the file.
 * The footer says which lines were returned. It does not point at the next range: the model
 * should pick ranges from keyword_search line numbers, not walk the file in order.
 */
function rangeRead(raw: string, start: number, limit: number | null, max: number): ToolResult {
  const lines = splitLines(raw);
  const total = lines.length;
  if (total === 0) return { content: "[the file is empty]", is_error: false };
  if (start > total) {
    return { content: `offset ${start} is past the end; the file has ${total} lines.`, is_error: true };
  }
  const end = limit === null ? total : Math.min(total, start - 1 + limit);
  const out: string[] = [];
  let used = 0;
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    const text = `${n}\t${lines[n - 1]}`;
    if (out.length === 0 && text.length > max) {
      out.push(`${text.slice(0, max)} ...[this line is longer than ${max} characters and was cut]`);
      last = n;
      break;
    }
    if (out.length > 0 && used + text.length + 1 > max) break;
    used += text.length + 1;
    out.push(text);
    last = n;
  }
  // last < end only when the size limit stopped the range before the lines that were asked for.
  const footer =
    last < end
      ? `[lines ${start}-${last} of ${total}. This range was cut at the read limit of ${max} characters; ask for fewer lines.]`
      : `[lines ${start}-${last} of ${total}]`;
  return { content: `${out.join("\n")}\n${footer}`, is_error: false };
}

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file in the workspace, or inside one installed skill. Set skill and a relative path, or pass an absolute path that is already inside that skill. An absolute path is accepted only when it lands in one skill, and the read stays inside that skill. Short files: call without offset or limit to read the whole file in one call. A whole read returns at most the configured maxReadChars (50,000 characters by default) and drops the rest. For a long file, do not page through it from the top: find the lines you need with keyword_search (it returns path:line:text), then pass offset (first line, 1-based) and limit (number of lines) to read only that range. Lines are then numbered in the result, and the numbers are not in the file, so do not copy them into str_replace. Read files with this tool, not with powershell or bash slices.",
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
        offset: {
          type: "integer",
          description: "First line to return, 1-based. Use with limit to read part of a long file.",
        },
        limit: {
          type: "integer",
          description: "How many lines to return from offset. Defaults to the rest of the file.",
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
      const hasOffset = args.offset !== undefined;
      const hasLimit = args.limit !== undefined;
      const offset = hasOffset ? positiveInteger(args.offset) : 1;
      const limit = hasLimit ? positiveInteger(args.limit) : null;
      if (offset === null) return { content: "offset must be a whole number of 1 or more.", is_error: true };
      if (hasLimit && limit === null) return { content: "limit must be a whole number of 1 or more.", is_error: true };
      const located = await locateToolPath(requested, skill, ctx);
      if ("error" in located) return { content: located.error, is_error: true };
      const info = await stat(located.target);
      if (!info.isFile()) return { content: `Not a file: ${requested}`, is_error: true };
      const raw = await readFile(located.target, "utf8");
      if (!hasOffset && !hasLimit) return { content: fullRead(raw, ctx.maxReadChars), is_error: false };
      return rangeRead(raw, offset, limit, ctx.maxReadChars);
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
