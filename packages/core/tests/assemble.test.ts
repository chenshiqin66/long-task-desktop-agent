import { describe, it, expect } from "vitest";
import { assembleContext } from "../src/context/assemble.js";
import type { Message, ToolCall } from "../src/types.js";

describe("assembleContext", () => {
  it("orders system, history, current user", () => {
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
      history,
      currentUser: current,
      contextCharLimit: 100_000,
    });
    expect(assembled.messages[0].role).toBe("system");
    expect(assembled.messages[0].content).toBe("You are a coding agent.");
    expect(assembled.messages[0].content).not.toContain("# Tools");
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
      history: [assistant],
      currentUser: tool,
      contextCharLimit: 100_000,
    });
    const sent = assembled.messages.find((m) => m.role === "assistant");
    const note = JSON.parse(sent?.tool_calls?.[0]?.function.arguments ?? "{}").note as string;
    expect(note).toContain("long-horizon-agent-architecture.html");
    expect(note).toContain(`共 ${html.length} 字`);
    expect(note).toContain("这是系统说明，不是你发出的参数");
    // The stub must not look like a parameter object any more.
    expect(Object.keys(JSON.parse(sent?.tool_calls?.[0]?.function.arguments ?? "{}"))).toEqual(["note"]);
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
      history: [assistant],
      currentUser: failed,
      contextCharLimit: 100_000,
    }).messages.find((m) => m.role === "assistant");
    expect(sentFailed?.tool_calls?.[0]?.function.arguments).toBe(args);

    const sentOpen = assembleContext({
      systemPrompt: "sys",
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
    const note = JSON.parse(sent?.tool_calls?.[0]?.function.arguments ?? "{}").note as string;
    expect(note).toContain("str_replace 修改 note.html");
    expect(note).toContain("旧文本 400 字，新文本 400 字");
    expect(note).toContain("不要照这个格式调用工具");
  });

  it("keeps same-turn results in full while they fit the turn budget, and the latest batch in full", () => {
    const oldBody = "A".repeat(800);
    const left = "L".repeat(800);
    const right = "R".repeat(800);
    const oldTool = toolMessage({
      id: "old_tool",
      callId: "call_old",
      name: "read_file",
      content: oldBody,
      arguments: { path: "src/old.ts" },
    });
    const leftTool = toolMessage({
      id: "left_tool",
      callId: "call_left",
      name: "read_file",
      content: left,
      arguments: { path: "src/left.ts" },
    });
    const rightTool = toolMessage({
      id: "right_tool",
      callId: "call_right",
      name: "list_dir",
      content: right,
      arguments: { path: "src" },
    });
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t", "read the files"),
        assistantCall("a1", "t", "call_old", "read_file", { path: "src/old.ts" }),
        oldTool,
        assistantCalls("a2", "t", [
          ["call_left", "read_file", { path: "src/left.ts" }],
          ["call_right", "list_dir", { path: "src" }],
        ]),
        leftTool,
      ],
      currentUser: rightTool,
      contextCharLimit: 100_000,
    });
    const sentOld = assembled.messages.find((m) => m.tool_call_id === "call_old");
    const sentLeft = assembled.messages.find((m) => m.tool_call_id === "call_left");
    const sentRight = assembled.messages.find((m) => m.tool_call_id === "call_right");
    // Same turn, 2400 chars in total, far under the 50_000 turn budget: nothing is stubbed.
    expect(sentOld?.content).toBe(oldBody);
    expect(sentLeft?.content).toBe(left);
    expect(sentRight?.content).toBe(right);
    expect(oldTool.content).toBe(oldBody);
  });

  it("keeps the latest batch intact when the history budget is smaller than that batch", () => {
    const left = "L".repeat(2000);
    const right = "R".repeat(2000);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t", "go"),
        assistantCalls("a", "t", [
          ["call_left", "read_file", { path: "left.ts" }],
          ["call_right", "read_file", { path: "right.ts" }],
        ]),
        toolMessage({
          id: "left",
          callId: "call_left",
          name: "read_file",
          content: left,
          arguments: { path: "left.ts" },
        }),
      ],
      currentUser: toolMessage({
        id: "right",
        callId: "call_right",
        name: "read_file",
        content: right,
        arguments: { path: "right.ts" },
      }),
      contextCharLimit: 500,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_left")?.content).toBe(left);
    expect(assembled.messages.find((m) => m.tool_call_id === "call_right")?.content).toBe(right);
  });

  it("stubs a large read from an earlier user turn", () => {
    const body = "Q".repeat(600);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u0", "t0", "earlier"),
        assistantCall("a", "t0", "call_read", "keyword_search", { path: "src", queries: ["budget"] }),
        toolMessage({
          id: "read",
          callId: "call_read",
          name: "keyword_search",
          content: body,
          arguments: { path: "src", queries: ["budget"] },
        }),
      ],
      currentUser: userMessage("u1", "t1", "continue"),
      contextCharLimit: 100_000,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_read")?.content).toBe(
      "此前 keyword_search 的结果已省略（src，600 字）。原文仍在磁盘上，需要时再搜索。",
    );
  });

  it("keeps an earlier read_skill in the same turn while it fits the turn budget", () => {
    const body = "K".repeat(600);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t", "use the skill"),
        assistantCall("a1", "t", "call_skill", "read_skill", { name: "demo" }),
        toolMessage({
          id: "skill",
          callId: "call_skill",
          name: "read_skill",
          content: body,
          arguments: { name: "demo" },
        }),
        assistantCall("a2", "t", "call_read", "read_file", { path: "now.ts" }),
      ],
      currentUser: toolMessage({
        id: "read",
        callId: "call_read",
        name: "read_file",
        content: "fresh",
        arguments: { path: "now.ts" },
      }),
      contextCharLimit: 100_000,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_skill")?.content).toBe(body);
    expect(assembled.messages.find((m) => m.tool_call_id === "call_read")?.content).toBe("fresh");
  });

  it("leaves a short tool result and ask_user, task, and subagent results alone", () => {
    const short = "S".repeat(500);
    const long = "T".repeat(700);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t0", "work"),
        assistantCalls("a", "t0", [
          ["call_short", "read_file", { path: "short.ts" }],
          ["call_ask", "ask_user", { question: "which?" }],
          ["call_task", "task_get", { id: "1" }],
          ["call_sub", "subagent", { task: "look" }],
        ]),
        toolMessage({ id: "s", callId: "call_short", name: "read_file", content: short, arguments: { path: "short.ts" } }),
        toolMessage({ id: "ask", callId: "call_ask", name: "ask_user", content: long, arguments: { question: "which?" } }),
        toolMessage({ id: "task", callId: "call_task", name: "task_get", content: long, arguments: { id: "1" } }),
        toolMessage({ id: "sub", callId: "call_sub", name: "subagent", content: long, arguments: { task: "look" } }),
      ],
      currentUser: userMessage("u2", "t1", "next"),
      contextCharLimit: 100_000,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_short")?.content).toBe(short);
    expect(assembled.messages.find((m) => m.tool_call_id === "call_ask")?.content).toBe(long);
    expect(assembled.messages.find((m) => m.tool_call_id === "call_task")?.content).toBe(long);
    expect(assembled.messages.find((m) => m.tool_call_id === "call_sub")?.content).toBe(long);
  });

  it("stubs shell, web search, and MCP results without inviting a rerun for old output", () => {
    const body = "O".repeat(900);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t0", "inspect"),
        assistantCalls("a", "t0", [
          ["call_sh", "powershell", { command: "Get-ChildItem" }],
          ["call_web", "web_search", { query: "context budget" }],
          ["call_mcp", "mcp__notes__search", { q: "budget" }],
        ]),
        toolMessage({
          id: "sh",
          callId: "call_sh",
          name: "powershell",
          content: body,
          arguments: { command: "Get-ChildItem" },
        }),
        toolMessage({
          id: "web",
          callId: "call_web",
          name: "web_search",
          content: body,
          arguments: { query: "context budget" },
        }),
        toolMessage({
          id: "mcp",
          callId: "call_mcp",
          name: "mcp__notes__search",
          content: body,
          arguments: { q: "budget" },
        }),
      ],
      currentUser: userMessage("u2", "t1", "next"),
      contextCharLimit: 100_000,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_sh")?.content).toBe(
      "此前 powershell 的结果已省略（Get-ChildItem，900 字）。不要为了看旧输出而重跑。",
    );
    expect(assembled.messages.find((m) => m.tool_call_id === "call_web")?.content).toBe(
      "此前 web_search 的结果已省略（context budget，900 字）。需要时再搜索。",
    );
    expect(assembled.messages.find((m) => m.tool_call_id === "call_mcp")?.content).toBe(
      "此前 mcp__notes__search 的结果已省略（900 字）。需要时再调用。",
    );
  });

  it("says a stubbed read was overwritten when a later write to that path succeeded", () => {
    const body = "F".repeat(700);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t", "edit"),
        assistantCall("a1", "t", "call_read", "read_file", { path: "note.html" }),
        toolMessage({
          id: "read",
          callId: "call_read",
          name: "read_file",
          content: body,
          arguments: { path: "note.html" },
        }),
        assistantCall("a2", "t", "call_write", "write_file", { path: "note.html", content: "new" }),
        toolMessage({
          id: "wrote",
          callId: "call_write",
          name: "write_file",
          content: "Wrote 3 chars to note.html",
          arguments: { path: "note.html", content: "new" },
          is_error: false,
        }),
      ],
      currentUser: userMessage("u2", "t2", "go on"),
      contextCharLimit: 100_000,
    });
    expect(assembled.messages.find((m) => m.tool_call_id === "call_read")?.content).toBe(
      "此前 read_file 的结果已省略（note.html，700 字）。该路径之后被改过，要新内容再读。",
    );
  });

  it("keeps a failed write on the next request and stubs it after the model has replied", () => {
    const args = JSON.stringify({ path: "a.html", content: "y".repeat(800) });
    const assistant: Message = {
      id: "a",
      session_id: "s",
      turn_id: "t",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_write", type: "function", function: { name: "write_file", arguments: args } }],
      created_at: "2026-10-30T00:00:00.000Z",
    };
    const failed: Message = {
      id: "tool",
      session_id: "s",
      turn_id: "t",
      role: "tool",
      name: "write_file",
      tool_call_id: "call_write",
      content: "Missing parent directory",
      is_error: true,
      created_at: "2026-10-30T00:00:01.000Z",
    };
    const kept = assembleContext({
      systemPrompt: "sys",
      history: [assistant, failed],
      currentUser: userMessage("u", "t2", "continue"),
      contextCharLimit: 100_000,
    }).messages.find((m) => m.role === "assistant");
    expect(kept?.tool_calls?.[0]?.function.arguments).toBe(args);

    const stubbed = assembleContext({
      systemPrompt: "sys",
      history: [
        assistant,
        failed,
        {
          id: "a2",
          session_id: "s",
          turn_id: "t2",
          role: "assistant",
          content: "I will write it another way.",
          created_at: "2026-10-30T00:00:03.000Z",
        },
      ],
      currentUser: userMessage("u2", "t3", "and now?"),
      contextCharLimit: 100_000,
    }).messages.find((m) => m.tool_calls?.[0]?.id === "call_write");
    const note = JSON.parse(stubbed?.tool_calls?.[0]?.function.arguments ?? "{}").note as string;
    expect(note).toContain("write_file 写入 a.html 的内容，共 800 字");
    expect(note).toContain("这次调用失败，没有写入成功。");
  });

  it("counts the last message's tool arguments against the history budget", () => {
    const prose = "P".repeat(2000);
    const assembled = assembleContext({
      systemPrompt: "sys",
      history: [
        userMessage("u", "t", prose),
        {
          id: "a",
          session_id: "s",
          turn_id: "t",
          role: "assistant",
          content: "ok",
          created_at: "2026-10-30T00:00:01.000Z",
        },
      ],
      currentUser: {
        id: "tail",
        session_id: "s",
        turn_id: "t",
        role: "assistant",
        content: "now",
        tool_calls: [
          { id: "call_big", type: "function", function: { name: "write_file", arguments: "z".repeat(3000) } },
        ],
        created_at: "2026-10-30T00:00:02.000Z",
      },
      contextCharLimit: 4500,
    });
    expect(assembled.messages.some((m) => m.content === "ok")).toBe(false);
    expect(assembled.messages.some((m) => m.content === prose)).toBe(true);
  });
});

function userMessage(id: string, turn: string, content: string): Message {
  return {
    id,
    session_id: "s",
    turn_id: turn,
    role: "user",
    content,
    created_at: "2026-11-17T00:00:00.000Z",
  };
}

function assistantCall(
  id: string,
  turn: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Message {
  return assistantCalls(id, turn, [[callId, name, args]]);
}

function assistantCalls(
  id: string,
  turn: string,
  calls: Array<[string, string, Record<string, unknown>]>,
): Message {
  return {
    id,
    session_id: "s",
    turn_id: turn,
    role: "assistant",
    content: "",
    tool_calls: calls.map(([callId, name, args]) => ({
      id: callId,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    })),
    created_at: "2026-11-17T00:00:01.000Z",
  };
}

function toolMessage(opts: {
  id: string;
  callId: string;
  name: string;
  content: string;
  arguments: Record<string, unknown>;
  is_error?: boolean;
}): Message {
  return {
    id: opts.id,
    session_id: "s",
    turn_id: "t",
    role: "tool",
    name: opts.name,
    tool_call_id: opts.callId,
    tool_call_arguments: JSON.stringify(opts.arguments),
    content: opts.content,
    ...(opts.is_error === undefined ? {} : { is_error: opts.is_error }),
    created_at: "2026-11-17T00:00:02.000Z",
  };
}
