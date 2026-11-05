import { newId, nowIso } from "../ids.js";
import type { Message } from "../types.js";

export function groupTurns(messages: Message[]): Message[][] {
  const order: string[] = [];
  const map = new Map<string, Message[]>();
  for (const m of messages) {
    if (!map.has(m.turn_id)) {
      map.set(m.turn_id, []);
      order.push(m.turn_id);
    }
    map.get(m.turn_id)!.push(m);
  }
  return order.map((id) => map.get(id)!);
}

export function countUserTurns(messages: Message[]): number {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "user") ids.add(m.turn_id);
  }
  return ids.size;
}

function makeSummary(sessionId: string, parts: string[]): Message {
  return {
    id: newId("msg"),
    session_id: sessionId,
    turn_id: newId("turn"),
    role: "user",
    content: `[summary of omitted turns]\n${parts.join("\n")}`.slice(0, 4000),
    created_at: nowIso(),
  };
}

function truncateTo(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  if (maxLen <= 1) return content.slice(0, maxLen);
  return content.slice(0, maxLen - 1) + "…";
}

function enforceCharLimit(messages: Message[], limit: number): Message[] {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= limit) return messages;
  const out = messages.map((m) => ({ ...m }));

  const shrinkPass = (predicate: (m: Message) => boolean, minLen: number) => {
    for (const m of out) {
      if (total <= limit) break;
      if (!predicate(m)) continue;
      if (m.content.length <= minLen) continue;
      const overflow = total - limit;
      const target = Math.max(minLen, m.content.length - overflow);
      const next = truncateTo(m.content, target);
      total -= m.content.length - next.length;
      m.content = next;
    }
  };

  // Shrink summaries first, then oldest remaining contents.
  shrinkPass((m) => m.content.startsWith("[summary"), 32);
  shrinkPass((m) => !m.content.startsWith("[summary"), 32);
  // Hard clamp anything still oversized (tiny messages).
  shrinkPass(() => true, 1);

  return out;
}

export function compressMessages(
  messages: Message[],
  opts: { contextCharLimit?: number } = {},
): Message[] {
  const turns = groupTurns(messages);
  const userTurnIndexes = turns
    .map((t, i) => (t.some((m) => m.role === "user") ? i : -1))
    .filter((i) => i >= 0);

  let flat: Message[];

  if (userTurnIndexes.length <= 10) {
    flat = messages.slice();
  } else {
    const keep = new Set<number>([
      ...userTurnIndexes.slice(0, 3),
      ...userTurnIndexes.slice(-10),
    ]);
    const middle = userTurnIndexes.filter((i) => !keep.has(i));
    if (middle.length === 0) {
      flat = messages.slice();
    } else {
      const sessionId = messages[0]?.session_id ?? "sess";
      const minMid = Math.min(...middle);
      const maxMid = Math.max(...middle);
      const result: Message[] = [];
      let bucket: string[] = [];
      const flush = () => {
        if (bucket.length) {
          result.push(makeSummary(sessionId, bucket));
          bucket = [];
        }
      };
      for (let i = 0; i < turns.length; i++) {
        if (i >= minMid && i <= maxMid && !keep.has(i)) {
          for (const m of turns[i]) {
            bucket.push(`${m.role}: ${m.content.slice(0, 200)}`);
          }
        } else {
          flush();
          result.push(...turns[i]);
        }
      }
      flush();
      flat = result;
    }
  }

  if (opts.contextCharLimit != null) {
    flat = enforceCharLimit(flat, opts.contextCharLimit);
  }
  return flat;
}
