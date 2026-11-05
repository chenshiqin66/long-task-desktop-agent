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

  it("keeps first 3 and last 10 turns when user turns > 10", () => {
    const out = compressMessages(makeTurns(15));
    expect(out.some((m) => m.content.startsWith("[summary"))).toBe(true);
    const userContents = out
      .filter((m) => m.role === "user" && !m.content.startsWith("[summary"))
      .map((m) => m.content);
    expect(userContents).toContain("u1");
    expect(userContents).toContain("u3");
    expect(userContents).toContain("u6");
    expect(userContents).toContain("u15");
    expect(userContents).not.toContain("u4");
    expect(userContents).not.toContain("u5");
  });

  it("when first3 and last10 overlap, keeps all without summary", () => {
    const out = compressMessages(makeTurns(12));
    expect(out.some((m) => m.content.startsWith("[summary"))).toBe(false);
    expect(out).toHaveLength(24);
  });

  it("applies character limit", () => {
    const input = makeTurns(15).map((m) => ({ ...m, content: m.content + "x".repeat(200) }));
    const out = compressMessages(input, { contextCharLimit: 2500 });
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(2500);
  });
});
