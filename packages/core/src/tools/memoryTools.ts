import { isMemoryScope, type MemoryEntry } from "../memory/entry.js";
import { ageLabel, orderForContext, scopeLabel } from "../memory/prompt.js";
import type { Tool, ToolResult } from "./types.js";

export const MEMORY_READ_TOOL_NAME = "memory_read";

function listLine(entry: MemoryEntry, now: Date): string {
  return `- [${entry.type}] ${entry.name}（${scopeLabel(entry.scope)}，${ageLabel(entry.modified, now)}）：${entry.description}`;
}

function fullNote(entry: MemoryEntry, now: Date): string {
  return [
    `name: ${entry.name}`,
    `scope: ${entry.scope}（${scopeLabel(entry.scope)}）`,
    `type: ${entry.type}`,
    `description: ${entry.description}`,
    `modified: ${entry.modified}（${ageLabel(entry.modified, now)}）`,
    `origin: ${entry.origin}`,
    "",
    entry.body,
  ].join("\n");
}

/** Read-only. Notes are written only by the background pass and on the memory page. */
export const memoryReadTool: Tool = {
  definition: {
    name: MEMORY_READ_TOOL_NAME,
    description:
      "Read memory notes saved in earlier sessions. Omit name to list every note with its type, scope, age and description. Set name to get that note's fields and body. This tool cannot save or change notes.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note name, as shown in the Memory section or in the list" },
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Optional. user: notes for every project. project: notes for this repository.",
        },
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.memory) return { content: "Memory is not available in this conversation.", is_error: true };
    const scope = args.scope === undefined || args.scope === "" ? undefined : args.scope;
    if (scope !== undefined && !isMemoryScope(scope)) return { content: "scope must be user or project.", is_error: true };
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const now = new Date();
    const { entries, unreadable } = await ctx.memory.list();
    if (!name) {
      const lines = orderForContext(entries.filter((entry) => !scope || entry.scope === scope)).map((entry) => listLine(entry, now));
      if (unreadable.length) lines.push(`${unreadable.length} memory file(s) could not be read.`);
      return { content: lines.length ? lines.join("\n") : "No memory notes.", is_error: false };
    }
    const hits = entries.filter((entry) => entry.name === name && (!scope || entry.scope === scope));
    if (!hits.length) return { content: `No memory note named ${name}.`, is_error: true };
    return { content: hits.map((entry) => fullNote(entry, now)).join("\n\n---\n\n"), is_error: false };
  },
};
