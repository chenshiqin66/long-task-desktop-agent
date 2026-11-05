import { createHash } from "node:crypto";
import type { AssembledMessage } from "./assemble.js";
import type { SentImage } from "./images.js";
import type { ToolCall } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";

/** Text the model saw, plus image files that were inlined. No data URLs. */
export interface AuditMessage {
  role: string;
  text: string;
  images?: SentImage[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Tool list in the same shape as the chat-completions request body. */
export interface WireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function projectAuditMessages(
  messages: AssembledMessage[],
  sentImages: SentImage[][],
): AuditMessage[] {
  return messages.map((message, index) => {
    const row: AuditMessage = { role: message.role, text: textOf(message.content) };
    const images = sentImages[index] ?? [];
    if (images.length) row.images = images;
    if (message.name) row.name = message.name;
    if (message.tool_call_id) row.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) row.tool_calls = message.tool_calls;
    return row;
  });
}

export function toolsFingerprint(tools: ToolDefinition[]): { sha256: string; tools: WireTool[] } {
  const wire = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const sha256 = createHash("sha256").update(JSON.stringify(wire)).digest("hex");
  return { sha256, tools: wire };
}

function textOf(content: AssembledMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
