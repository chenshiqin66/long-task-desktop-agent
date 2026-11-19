import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig, RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { ToolHost } from "../src/tools/host.js";
import { isParallelReadCall } from "../src/tools/policy.js";
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

/** One scripted model response: a list of calls. After the script runs out, the model answers with text. */
function scripted(responses: LlmStreamChunk[][]): LlmProvider {
  let n = 0;
  return {
    chatStream(_req: LlmChatRequest) {
      const parts = responses[n] ?? [{ type: "text", text: "done" } as LlmStreamChunk];
      n += 1;
      return chunks(parts);
    },
  };
}

describe("isParallelReadCall", () => {
  it("accepts plain reads and read-only shell commands", () => {
    expect(isParallelReadCall("read_file", '{"path":"a"}')).toBe(true);
    expect(isParallelReadCall("keyword_search", "{}")).toBe(true);
    expect(isParallelReadCall("bash", '{"command":"cat a.txt"}')).toBe(true);
  });

  it("rejects writes, state-changing task tools, ask_user, subagents, MCP tools, and blocked commands", () => {
    expect(isParallelReadCall("str_replace", '{"path":"a"}')).toBe(false);
    expect(isParallelReadCall("claim_task", '{"id":"1"}')).toBe(false);
    expect(isParallelReadCall("complete_task", '{"id":"1"}')).toBe(false);
    expect(isParallelReadCall("ask_user", '{"question":"?"}')).toBe(false);
    expect(isParallelReadCall("subagent", '{"subagent_type":"explore"}')).toBe(false);
    expect(isParallelReadCall("mcp__srv__tool", "{}")).toBe(false);
    expect(isParallelReadCall("bash", '{"command":"rm -rf /"}')).toBe(false);
    expect(isParallelReadCall("bash", '{"command":"echo hi > out.txt"}')).toBe(false);
  });
});

describe("read-only calls in one response", () => {
  let workspace = "";
  let log: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-parallel-"));
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "beta\n", "utf8");
    await writeFile(join(workspace, "c.txt"), "gamma\n", "utf8");
    log = [];
    const original = ToolHost.prototype.execute;
    spy = vi
      .spyOn(ToolHost.prototype, "execute")
      .mockImplementation(async function (this: ToolHost, name, argsJson, ctx) {
        const label = `${name}:${(JSON.parse(argsJson) as { path?: string }).path ?? ""}`;
        log.push(`start ${label}`);
        const result = await original.call(this, name, argsJson, ctx);
        log.push(`end ${label}`);
        return result;
      });
  });

  afterEach(async () => {
    spy?.mockRestore();
    await rmWorkspace(workspace);
  });

  async function run(responses: LlmStreamChunk[][]): Promise<string[]> {
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider: scripted(responses) });
    const results: string[] = [];
    rt.onEvent((event: RuntimeEvent) => {
      if (event.type === "tool_result") results.push(event.tool_call_id);
    });
    const meta = await rt.createSession("parallel");
    await rt.submit(meta.session_id, "go");
    return results;
  }

  it("starts consecutive reads together and records their results in call order", async () => {
    const results = await run([
      [
        callChunk("r1", "read_file", { path: "a.txt" }),
        callChunk("r2", "read_file", { path: "b.txt" }),
        callChunk("r3", "read_file", { path: "c.txt" }),
      ],
    ]);
    expect(results).toEqual(["r1", "r2", "r3"]);
    // Every read starts before the first one ends.
    const firstEnd = log.indexOf("end read_file:a.txt");
    expect(log.indexOf("start read_file:b.txt")).toBeLessThan(firstEnd);
    expect(log.indexOf("start read_file:c.txt")).toBeLessThan(firstEnd);
  });

  it("a blocked call splits the run, so later reads start only after the earlier ones finish", async () => {
    const results = await run([
      [
        callChunk("r1", "read_file", { path: "a.txt" }),
        callChunk("r2", "read_file", { path: "b.txt" }),
        callChunk("x", "bash", { command: "rm -rf /" }),
        callChunk("r3", "read_file", { path: "c.txt" }),
      ],
    ]);
    expect(results).toEqual(["r1", "r2", "x", "r3"]);
    const lastReadEnd = Math.max(log.indexOf("end read_file:a.txt"), log.indexOf("end read_file:b.txt"));
    expect(log.indexOf("start read_file:c.txt")).toBeGreaterThan(lastReadEnd);
  });

  it("a single read keeps the ordinary path", async () => {
    const results = await run([[callChunk("only", "read_file", { path: "a.txt" })]]);
    expect(results).toEqual(["only"]);
    expect(log).toEqual(["start read_file:a.txt", "end read_file:a.txt"]);
  });
});
