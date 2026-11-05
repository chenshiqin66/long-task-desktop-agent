import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { SHELL_TOOL_NAME } from "../src/tools/host.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import type { RuntimeEvent, AgentConfig, Message } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { TraceStore } from "../src/store/traceStore.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { rmWorkspace } from "./rmWorkspace.js";

const cfg: AgentConfig = {
  baseUrl: "http://localhost",
  model: "test",
  apiKey: "sk",
  ...DEFAULT_AGENT_CONFIG,
};

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

describe("cancel", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("keeps partial assistant text as interrupted and writes cancel trace", async () => {
    const provider: LlmProvider = {
      async *chatStream(req) {
        yield { type: "text", text: "partial " };
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(() => resolve(), 2000);
        });
        if (!req.signal?.aborted) yield { type: "text", text: "more" };
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const submitPromise = rt.submit(meta.session_id, "go");
    await new Promise((r) => setTimeout(r, 50));
    rt.cancel();
    await submitPromise;
    expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const msgs = await rt.loadMessages(meta.session_id);
    const asst = msgs.find((m) => m.role === "assistant");
    expect(asst?.interrupted).toBe(true);
    expect(asst?.content).toContain("partial");
    expect(asst?.content).not.toContain("more");
    const traces = await new TraceStore(workspace).read(meta.session_id);
    expect(traces.some((t) => t.type === "cancel")).toBe(true);
  });

  it("does not execute tool_calls after cancel before tools run", async () => {
    const provider: LlmProvider = {
      async *chatStream(req): AsyncIterable<LlmStreamChunk> {
        yield {
          type: "tool_call_delta",
          tool_call: {
            id: "call_x",
            type: "function",
            function: {
              name: SHELL_TOOL_NAME,
              arguments: JSON.stringify({ command: "echo should_not_run" }),
            },
          },
        };
        await new Promise<void>((resolve) => {
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 2000);
        });
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const meta = await rt.createSession();
    const p = rt.submit(meta.session_id, "go");
    await new Promise((r) => setTimeout(r, 30));
    rt.cancel();
    await p;
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
    // Cancel during stream: assistant with tool_calls must not be persisted
    expect(msgs.some((m) => m.role === "assistant" && m.tool_calls?.length)).toBe(false);
  });

  it("kills in-flight bash and skips remaining pending tool_calls", async () => {
    const marker = join(workspace, "bash-ran.txt");
    let calls = 0;
    const provider: LlmProvider = {
      async *chatStream(): AsyncIterable<LlmStreamChunk> {
        calls += 1;
        if (calls === 1) {
          yield {
            type: "tool_call_delta",
            tool_call: {
              id: "call_slow",
              type: "function",
              function: {
                name: SHELL_TOOL_NAME,
                arguments: JSON.stringify({
                  command:
                    process.platform === "win32"
                      ? `Start-Sleep -Seconds 30; Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value ran`
                      : `sleep 5; echo ran > "${marker}"`,
                }),
              },
            },
          };
          yield {
            type: "tool_call_delta",
            tool_call: {
              id: "call_pending",
              type: "function",
              function: {
                name: SHELL_TOOL_NAME,
                arguments: JSON.stringify({
                  command:
                    process.platform === "win32"
                      ? `Set-Content -LiteralPath '${join(workspace, "pending.txt").replace(/'/g, "''")}' -Value pending`
                      : `echo pending > "${join(workspace, "pending.txt")}"`,
                }),
              },
            },
          };
        } else {
          yield { type: "text", text: "should not reach" };
        }
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const p = rt.submit(meta.session_id, "go");
    // Wait until first tool has started (tool phase or first tool_result)
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (events.some((e) => e.type === "status" && e.phase === "tool")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    rt.cancel();
    await p;

    expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);

    const msgs = await rt.loadMessages(meta.session_id);
    assertNoOrphanedToolCalls(msgs);

    // Marker from sleep command must not exist (killed before echo)
    await expect(access(marker)).rejects.toThrow();
    // pending tool must not have created its file
    await expect(access(join(workspace, "pending.txt"))).rejects.toThrow();

    const traces = await new TraceStore(workspace).read(meta.session_id);
    expect(traces.some((t) => t.type === "cancel")).toBe(true);

    // Only one LLM round — cancelled mid-tools, no second chatStream
    expect(calls).toBe(1);
  });

  it("cancel persist failure emits single done(error), not double done", async () => {
    const provider: LlmProvider = {
      async *chatStream(req) {
        yield { type: "text", text: "partial " };
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(() => resolve(), 2000);
        });
      },
    };
    const store = new FlakySessionStore(
      workspace,
      (msg) => msg.role === "assistant" && msg.interrupted === true,
    );
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: cfg,
      provider,
      store,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const submitPromise = rt.submit(meta.session_id, "go");
    await new Promise((r) => setTimeout(r, 50));
    rt.cancel();
    await submitPromise;
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: "done", reason: "error" });
    expect(events.some((e) => e.type === "error" && e.code === "storage_write_failed")).toBe(
      true,
    );
  });
});
