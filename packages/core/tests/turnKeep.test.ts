import { describe, it, expect } from "vitest";
import { assembleContext, currentTurnKeepIds } from "../src/context/assemble.js";
import type { LlmChatRequest } from "../src/provider/types.js";
import type { Message, ToolCall } from "../src/types.js";

const created = "2026-11-18T00:00:00.000Z";

function user(id: string, turn: string, content: string): Message {
  return { id, session_id: "s", turn_id: turn, role: "user", content, created_at: created };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function assistant(id: string, turn: string, calls: ToolCall[]): Message {
  return { id, session_id: "s", turn_id: turn, role: "assistant", content: "", tool_calls: calls, created_at: created };
}

function result(id: string, turn: string, c: ToolCall, content: string): Message {
  return {
    id,
    session_id: "s",
    turn_id: turn,
    role: "tool",
    name: c.function.name,
    tool_call_id: c.id,
    tool_call_arguments: c.function.arguments,
    content,
    created_at: created,
  };
}

function toolContents(req: { messages: LlmChatRequest["messages"] }): string[] {
  return req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}

describe("current-turn tool results", () => {
  it("re-reading a file no longer loses the first read in the same turn", () => {
    // The loop from a real session: read A, read B, then the request that used to drop A.
    const big = "x".repeat(3000);
    const a = call("c1", "read_file", { path: "registry.ts" });
    const b = call("c2", "read_file", { path: "lib.ts" });
    const history: Message[] = [
      user("u1", "t1", "fix the verifier mapping"),
      assistant("a1", "t1", [a]),
      result("r1", "t1", a, big),
      assistant("a2", "t1", [b]),
    ];
    const current = result("r2", "t1", b, "small");
    const out = assembleContext({ systemPrompt: "S", history, currentUser: current, contextCharLimit: 100_000 });
    expect(toolContents(out)).toContain(big);
    expect(toolContents(out).join("\n")).not.toContain("此前 read_file 的结果已省略");
  });

  it("results from an earlier user turn are still shortened", () => {
    const big = "y".repeat(3000);
    const old = call("c0", "read_file", { path: "old.ts" });
    const now = call("c1", "read_file", { path: "now.ts" });
    const history: Message[] = [
      user("u0", "t0", "earlier question"),
      assistant("a0", "t0", [old]),
      result("r0", "t0", old, big),
      user("u1", "t1", "new question"),
      assistant("a1", "t1", [now]),
    ];
    const current = result("r1", "t1", now, "short");
    const out = assembleContext({ systemPrompt: "S", history, currentUser: current, contextCharLimit: 100_000 });
    const contents = toolContents(out);
    expect(contents).not.toContain(big);
    expect(contents.join("\n")).toContain("此前 read_file 的结果已省略（old.ts，3000 字）");
  });

  it("the current turn's results are capped at half of contextCharLimit; the oldest go first", () => {
    const first = call("c1", "read_file", { path: "first.ts" });
    const second = call("c2", "read_file", { path: "second.ts" });
    const history: Message[] = [
      user("u1", "t1", "go"),
      assistant("a1", "t1", [first]),
      result("r1", "t1", first, "f".repeat(3000)),
      assistant("a2", "t1", [second]),
    ];
    const current = result("r2", "t1", second, "s".repeat(3000));
    // Half of 10_000 is 5_000: the newer 3_000 fits, adding the older one would pass it.
    const out = assembleContext({ systemPrompt: "S", history, currentUser: current, contextCharLimit: 10_000 });
    const contents = toolContents(out);
    expect(contents.join("\n")).toContain("此前 read_file 的结果已省略（first.ts，3000 字）");
    expect(contents).toContain("s".repeat(3000));
  });

  it("the latest batch stays in full even when it alone is over the turn budget", () => {
    const left = call("c1", "read_file", { path: "left.ts" });
    const right = call("c2", "read_file", { path: "right.ts" });
    const history: Message[] = [
      user("u1", "t1", "go"),
      assistant("a1", "t1", [left, right]),
      result("r1", "t1", left, "L".repeat(4000)),
    ];
    const current = result("r2", "t1", right, "R".repeat(4000));
    // Budget is 0.5 * 2_000 = 1_000 chars, far below one result. The model still needs both.
    const out = assembleContext({ systemPrompt: "S", history, currentUser: current, contextCharLimit: 2_000 });
    expect(toolContents(out)).toContain("L".repeat(4000));
    expect(toolContents(out)).toContain("R".repeat(4000));
  });

  it("currentTurnKeepIds returns only tool calls of the last user turn", () => {
    const c1 = call("c1", "read_file", { path: "a" });
    const c0 = call("c0", "read_file", { path: "b" });
    const messages: Message[] = [
      user("u0", "t0", "old"),
      assistant("a0", "t0", [c0]),
      result("r0", "t0", c0, "old result"),
      user("u1", "t1", "new"),
      assistant("a1", "t1", [c1]),
      result("r1", "t1", c1, "new result"),
    ];
    expect([...currentTurnKeepIds(messages, 10_000)]).toEqual(["c1"]);
  });
});
