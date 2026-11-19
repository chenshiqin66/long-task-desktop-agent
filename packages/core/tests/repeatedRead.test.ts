import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import type { AgentConfig, RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { ToolHost } from "../src/tools/host.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return { baseUrl: "http://localhost", model: "test", apiKey: "sk-test", ...DEFAULT_AGENT_CONFIG };
}

async function* chunks(parts: LlmStreamChunk[]): AsyncIterable<LlmStreamChunk> {
  for (const part of parts) yield part;
}

function callChunk(id: string, name: string, args: Record<string, unknown>): LlmStreamChunk {
  return {
    type: "tool_call_delta",
    tool_call: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
  };
}

const TEXT: LlmStreamChunk[] = [{ type: "text", text: "ok" }];

/** Responses in order. Once they run out the model answers with text. */
function scripted(responses: LlmStreamChunk[][]): LlmProvider {
  let n = 0;
  return {
    chatStream() {
      const parts = responses[n] ?? TEXT;
      n += 1;
      return chunks(parts);
    },
  };
}

describe("repeated reads", () => {
  let workspace = "";
  let executed: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-repeat-"));
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "beta\n", "utf8");
    executed = [];
    const original = ToolHost.prototype.execute;
    spy = vi
      .spyOn(ToolHost.prototype, "execute")
      .mockImplementation(async function (this: ToolHost, name, argsJson, ctx) {
        executed.push(`${name}:${(JSON.parse(argsJson) as { path?: string }).path ?? ""}`);
        return original.call(this, name, argsJson, ctx);
      });
  });

  afterEach(async () => {
    spy?.mockRestore();
    await rmWorkspace(workspace);
  });

  async function run(responses: LlmStreamChunk[][]): Promise<Map<string, { content: string; duplicate?: boolean }>> {
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider: scripted(responses) });
    const results = new Map<string, { content: string; duplicate?: boolean }>();
    rt.onEvent((event: RuntimeEvent) => {
      if (event.type === "tool_result") results.set(event.tool_call_id, { content: event.content });
    });
    const meta = await rt.createSession("repeat");
    await rt.submit(meta.session_id, "go");
    return results;
  }

  it("the same read right after itself is answered with a note and not run again", async () => {
    const results = await run([
      [callChunk("r1", "read_file", { path: "a.txt" })],
      [callChunk("r2", "read_file", { path: "a.txt" })],
    ]);
    expect(executed).toEqual(["read_file:a.txt"]);
    expect(results.get("r1")?.content).toContain("alpha");
    expect(results.get("r2")?.content).toMatch(/repeats the call just before it/);
  });

  it("a different read in between means the next read runs", async () => {
    await run([
      [callChunk("r1", "read_file", { path: "a.txt" })],
      [callChunk("r2", "read_file", { path: "b.txt" })],
      [callChunk("r3", "read_file", { path: "a.txt" })],
    ]);
    expect(executed).toEqual(["read_file:a.txt", "read_file:b.txt", "read_file:a.txt"]);
  });

  it("a blocked or write call between two identical reads means the second read runs", async () => {
    await run([
      [callChunk("r1", "read_file", { path: "a.txt" })],
      [callChunk("x", "bash", { command: "rm -rf /" })],
      [callChunk("r2", "read_file", { path: "a.txt" })],
    ]);
    expect(executed).toEqual(["read_file:a.txt", "read_file:a.txt"]);
  });

  it("inside one response, a repeat of the read before it is not run", async () => {
    const results = await run([
      [callChunk("r1", "read_file", { path: "a.txt" }), callChunk("r2", "read_file", { path: "a.txt" })],
    ]);
    expect(executed).toEqual(["read_file:a.txt"]);
    expect(results.get("r1")?.content).toContain("alpha");
    expect(results.get("r2")?.content).toMatch(/repeats the call just before it/);
  });

  it("a new user turn starts with no memory of the last read", async () => {
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider: scripted([
        [callChunk("r1", "read_file", { path: "a.txt" })],
        TEXT,
        [callChunk("r2", "read_file", { path: "a.txt" })],
        TEXT,
      ]),
    });
    const meta = await rt.createSession("repeat-turns");
    await rt.submit(meta.session_id, "first");
    await rt.submit(meta.session_id, "second");
    expect(executed).toEqual(["read_file:a.txt", "read_file:a.txt"]);
  });
});
