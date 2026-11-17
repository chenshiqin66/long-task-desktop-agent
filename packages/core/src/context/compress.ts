import type { Message } from "../types.js";

export function countUserTurns(messages: Message[]): number {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "user") ids.add(m.turn_id);
  }
  return ids.size;
}

/** Body plus tool-call arguments. Tool results do not repeat arguments here. */
export function messageWireChars(message: Message): number {
  let total = message.content.length;
  for (const call of message.tool_calls ?? []) total += call.function.arguments.length;
  return total;
}

/**
 * Drop oldest material until `limit`. Never slice a message body: a chopped
 * file looks like the real file. Protected ids (the latest tool batch) and
 * the earliest real user message stay even when they alone exceed the limit.
 */
function fitCharLimit(
  messages: Message[],
  limit: number,
  protectIds: ReadonlySet<string>,
): Message[] {
  let out = messages.slice();
  const total = () => out.reduce((sum, message) => sum + messageWireChars(message), 0);
  if (total() <= limit) return out;

  const firstUserId = out.find(
    (message) => message.role === "user" && !message.content.startsWith("[summary"),
  )?.id;

  let removedRound = true;
  while (total() > limit && removedRound) {
    removedRound = false;
    const assistant = out.find(
      (message) =>
        message.role === "assistant" &&
        (message.tool_calls?.length ?? 0) > 0 &&
        !protectIds.has(message.id),
    );
    if (!assistant?.tool_calls?.length) break;
    const callIds = new Set(assistant.tool_calls.map((call) => call.id));
    const next = out.filter((message) => {
      if (message.id === assistant.id) return false;
      return !(message.role === "tool" && message.tool_call_id && callIds.has(message.tool_call_id));
    });
    if (next.length === out.length) break;
    out = next;
    removedRound = true;
  }

  while (total() > limit) {
    const index = out.findIndex((message) => message.id !== firstUserId && !protectIds.has(message.id));
    if (index < 0) break;
    out.splice(index, 1);
  }
  return out;
}

export function compressMessages(
  messages: Message[],
  opts: { contextCharLimit?: number; protectIds?: ReadonlySet<string> } = {},
): Message[] {
  if (opts.contextCharLimit == null) return messages.slice();
  return fitCharLimit(messages, opts.contextCharLimit, opts.protectIds ?? new Set());
}
