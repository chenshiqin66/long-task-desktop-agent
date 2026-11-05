import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { SHELL_TOOL_NAME } from "../src/tools/host.js";
import { DeferredPermissionGate } from "../src/runtime/permission.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import type { RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
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

async function* bashCall(command: string): AsyncIterable<LlmStreamChunk> {
  yield {
    type: "tool_call_delta",
    tool_call: {
      id: "call_1",
      type: "function",
      function: { name: SHELL_TOOL_NAME, arguments: JSON.stringify({ command }) },
    },
  };
}

describe("permission gate", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-perm-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("auto-runs read bash without permission_request", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) return bashCall("ls");
        return (async function* () {
          yield { type: "text", text: "done" };
        })();
      },
    };
    const gate = new DeferredPermissionGate();
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      permissions: gate,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "list");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    expect(gate.pendingCount).toBe(0);
  });

  it("write bash emits permission_request and respects deny", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) return bashCall("rm doomed.txt");
        return (async function* () {
          yield { type: "text", text: "should-not-matter" };
        })();
      },
    };
    const gate = new DeferredPermissionGate();
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      permissions: gate,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => {
      events.push(e);
      if (e.type === "permission_request") {
        queueMicrotask(() => gate.respond(e.request_id, "deny"));
      }
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "delete");
    expect(events.some((e) => e.type === "permission_request")).toBe(true);
    const denied = events.find(
      (e) => e.type === "tool_result" && e.is_error && /denied permission/i.test(e.content),
    );
    expect(denied).toBeTruthy();
    // After deny, model gets another round (tool result in history)
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("write bash allow then executes", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) {
          return bashCall(
            process.platform === "win32"
              ? "New-Item -ItemType File -Path created-by-perm.txt -Force | Out-Null"
              : "touch created-by-perm.txt",
          );
        }
        return (async function* () {
          yield { type: "text", text: "ok" };
        })();
      },
    };
    const gate = new DeferredPermissionGate();
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      permissions: gate,
    });
    rt.onEvent((e) => {
      if (e.type === "permission_request") {
        queueMicrotask(() => gate.respond(e.request_id, "allow"));
      }
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "create");
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool" && !m.content.includes("denied"))).toBe(true);
    expect(calls).toBe(2);
  });

  it("blocked bash never asks permission", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        if (calls === 1) return bashCall("rm -rf /");
        return (async function* () {
          yield { type: "text", text: "ok" };
        })();
      },
    };
    const gate = new DeferredPermissionGate();
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      permissions: gate,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "wipe");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
    expect(
      events.some(
        (e) => e.type === "tool_result" && /Blocked dangerous/i.test(e.content),
      ),
    ).toBe(true);
  });

  it("cancel while awaiting permission denies and finishes cancelled", async () => {
    const provider: LlmProvider = {
      chatStream() {
        return bashCall("rm file.txt");
      },
    };
    const gate = new DeferredPermissionGate();
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      permissions: gate,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const p = rt.submit(meta.session_id, "del");
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (events.some((e) => e.type === "permission_request")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gate.pendingCount).toBe(1);
    rt.cancel();
    await p;
    expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true);
    expect(gate.pendingCount).toBe(0);
  });
});
