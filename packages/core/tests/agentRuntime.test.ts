import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime, buildDefaultSystemPrompt } from "../src/runtime/agentRuntime.js";
import { SHELL_TOOL_NAME } from "../src/tools/host.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { Message, RuntimeEvent, AgentConfig } from "../types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { TraceStore } from "../src/store/traceStore.js";
import type { TraceEvent } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
    ...over,
  };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
  yield { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

async function* oneTool(step: number): AsyncIterable<LlmStreamChunk> {
  yield {
    type: "tool_call_delta",
    tool_call: {
      id: `call_${step}`,
      type: "function",
      function: { name: SHELL_TOOL_NAME, arguments: JSON.stringify({ command: "echo hi" }) },
    },
  };
}

/** Every assistant tool_calls id has a following tool message with matching tool_call_id. */
function assertNoOrphanedToolCalls(msgs: Message[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = new Set(m.tool_calls.map((tc) => tc.id));
    for (let j = i + 1; j < msgs.length && ids.size > 0; j++) {
      const n = msgs[j]!;
      if (n.role === "tool" && n.tool_call_id && ids.has(n.tool_call_id)) {
        ids.delete(n.tool_call_id);
      } else if (n.role === "assistant" || n.role === "user") {
        break;
      }
    }
    expect(ids.size, `orphaned tool_calls after assistant ${m.id}: ${[...ids].join(",")}`).toBe(
      0,
    );
  }
}


class FlakyTraceStore extends TraceStore {
  constructor(
    workspacePath: string,
    private readonly failWhen: (event: Omit<TraceEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }) => boolean,
  ) {
    super(workspacePath);
  }

  override async append(
    event: Omit<TraceEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
  ): Promise<TraceEvent> {
    if (this.failWhen(event)) throw new Error("ENOSPC: simulated trace full");
    return super.append(event);
  }
}

class FlakySessionStore extends SessionStore {
  constructor(
    workspacePath: string,
    private readonly failWhen: (msg: Message) => boolean,
  ) {
    super(workspacePath);
  }

  override async appendMessage(msg: Message): Promise<void> {
    if (this.failWhen(msg)) throw new Error("ENOSPC: simulated disk full");
    return super.appendMessage(msg);
  }
}

describe("AgentRuntime", () => {
  it("tells a Windows agent that the shell is PowerShell and the workspace is a Windows path", () => {
    if (process.platform !== "win32") return;
    const prompt = buildDefaultSystemPrompt("C:\\work\\demo");
    expect(prompt).toContain("C:\\work\\demo");
    expect(prompt).toContain("powershell.exe");
    expect(prompt).toMatch(/Windows/);
    expect(prompt).toContain("Do not launch bash.exe");
  });

  it("tells the parent to delegate a specific task, not an open-ended investigation", () => {
    const prompt = buildDefaultSystemPrompt("/tmp/demo");
    expect(prompt).toContain("does not see this conversation");
    expect(prompt).toContain("without guessing");
    expect(prompt).toContain("what finished looks like");
    expect(prompt).toContain("From what you find, fix the bug");
    expect(prompt).toContain("Choosing the type is the tool limit");
    expect(prompt).toContain("8 tool rounds");
    expect(prompt).toContain("16 tool rounds");
    expect(prompt).toContain("keyword_search takes a path and every term");
    expect(prompt).toContain("Run any verification command yourself");
  });

  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("submit streams text, persists messages, emits done", async () => {
    const provider: LlmProvider = { chatStream: () => textOnly("hello") };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession("t");
    await rt.submit(meta.session_id, "hi");
    expect(events.some((e) => e.type === "text" && e.delta === "hello")).toBe(true);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "hello")).toBe(true);
  });

  it(
    "stops at maxSteps and emits done reason max_steps",
    async () => {
      let llmCalls = 0;
      const provider: LlmProvider = {
        chatStream(_req: LlmChatRequest) {
          llmCalls += 1;
          return oneTool(llmCalls);
        },
      };
      const rt = new AgentRuntime({
        workspacePath: workspace,
        config: config({ maxSteps: 3 }),
        provider,
      });
      const events: RuntimeEvent[] = [];
      rt.onEvent((e) => events.push(e));
      const meta = await rt.createSession();
      await rt.submit(meta.session_id, "loop");
      const done = events.find((e) => e.type === "done");
      expect(done).toMatchObject({ type: "done", reason: "max_steps" });
      const notice = events
        .filter((e) => e.type === "text")
        .map((e) => (e.type === "text" ? e.delta : ""))
        .join("");
      expect(notice).toMatch(/max tool steps \(3\)/i);

      // 3 steps executed for real; 4th LLM round hits cap (synthetic errors, not ToolHost)
      const realResults = events.filter(
        (e) => e.type === "tool_result" && e.is_error === false,
      );
      const skippedResults = events.filter(
        (e) => e.type === "tool_result" && e.is_error === true,
      );
      expect(realResults).toHaveLength(3);
      expect(skippedResults.length).toBeGreaterThanOrEqual(1);
      expect(llmCalls).toBe(4); // 3 exec rounds + 1 capped round

      const msgs = await rt.loadMessages(meta.session_id);
      assertNoOrphanedToolCalls(msgs);
      expect(
        msgs.some((m) => m.role === "tool" && /Skipped: reached max tool steps/i.test(m.content)),
      ).toBe(true);
    },
    30_000,
  );

  it("after max_steps, a subsequent user turn can continue with valid history", async () => {
    let llmCalls = 0;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        llmCalls += 1;
        // After first turn hits max_steps, second submit should get text-only
        if (llmCalls <= 4) return oneTool(llmCalls);
        // Assert history has no orphaned tool_calls shape for the provider
        const assembled = req.messages;
        for (let i = 0; i < assembled.length; i++) {
          const m = assembled[i]!;
          if (m.role === "assistant" && m.tool_calls?.length) {
            const ids = new Set(m.tool_calls.map((tc) => tc.id));
            for (let j = i + 1; j < assembled.length && ids.size > 0; j++) {
              const n = assembled[j]!;
              if (n.role === "tool" && n.tool_call_id && ids.has(n.tool_call_id)) {
                ids.delete(n.tool_call_id);
              } else if (n.role === "assistant" || n.role === "user") {
                break;
              }
            }
            expect(ids.size).toBe(0);
          }
        }
        return textOnly("continued ok");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config({ maxSteps: 3 }),
      provider,
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "loop");
    const events2: RuntimeEvent[] = [];
    rt.onEvent((e) => events2.push(e));
    await rt.submit(meta.session_id, "please continue");
    expect(events2.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    expect(events2.some((e) => e.type === "text" && e.delta === "continued ok")).toBe(true);
    assertNoOrphanedToolCalls(await rt.loadMessages(meta.session_id));
  });

  it("tool results are persisted and fed back", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        calls += 1;
        if (calls === 1) return oneTool(1);
        return textOnly(`tools:${req.messages.filter((m) => m.role === "tool").length}`);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "run");
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
  });

  it("messages and traces cross-link ids; tool input/output are auditable", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        calls += 1;
        if (calls === 1) return oneTool(1);
        // tool_call_arguments must not leak into the LLM payload
        for (const m of req.messages) {
          expect((m as { tool_call_arguments?: string }).tool_call_arguments).toBeUndefined();
        }
        return textOnly("done");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "run bash");

    const { messages, traces } = await rt.loadSessionArtifacts(meta.session_id);
    const byMsgId = new Map(messages.map((m) => [m.id, m]));
    const byTraceId = new Map(traces.map((t) => [t.id, t]));

    const user = messages.find((m) => m.role === "user")!;
    expect(user.trace_id).toBeTruthy();
    expect(byTraceId.get(user.trace_id!)?.type).toBe("user_message");
    expect(byTraceId.get(user.trace_id!)?.message_id).toBe(user.id);

    const requests = traces.filter((t) => t.type === "llm_request");
    const responses = traces.filter((t) => t.type === "llm_response");
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(responses.length).toBeGreaterThanOrEqual(1);
    for (const resp of responses) {
      expect(resp.request_id).toBeTruthy();
      expect(byTraceId.has(resp.request_id!)).toBe(true);
      expect(byTraceId.get(resp.request_id!)!.type).toBe("llm_request");
      expect(resp.message_id).toBeTruthy();
      const msg = byMsgId.get(resp.message_id!)!;
      expect(msg.trace_id).toBe(resp.id);
      expect(resp.detail?.content).toBe(msg.content);
    }

    const req0 = requests[0]!;
    expect(req0.detail).toMatchObject({
      model: "test",
      message_count: expect.any(Number),
      approx_chars: expect.any(Number),
    });
    expect(req0.detail).not.toHaveProperty("messages");
    expect(req0.detail).not.toHaveProperty("payload");

    const toolMsg = messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_arguments).toContain("echo hi");
    expect(toolMsg.content.length).toBeGreaterThan(0);
    expect(toolMsg.trace_id).toBeTruthy();
    const toolTrace = byTraceId.get(toolMsg.trace_id!)!;
    expect(toolTrace.type).toBe("tool_result");
    expect(toolTrace.message_id).toBe(toolMsg.id);
    expect(toolTrace.detail?.arguments).toBe(toolMsg.tool_call_arguments);
    expect(toolTrace.detail?.content).toBe(toolMsg.content);
    expect(toolTrace.detail?.tool).toBe(SHELL_TOOL_NAME);
    expect(toolTrace.detail?.duration_ms).toEqual(expect.any(Number));
    expect(toolTrace.detail?.duration_ms as number).toBeGreaterThanOrEqual(0);
    const callTrace = traces.find((t) => t.id === toolTrace.request_id);
    expect(callTrace?.type).toBe("tool_call");
    expect(callTrace?.detail?.tool).toBe(SHELL_TOOL_NAME);
    expect(callTrace?.detail?.tool_call_id).toBe(toolMsg.tool_call_id);
    expect(callTrace?.detail?.arguments).toBe(toolMsg.tool_call_arguments);
  });

  it("tool-path storage failure emits error and done", async () => {
    const store = new FlakySessionStore(workspace, (m) => m.role === "tool");
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) return oneTool(1);
        return textOnly("should not reach");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      store,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "run");
    expect(events.some((e) => e.type === "error" && e.code === "storage_write_failed")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "done" && e.reason === "error")).toBe(true);
    expect(calls).toBe(1);
  });

  it("max_steps notice storage failure emits error and done", async () => {
    // Fail only on the notice assistant (plain assistant after synthetic tools),
    // not on the capped assistant that still has tool_calls.
    let toolAppends = 0;
    const store = new FlakySessionStore(workspace, (m) => {
      if (m.role === "tool") {
        toolAppends += 1;
        return false;
      }
      // After synthetic skip tool(s) are written, the next assistant is the notice
      return m.role === "assistant" && !m.tool_calls && toolAppends > 0 && /Reached max tool steps/i.test(m.content);
    });
    let llmCalls = 0;
    const provider: LlmProvider = {
      chatStream() {
        llmCalls += 1;
        return oneTool(llmCalls);
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config({ maxSteps: 0 }), // first tool round already at cap
      provider,
      store,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "loop");
    expect(events.some((e) => e.type === "error" && e.code === "storage_write_failed")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "done" && e.reason === "error")).toBe(true);
  });

  it("llm_error persistTrace failure emits single done (no duplicate llm_error done)", async () => {
    const traces = new FlakyTraceStore(workspace, (e) => e.type === "llm_error");
    const provider: LlmProvider = {
      async *chatStream() {
        yield { type: "error", error: "upstream boom" };
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      traces,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "hi");
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ reason: "error" });
    expect(events.some((e) => e.type === "error" && e.code === "storage_write_failed")).toBe(true);
    // Must not also paint a second llm_error after storage failure
    expect(events.some((e) => e.type === "error" && e.code === "llm_error")).toBe(false);
  });

  it("llm_response trace failure after tool_calls closes orphans; next submit stays valid", async () => {
    const traces = new FlakyTraceStore(workspace, (e) => e.type === "llm_response");
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        calls += 1;
        if (calls === 1) return oneTool(1);
        // Second submit must see a closed tool_call pair
        for (let i = 0; i < req.messages.length; i++) {
          const m = req.messages[i]!;
          if (m.role === "assistant" && m.tool_calls?.length) {
            const ids = new Set(m.tool_calls.map((t) => t.id));
            for (let j = i + 1; j < req.messages.length && ids.size > 0; j++) {
              const n = req.messages[j]!;
              if (n.role === "tool" && n.tool_call_id && ids.has(n.tool_call_id)) {
                ids.delete(n.tool_call_id);
              } else if (n.role === "assistant" || n.role === "user") {
                break;
              }
            }
            expect(ids.size).toBe(0);
          }
        }
        return textOnly("recovered");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      traces,
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "first");
    assertNoOrphanedToolCalls(await rt.loadMessages(meta.session_id));

    // Allow llm_response traces on the recovery turn
    const tracesOk = new TraceStore(workspace);
    const rt2 = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      traces: tracesOk,
      store: new SessionStore(workspace),
    });
    const events: RuntimeEvent[] = [];
    rt2.onEvent((e) => events.push(e));
    await rt2.submit(meta.session_id, "second");
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    expect(calls).toBe(2);
    assertNoOrphanedToolCalls(await rt2.loadMessages(meta.session_id));
  });

  it("submit appends synthetic tools for prior orphaned tool_calls before new user", async () => {
    const store = new SessionStore(workspace);
    const meta = await store.createSession();
    const turn = "turn_orphan";
    await store.appendMessage({
      id: "msg_u",
      session_id: meta.session_id,
      turn_id: turn,
      role: "user",
      content: "write something",
      created_at: new Date().toISOString(),
    });
    await store.appendMessage({
      id: "msg_a",
      session_id: meta.session_id,
      turn_id: turn,
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_orphan",
          type: "function",
          function: { name: "write_file", arguments: "{}" },
        },
      ],
      created_at: new Date().toISOString(),
    });

    const provider: LlmProvider = {
      chatStream(req) {
        for (let i = 0; i < req.messages.length; i++) {
          const m = req.messages[i]!;
          if (m.role === "assistant" && m.tool_calls?.length) {
            const ids = new Set(m.tool_calls.map((t) => t.id));
            for (let j = i + 1; j < req.messages.length && ids.size > 0; j++) {
              const n = req.messages[j]!;
              if (n.role === "tool" && n.tool_call_id && ids.has(n.tool_call_id)) {
                ids.delete(n.tool_call_id);
              } else if (n.role === "assistant" || n.role === "user") {
                break;
              }
            }
            expect(ids.size, "provider saw orphaned tool_calls").toBe(0);
          }
        }
        return textOnly("ok after repair");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      store,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.submit(meta.session_id, "continue please");
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    const msgs = await store.readMessages(meta.session_id);
    assertNoOrphanedToolCalls(msgs);
    expect(msgs.some((m) => m.role === "tool" && m.tool_call_id === "call_orphan")).toBe(true);
  });
});
