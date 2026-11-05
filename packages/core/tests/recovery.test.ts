import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { TraceStore } from "../src/store/traceStore.js";

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
}

describe("recovery", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("new runtime instance reloads messages and traces by turn_id", async () => {
    const provider: LlmProvider = { chatStream: () => textOnly("pong") };
    const cfg = { baseUrl: "x", model: "m", apiKey: "k", ...DEFAULT_AGENT_CONFIG };
    const rt1 = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const meta = await rt1.createSession("recover");
    await rt1.submit(meta.session_id, "ping");

    const rt2 = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const sessions = await rt2.listSessions();
    expect(sessions.map((s) => s.session_id)).toContain(meta.session_id);
    const msgs = await rt2.loadMessages(meta.session_id);
    expect(msgs.find((m) => m.role === "user")?.content).toBe("ping");
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("pong");
    const turn = msgs[0]!.turn_id;
    const traces = await new TraceStore(workspace).read(meta.session_id);
    expect(traces.some((t) => t.turn_id === turn)).toBe(true);
  });
});
