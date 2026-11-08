import type { Message } from "../types.js";
import type { Tool } from "../tools/types.js";
import { webSearchTool } from "../tools/webSearch.js";

/** Each side of the quoted turn. Longer text is clipped, but the selection stays inside. */
export const EXPLAIN_CONTEXT_CHARS = 4000;

export const EXPLAIN_SYSTEM_PROMPT = [
  "你是一个轻量解释助手。只根据本条系统提示、已有对话，以及用户消息里给出的语境来回答。",
  "回答尽量简洁，控制在 200 字以内。只有用户明确要求展开时才写长。",
  "需要查证时使用 web_search。解释正文仍控制在 200 字以内。来源列表写在正文后面，不计入这 200 字，并且最多 3 条。",
  "不要声称看过这条用户消息以外的主会话。用用户使用的语言回答。",
].join("\n");

const REMINDER_LINE = "这是用户的提问语境，请尽量基于此语境回答用户的问题";

/** web_search for the explain instance. The main agent's tool text is unchanged. */
export function explainWebSearchTool(): Tool {
  return {
    definition: {
      ...webSearchTool.definition,
      description:
        "Search the live web via DeepSeek Search API. Query max 128 characters. After using this tool, cite at most 3 sources: inline [n] plus a 来源 list of at most 3 items formatted as [n] [title](url). Pick the most relevant hits. The 来源 list does not count toward the 200-character answer. Do not print bare URLs.",
    },
    execute: (args, ctx) => webSearchTool.execute(args, ctx),
  };
}

export function buildExplainUserContent(
  userInput: string,
  context: { user: string; assistant: string },
): string {
  return [
    "<system reminder>",
    `用户：\n${context.user}`,
    `助手：\n${context.assistant}`,
    REMINDER_LINE,
    "</system reminder>",
    userInput,
  ].join("\n");
}

/** Green bubble text. The reminder block stays in the stored user message. */
export function visibleExplainText(content: string): string {
  const marker = "\n</system reminder>\n";
  if (!content.startsWith("<system reminder>\n")) return content;
  const at = content.indexOf(marker);
  if (at < 0) return content;
  return content.slice(at + marker.length);
}

export function clipKeeping(text: string, needle: string, limit = EXPLAIN_CONTEXT_CHARS): string {
  if (text.length <= limit) return text;
  const at = needle ? text.indexOf(needle) : -1;
  if (at < 0 || at + Math.max(needle.length, 0) <= limit) return `${text.slice(0, limit)}\n…`;
  const room = Math.max(needle.length, limit);
  const start = Math.max(0, at - Math.floor((room - needle.length) / 2));
  const end = Math.min(text.length, start + room);
  const prefix = start > 0 ? "…\n" : "";
  const suffix = end < text.length ? "\n…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * User and assistant text from the turn that owns the selection.
 * Tool arguments and tool results are left out. Null when the turn cannot be found.
 */
export function sourceTurnContext(
  messages: Message[],
  messageIds: string[],
  selectedText: string,
): { user: string; assistant: string } | null {
  const wanted = new Set(messageIds.filter((id) => id.trim().length > 0));
  const turnIds: string[] = [];
  const seen = new Set<string>();
  if (wanted.size) {
    for (const message of messages) {
      if (!wanted.has(message.id) || seen.has(message.turn_id)) continue;
      seen.add(message.turn_id);
      turnIds.push(message.turn_id);
    }
  }
  if (!turnIds.length) {
    const needle = selectedText.trim();
    if (!needle) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (!message.content.includes(needle)) continue;
      turnIds.push(message.turn_id);
      break;
    }
  }
  if (!turnIds.length) return null;

  const turnSet = new Set(turnIds);
  const users: string[] = [];
  const assistants: string[] = [];
  for (const message of messages) {
    if (!turnSet.has(message.turn_id)) continue;
    if (message.role === "user" && message.name !== "task-notification") users.push(message.content);
    else if (message.role === "assistant") assistants.push(message.content);
  }
  const needle = selectedText.trim();
  return {
    user: clipKeeping(users.filter((part) => part.trim()).join("\n\n"), needle),
    assistant: clipKeeping(assistants.filter((part) => part.trim()).join("\n\n"), needle),
  };
}
