import { describe, it, expect } from "vitest";
import { assembleContext } from "../src/context/assemble.js";
import type { Message, ToolCall } from "../src/types.js";
import type { ToolDefinition } from "../src/tools/types.js";

const tools: ToolDefinition[] = [
  { name: "bash", description: "run", parameters: { type: "object", properties: {} } },
];

describe("assembleContext", () => {
  it("orders system (with tools), history, current user", () => {
    const history: Message[] = [
      {
        id: "1",
        session_id: "s",
        turn_id: "t0",
        role: "user",
        content: "old",
        created_at: "2026-10-29T00:00:00.000Z",
      },
      {
        id: "2",
        session_id: "s",
        turn_id: "t0",
        role: "assistant",
        content: "reply",
        created_at: "2026-10-29T00:00:01.000Z",
      },
    ];
    const current: Message = {
      id: "3",
      session_id: "s",
      turn_id: "t1",
      role: "user",
      content: "now",
      created_at: "2026-10-29T00:00:02.000Z",
    };
    const assembled = assembleContext({
      systemPrompt: "You are a coding agent.",
      toolDefinitions: tools,
      history,
      currentUser: current,
      contextCharLimit: 100_000,
    });
    expect(assembled.messages[0].role).toBe("system");
    expect(assembled.messages[0].content).toContain("You are a coding agent.");
    expect(assembled.messages[0].content).toContain("bash");
    expect(assembled.messages.at(-1)?.content).toBe("now");
    expect(assembled.messages.some((m) => m.content === "old")).toBe(true);
  });

  it("replaces settled write arguments with path and sizes on the outbound copy", () => {
    const html = "<html>" + "x".repeat(600) + "</html>";
    const args = JSON.stringify({
      path: "long-horizon-agent-architecture.html",
      content: html,
    });
    const call: ToolCall = {
      id: "call_write",
      type: "function",
      function: { name: "write_file", arguments: args },
    };
    const assistant: Message = {
      id: "a",
      session_id: "s",
      turn_id: "t",
      role: "assistant",
      content: "先搭骨架。",
      tool_calls: [call],
      created_at: "2026-10-30T00:00:00.000Z",
    };
    const tool: Message = {
      id: "tool",
      session_id: "s",
      turn_id: "t",
      role: "tool",
      name: "write_file",
      tool_call_id: "call_write",
      content: `Wrote ${html.length} chars to long-horizon-agent-architecture.html`,
      is_error: false,
      created_at: "2026-10-30T00:00:01.000Z",
    };
    const assembled = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: tools,
      history: [assistant],
      currentUser: tool,
      contextCharLimit: 100_000,
    });
    const sent = assembled.messages.find((m) => m.role === "assistant");
    expect(JSON.parse(sent?.tool_calls?.[0]?.function.arguments ?? "")).toEqual({
      path: "long-horizon-agent-architecture.html",
      content_chars: html.length,
      omitted: true,
    });
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe(args);
  });

  it("keeps failed or unfinished write arguments", () => {
    const args = JSON.stringify({ path: "a.html", content: "y".repeat(800) });
    const call: ToolCall = {
      id: "call_write",
      type: "function",
      function: { name: "write_file", arguments: args },
    };
    const assistant: Message = {
      id: "a",
      session_id: "s",
      turn_id: "t",
      role: "assistant",
      content: "",
      tool_calls: [call],
      created_at: "2026-10-30T00:00:00.000Z",
    };
    const failed: Message = {
      id: "tool",
      session_id: "s",
      turn_id: "t",
      role: "tool",
      name: "write_file",
      tool_call_id: "call_write",
      content: "Missing path",
      is_error: true,
      created_at: "2026-10-30T00:00:01.000Z",
    };
    const sentFailed = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: [],
      history: [assistant],
      currentUser: failed,
      contextCharLimit: 100_000,
    }).messages.find((m) => m.role === "assistant");
    expect(sentFailed?.tool_calls?.[0]?.function.arguments).toBe(args);

    const sentOpen = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: [],
      history: [assistant],
      currentUser: {
        id: "u",
        session_id: "s",
        turn_id: "t2",
        role: "user",
        content: "continue",
        created_at: "2026-10-30T00:00:02.000Z",
      },
      contextCharLimit: 100_000,
    }).messages.find((m) => m.role === "assistant");
    expect(sentOpen?.tool_calls?.[0]?.function.arguments).toBe(args);
  });

  it("elides a legacy successful str_replace that has no is_error flag", () => {
    const oldString = "z".repeat(400);
    const newString = "q".repeat(400);
    const args = JSON.stringify({ path: "note.html", old_string: oldString, new_string: newString });
    const assistant: Message = {
      id: "a",
      session_id: "s",
      turn_id: "t",
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_edit", type: "function", function: { name: "str_replace", arguments: args } },
      ],
      created_at: "2026-10-30T00:00:00.000Z",
    };
    const assembled = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: [],
      history: [
        assistant,
        {
          id: "tool",
          session_id: "s",
          turn_id: "t",
          role: "tool",
          name: "str_replace",
          tool_call_id: "call_edit",
          content: "Updated note.html (1 replacement)",
          created_at: "2026-10-30T00:00:01.000Z",
        },
      ],
      currentUser: {
        id: "u",
        session_id: "s",
        turn_id: "t2",
        role: "user",
        content: "next",
        created_at: "2026-10-30T00:00:02.000Z",
      },
      contextCharLimit: 100_000,
    });
    const sent = assembled.messages.find((m) => m.role === "assistant");
    expect(JSON.parse(sent?.tool_calls?.[0]?.function.arguments ?? "")).toEqual({
      path: "note.html",
      old_chars: 400,
      new_chars: 400,
      omitted: true,
    });
  });
});
