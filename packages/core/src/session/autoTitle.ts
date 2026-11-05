import type { Message } from "../types.js";
import type { LlmProvider } from "../provider/types.js";

/** Max display length for session titles (汉字 / 码点计). */
export const SESSION_TITLE_MAX_CHARS = 12;

const DEFAULT_TITLE = "会话";

export function isDefaultSessionTitle(title: string | undefined): boolean {
  if (title == null) return true;
  const t = title.trim();
  return !t || t === DEFAULT_TITLE;
}

/** Collapse model output to a single ≤12-char title. */
export function sanitizeSessionTitle(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n").trim();
  t = t.split("\n")[0] ?? "";
  t = t.replace(/^["「『《]+|[」』》"]+$/g, "").trim();
  t = t.replace(/\s+/g, "");
  const chars = Array.from(t);
  if (chars.length > SESSION_TITLE_MAX_CHARS) {
    t = chars.slice(0, SESSION_TITLE_MAX_CHARS).join("");
  }
  return t || DEFAULT_TITLE;
}

/** Fallback when the LLM call fails: first user message, truncated. */
export function titleFromFirstUserMessage(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return DEFAULT_TITLE;
  return sanitizeSessionTitle(first.content);
}

function buildTitlePrompt(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content.trim()) continue;
    const role = m.role === "user" ? "用户" : "助手";
    lines.push(`${role}: ${m.content.slice(0, 240)}`);
    if (lines.length >= 10) break;
  }
  return [
    "根据下列对话写一个简短会话标题。",
    `要求：不超过${SESSION_TITLE_MAX_CHARS}个汉字（或同等长度字符）；只输出标题本身，不要引号、标点、解释或换行。`,
    "",
    lines.join("\n") || "（空对话）",
  ].join("\n");
}

/**
 * Ask the model for a short title. Best-effort: on failure returns first-user fallback.
 */
export async function generateSessionTitle(opts: {
  provider: LlmProvider;
  model: string;
  messages: Message[];
  signal?: AbortSignal;
}): Promise<string> {
  const fallback = titleFromFirstUserMessage(opts.messages);
  try {
    let text = "";
    for await (const chunk of opts.provider.chatStream({
      messages: [{ role: "user", content: buildTitlePrompt(opts.messages) }],
      tools: [],
      model: opts.model,
      signal: opts.signal,
    })) {
      if (chunk.type === "error") return fallback;
      if (chunk.type === "text" && chunk.text) text += chunk.text;
    }
    const title = sanitizeSessionTitle(text);
    return title === DEFAULT_TITLE ? fallback : title;
  } catch {
    return fallback;
  }
}
