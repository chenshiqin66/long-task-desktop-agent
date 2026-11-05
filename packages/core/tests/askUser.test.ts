import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { DeferredAskGate } from "../src/runtime/askGate.js";
import { parseAskUserArgs } from "../src/tools/askUserTool.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
  };
}

function askCall(id: string, args: Record<string, unknown>): LlmStreamChunk {
  return {
    type: "tool_call_delta",
    tool_call: {
      id,
      type: "function",
      function: { name: "ask_user", arguments: JSON.stringify(args) },
    },
  };
}

describe("ask_user", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ask-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("parseAskUserArgs keeps one question and a few options", () => {
    const parsed = parseAskUserArgs({
      question: "  用哪一种？ ",
      options: ["PDF", "", "HTML", "Markdown"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.call.question).toBe("用哪一种？");
    expect(parsed.call.options).toEqual(["PDF", "HTML", "Markdown"]);
    expect(parseAskUserArgs({ question: "  " }).ok).toBe(false);
  });

  it("waits in the same turn and feeds the answer back to the model", async () => {
    const gate = new DeferredAskGate();
    let calls = 0;
    let sawAnswer = false;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            yield askCall("call_ask", {
              question: "对外分享用 PDF 还是 HTML？",
              options: ["PDF", "HTML"],
            });
          })();
        }
        const tool = req.messages.find((m) => m.role === "tool");
        sawAnswer = tool?.content === "PDF";
        return (async function* () {
          yield { type: "text" as const, text: "按 PDF 继续" };
        })();
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, asks: gate });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => {
      events.push(e);
      if (e.type === "ask_user") {
        queueMicrotask(() => gate.answer(e.request_id, "PDF"));
      }
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "做一份对外文档");

    expect(events.some((e) => e.type === "permission_request")).toBe(false);
    expect(events.some((e) => e.type === "ask_user" && e.question.includes("PDF"))).toBe(true);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    expect(sawAnswer).toBe(true);
    expect(calls).toBe(2);
    const msgs = await rt.loadMessages(meta.session_id);
    const answer = msgs.find((m) => m.role === "tool" && m.name === "ask_user");
    expect(answer?.content).toBe("PDF");
    expect(answer?.is_error).toBe(false);
  });

  it("does not run later tools after an answer, then continues the turn", async () => {
    const gate = new DeferredAskGate();
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            yield askCall("call_ask", { question: "继续吗？" });
            yield {
              type: "tool_call_delta" as const,
              tool_call: {
                id: "call_shell",
                type: "function" as const,
                function: {
                  name: "powershell",
                  arguments: JSON.stringify({ command: "Write-Output SHOULD_NOT_RUN" }),
                },
              },
            };
          })();
        }
        const skipped = req.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_shell");
        expect(skipped?.content).toMatch(/Skipped/);
        return (async function* () {
          yield { type: "text" as const, text: "停在回答之后" };
        })();
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, asks: gate });
    rt.onEvent((e) => {
      if (e.type === "ask_user") queueMicrotask(() => gate.answer(e.request_id, "先别做"));
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "做");
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool" && m.content.includes("SHOULD_NOT_RUN"))).toBe(false);
    expect(msgs.some((m) => m.content.includes("停在回答之后"))).toBe(true);
    expect(calls).toBe(2);
  });

  it("missing question is an error and does not wait", async () => {
    const gate = new DeferredAskGate();
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            yield askCall("call_ask", { options: ["A"] });
          })();
        }
        return (async function* () {
          yield { type: "text" as const, text: "done" };
        })();
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, asks: gate });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "问");
    expect(events.some((e) => e.type === "ask_user")).toBe(false);
    expect(gate.pendingCount).toBe(0);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool" && m.is_error && /question/i.test(m.content))).toBe(
      true,
    );
  });

  it("cancel while waiting does not execute the question's siblings", async () => {
    const gate = new DeferredAskGate();
    const provider: LlmProvider = {
      chatStream() {
        return (async function* () {
          yield askCall("call_ask", { question: "继续吗？" });
          yield {
            type: "tool_call_delta" as const,
            tool_call: {
              id: "call_shell",
              type: "function" as const,
              function: {
                name: "powershell",
                arguments: JSON.stringify({ command: "Write-Output NO" }),
              },
            },
          };
        })();
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, asks: gate });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const pending = rt.submit(meta.session_id, "做");
    const started = Date.now();
    while (!events.some((e) => e.type === "ask_user") && Date.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    rt.cancel();
    await pending;
    expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.content.includes("Write-Output NO") && !m.content.includes("Skipped") && !m.content.includes("Cancelled"))).toBe(false);
  });
});
