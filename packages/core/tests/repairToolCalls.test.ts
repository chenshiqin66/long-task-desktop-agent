import { describe, it, expect } from "vitest";
import {
  SYNTHETIC_INTERRUPTED_TOOL,
  canAppendToolRepair,
  findMissingToolResults,
  repairToolCallPairs,
} from "../src/context/repairToolCalls.js";
import { assembleContext } from "../src/context/assemble.js";
import type { Message, ToolCall } from "../src/types.js";

function msg(
  partial: Partial<Message> & Pick<Message, "id" | "role" | "content">,
): Message {
  return {
    session_id: "sess",
    turn_id: "turn_1",
    created_at: "2026-10-29T00:00:00.000Z",
    ...partial,
  };
}

function tc(id: string, name = "bash"): ToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

describe("repairToolCallPairs", () => {
  it("finds orphans when tool results are missing", () => {
    const messages = [
      msg({ id: "u", role: "user", content: "hi" }),
      msg({
        id: "a",
        role: "assistant",
        content: "",
        tool_calls: [tc("call_1"), tc("call_2")],
      }),
    ];
    const missing = findMissingToolResults(messages);
    expect(missing.map((m) => m.tool_call_id).sort()).toEqual(["call_1", "call_2"]);
    expect(canAppendToolRepair(messages)).toBe(true);
  });

  it("inserts synthetic tools before the following user message", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "hi", turn_id: "t1" }),
      msg({
        id: "a",
        role: "assistant",
        content: "",
        turn_id: "t1",
        tool_calls: [tc("call_1", "write_file")],
      }),
      msg({ id: "u2", role: "user", content: "continue", turn_id: "t2" }),
    ];
    expect(canAppendToolRepair(messages)).toBe(false);
    const repaired = repairToolCallPairs(messages, (info) =>
      msg({
        id: `syn_${info.tool_call_id}`,
        role: "tool",
        name: info.name,
        tool_call_id: info.tool_call_id,
        content: SYNTHETIC_INTERRUPTED_TOOL,
        session_id: info.session_id,
        turn_id: info.turn_id,
      }),
    );
    expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(repaired[2]?.tool_call_id).toBe("call_1");
    expect(findMissingToolResults(repaired)).toEqual([]);
  });

  it("assembleContext repairs orphans so provider payload is valid", () => {
    const history = [
      msg({ id: "u1", role: "user", content: "hi", turn_id: "t1" }),
      msg({
        id: "a",
        role: "assistant",
        content: "",
        turn_id: "t1",
        tool_calls: [tc("call_x")],
      }),
    ];
    const currentUser = msg({
      id: "u2",
      role: "user",
      content: "try again",
      turn_id: "t2",
    });
    const { messages } = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: [],
      history,
      currentUser,
      contextCharLimit: 50_000,
    });
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
    const assistantIdx = messages.findIndex((m) => m.role === "assistant");
    expect(messages[assistantIdx + 1]?.role).toBe("tool");
    expect(messages[assistantIdx + 1]?.tool_call_id).toBe("call_x");
  });
});
