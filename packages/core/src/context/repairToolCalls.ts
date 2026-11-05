import type { Message, ToolCall } from "../types.js";

export const SYNTHETIC_INTERRUPTED_TOOL =
  "Synthetic: missing tool result (turn interrupted or storage failed). Tool was not executed.";

export interface MissingToolResult {
  tool_call_id: string;
  name: string;
  arguments?: string;
  session_id: string;
  turn_id: string;
  /** Index in the messages array before which synthetic tool msgs should be inserted. */
  insertBefore: number;
}

/** Find tool_call ids that lack a following tool message before the next user/assistant. */
export function findMissingToolResults(messages: Message[]): MissingToolResult[] {
  const missing: MissingToolResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const pending = new Map(m.tool_calls.map((tc) => [tc.id, tc]));
    let j = i + 1;
    while (j < messages.length) {
      const n = messages[j]!;
      if (n.role === "tool") {
        if (n.tool_call_id && pending.has(n.tool_call_id)) pending.delete(n.tool_call_id);
        j++;
        continue;
      }
      break;
    }
    for (const tc of pending.values()) {
      missing.push({
        tool_call_id: tc.id,
        name: tc.function.name || "unknown",
        arguments: tc.function.arguments,
        session_id: m.session_id,
        turn_id: m.turn_id,
        insertBefore: j,
      });
    }
  }
  return missing;
}

export function makeSyntheticToolMessage(
  info: Omit<MissingToolResult, "insertBefore">,
  content: string,
  ids: { id: string; created_at: string },
): Message {
  return {
    id: ids.id,
    session_id: info.session_id,
    turn_id: info.turn_id,
    role: "tool",
    name: info.name,
    tool_call_id: info.tool_call_id,
    tool_call_arguments: info.arguments,
    content,
    is_error: true,
    created_at: ids.created_at,
  };
}

/**
 * Insert synthetic tool messages so every assistant.tool_calls id has a response
 * before the next user/assistant. Pure; does not mutate input.
 */
export function repairToolCallPairs(
  messages: Message[],
  makeTool: (info: MissingToolResult) => Message,
): Message[] {
  const missing = findMissingToolResults(messages);
  if (missing.length === 0) return messages;

  const byIndex = new Map<number, Message[]>();
  for (const info of missing) {
    const list = byIndex.get(info.insertBefore) ?? [];
    list.push(makeTool(info));
    byIndex.set(info.insertBefore, list);
  }

  const out: Message[] = [];
  for (let i = 0; i <= messages.length; i++) {
    const extras = byIndex.get(i);
    if (extras) out.push(...extras);
    if (i < messages.length) out.push(messages[i]!);
  }
  return out;
}

/** True when orphans can be fixed by appending to jsonl (nothing after the open tool block). */
export function canAppendToolRepair(messages: Message[]): boolean {
  const missing = findMissingToolResults(messages);
  if (missing.length === 0) return false;
  const maxInsert = Math.max(...missing.map((m) => m.insertBefore));
  return maxInsert === messages.length;
}

export function toolCallsFromMissing(missing: MissingToolResult[]): ToolCall[] {
  return missing.map((m) => ({
    id: m.tool_call_id,
    type: "function" as const,
    function: { name: m.name, arguments: "{}" },
  }));
}
