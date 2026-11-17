import { describe, it, expect } from "vitest";
import { compressMessages, countUserTurns } from "../src/context/compress.js";
import type { Message } from "../src/types.js";

function msg(turn: string, role: Message["role"], content: string, id = `${turn}_${role}`): Message {
  return {
    id,
    session_id: "sess",
    turn_id: turn,
    role,
    content,
    created_at: "2026-10-29T00:00:00.000Z",
  };
}

function makeTurns(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg(`turn_${i}`, "user", `u${i}`));
    out.push(msg(`turn_${i}`, "assistant", `a${i}`, `turn_${i}_assistant`));
  }
  return out;
}

describe("compressMessages", () => {
  it("countUserTurns counts distinct turns with user messages", () => {
    expect(countUserTurns(makeTurns(3))).toBe(3);
  });

  it("does not compress when user turns <= 10", () => {
    expect(compressMessages(makeTurns(10))).toHaveLength(20);
  });

  it("keeps every user turn when no character limit is set", () => {
    const out = compressMessages(makeTurns(15));
    expect(out).toHaveLength(30);
    expect(out.some((m) => m.content.startsWith("[summary"))).toBe(false);
    expect(out.map((m) => m.content)).toContain("u4");
    expect(out.map((m) => m.content)).toContain("u15");
  });

  it("drops whole messages instead of slicing them when over the character limit", () => {
    const input = makeTurns(15).map((m) => ({ ...m, content: m.content + "x".repeat(200) }));
    const out = compressMessages(input, { contextCharLimit: 2500 });
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(2500);
    const firstUser = out.find((m) => m.role === "user" && !m.content.startsWith("[summary"));
    expect(firstUser?.content.startsWith("u1")).toBe(true);
    expect(firstUser?.content.length).toBeGreaterThan(200);
    expect(out.some((m) => m.content.endsWith("…"))).toBe(false);
  });

  it("keeps a protected tool result intact when it alone exceeds the limit", () => {
    const user = msg("t", "user", "u", "user");
    const tool = msg("t", "tool", "R".repeat(2000), "tool");
    const out = compressMessages([user, tool], {
      contextCharLimit: 100,
      protectIds: new Set(["tool"]),
    });
    expect(out.find((m) => m.id === "tool")?.content).toHaveLength(2000);
    expect(out.find((m) => m.id === "user")?.content).toBe("u");
  });

  it("counts tool-call arguments and drops the oldest tool round as a pair", () => {
    const user = msg("t", "user", "u", "user");
    const oldAssistant: Message = {
      ...msg("t", "assistant", "old", "old_a"),
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    };
    const oldTool: Message = { ...msg("t", "tool", "R".repeat(100), "old_tool"), tool_call_id: "c1" };
    const keep: Message = {
      ...msg("t", "assistant", "keep", "keep_a"),
      tool_calls: [
        { id: "c2", type: "function", function: { name: "read_file", arguments: "x".repeat(500) } },
      ],
    };
    const out = compressMessages([user, oldAssistant, oldTool, keep], {
      contextCharLimit: "u".length + "keep".length + 500,
      protectIds: new Set(["keep_a"]),
    });
    expect(out.map((m) => m.id)).toEqual(["user", "keep_a"]);
    expect(out[1]?.tool_calls?.[0]?.function.arguments).toHaveLength(500);
  });

  it("does not slice the only user message when it exceeds the limit", () => {
    const user = msg("t", "user", "u".repeat(500), "user");
    const out = compressMessages([user], { contextCharLimit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toHaveLength(500);
  });
});
