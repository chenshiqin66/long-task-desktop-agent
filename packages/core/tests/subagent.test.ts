import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig, RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import {
  capSubagentResult,
  EXPLORE_TOOL_ROUNDS,
  parseAgentCall,
  subagentToolRounds,
  SUBAGENT_RESULT_MAX,
  toolRoundsNote,
  toolsForSubagent,
  WORKER_TOOL_ROUNDS,
} from "../src/tools/agentTool.js";
import { normalizeOutputDir, outputDirsOverlap } from "../src/tools/writeScope.js";
import { SHELL_TOOL_NAME } from "../src/tools/host.js";
import { listSubagentToolRows } from "../src/store/subagentStore.js";
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

function systemText(req: LlmChatRequest): string {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

function toolNames(req: LlmChatRequest): string[] {
  return req.tools.map((tool) => tool.name).sort();
}

async function* chunks(parts: LlmStreamChunk[]): AsyncIterable<LlmStreamChunk> {
  for (const part of parts) yield part;
}

function textChunk(text: string): LlmStreamChunk {
  return { type: "text", text };
}

function callChunk(id: string, name: string, args: Record<string, unknown>): LlmStreamChunk {
  return {
    type: "tool_call_delta",
    tool_call: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}

describe("subagent definitions", () => {
  it("normalizes output directories and detects overlap", () => {
    const notes = normalizeOutputDir("docs/notes");
    const windows = normalizeOutputDir("docs\\notes\\");
    expect(notes.ok && notes.dir).toBe("docs/notes");
    expect(windows.ok && windows.dir).toBe("docs/notes");
    expect(normalizeOutputDir(".").ok).toBe(false);
    expect(normalizeOutputDir(".agent/sessions").ok).toBe(false);
    expect(normalizeOutputDir("../x").ok).toBe(false);
    expect(outputDirsOverlap("docs/notes", "docs/notes/a")).toBe(true);
    expect(outputDirsOverlap("docs/notes", "docs/other")).toBe(false);
    expect(outputDirsOverlap("docs/a", "docs/ab")).toBe(false);
  });

  it("keeps explore inside the ceiling and gives worker the write tools", () => {
    expect(toolsForSubagent("explore")).not.toContain("write_file");
    expect(toolsForSubagent("explore")).not.toContain("agent");
    expect(toolsForSubagent("worker")).toContain("write_file");
    expect(toolsForSubagent("worker")).not.toContain(SHELL_TOOL_NAME);
    expect(parseAgentCall(JSON.stringify({ description: "find auth", subagent_type: "explore", task: "where is login" })).ok).toBe(
      true,
    );
    expect(
      parseAgentCall(
        JSON.stringify({
          description: "find auth",
          subagent_type: "explore",
          task: "where",
          output_dir: "docs",
        }),
      ).ok,
    ).toBe(false);
  });

  it("caps the receipt and keeps the file list", () => {
    const capped = capSubagentResult("x".repeat(SUBAGENT_RESULT_MAX), ["docs/notes/a.md"]);
    expect(capped.length).toBeLessThanOrEqual(SUBAGENT_RESULT_MAX);
    expect(capped).toContain("docs/notes/a.md");
    expect(capped).toContain("truncated");
  });

  it("gives explore fewer tool rounds than worker, and never more than the parent", () => {
    expect(subagentToolRounds("explore", 50)).toBe(EXPLORE_TOOL_ROUNDS);
    expect(subagentToolRounds("worker", 50)).toBe(WORKER_TOOL_ROUNDS);
    expect(EXPLORE_TOOL_ROUNDS).toBeLessThan(WORKER_TOOL_ROUNDS);
    expect(subagentToolRounds("explore", 3)).toBe(3);
    expect(subagentToolRounds("worker", 0)).toBe(0);
    expect(toolRoundsNote(1, 8)).toContain("Tool rounds left: 7 of 8");
    expect(toolRoundsNote(8, 8)).toContain("Do not call tools again");
  });
});

describe("AgentRuntime subagents", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-sub-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("runs explore subagents together and leaves their file dumps out of the parent", async () => {
    await writeFile(join(workspace, "secret.txt"), "SENTINEL_ALPHA_42\n", "utf8");
    let inflight = 0;
    let maxInflight = 0;
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        const system = systemText(req);
        if (system.includes("You are an explore subagent")) {
          expect(system).toContain(`${EXPLORE_TOOL_ROUNDS} tool rounds`);
          expect(toolNames(req)).toEqual([
            "keyword_search",
            "list_dir",
            "read_file",
            "read_skill",
            "web_search",
          ]);
          return (async function* () {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => setTimeout(resolve, 40));
            inflight -= 1;
            const read = req.messages.some((message) => message.role === "tool");
            if (!read) {
              yield callChunk("read_secret", "read_file", { path: "secret.txt" });
              return;
            }
            yield textChunk("the file exists");
          })();
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("a1", "agent", {
              description: "read secret one",
              subagent_type: "explore",
              task: "Read secret.txt and say whether it exists. Do not quote it.",
            }),
            callChunk("a2", "agent", {
              description: "read secret two",
              subagent_type: "explore",
              task: "Read secret.txt again and say whether it exists.",
            }),
          ]);
        }
        return chunks([textChunk("both reports are in")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession("sub");
    await rt.submit(meta.session_id, "look around");

    expect(maxInflight).toBe(2);
    const parent = await rt.loadMessages(meta.session_id);
    const blob = JSON.stringify(parent);
    expect(blob).not.toContain("SENTINEL_ALPHA_42");
    const results = events.filter((event) => event.type === "tool_result" && !event.parent_tool_call_id);
    expect(results).toHaveLength(2);
    expect(results.every((event) => event.type === "tool_result" && event.content.includes("the file exists"))).toBe(
      true,
    );
    const childReads = events.filter(
      (event) =>
        event.type === "tool_call" &&
        event.parent_tool_call_id &&
        event.tool_call.function.name === "read_file",
    );
    expect(childReads).toHaveLength(2);
    expect(new Set(childReads.map((event) => (event.type === "tool_call" ? event.parent_tool_call_id : "")))).toEqual(
      new Set(["a1", "a2"]),
    );
    const turns = new Set(
      events
        .filter((event) => event.type === "tool_call" || event.type === "tool_result")
        .map((event) => event.turn_id),
    );
    expect(turns.size).toBe(1);
    const stored = await listSubagentToolRows(workspace, meta.session_id);
    expect(stored.filter((row) => row.name === "read_file")).toHaveLength(2);
    expect(stored.every((row) => row.parent_tool_call_id === "a1" || row.parent_tool_call_id === "a2")).toBe(
      true,
    );

    const subs = await readdir(join(workspace, ".agent", "sessions", meta.session_id, "subagents"));
    expect(subs).toHaveLength(2);
    const child = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "subagents", subs[0]!, "messages.jsonl"),
      "utf8",
    );
    expect(child).toContain("SENTINEL_ALPHA_42");
    for (const name of ["meta.json", "messages.jsonl", "trace.jsonl", "context.jsonl"]) {
      const raw = await readFile(
        join(workspace, ".agent", "sessions", meta.session_id, "subagents", subs[0]!, name),
        "utf8",
      );
      expect(raw.length).toBeGreaterThan(0);
    }
    const sessions = await readdir(join(workspace, ".agent", "sessions"));
    expect(sessions).toEqual([meta.session_id]);
  });

  it("lets a worker write only inside output_dir and blocks a parent write into that directory", async () => {
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        const system = systemText(req);
        if (system.includes("You are a worker subagent")) {
          expect(system).toContain(`${WORKER_TOOL_ROUNDS} tool rounds`);
          expect(toolNames(req)).toContain("write_file");
          expect(toolNames(req)).not.toContain("agent");
          expect(toolNames(req)).not.toContain(SHELL_TOOL_NAME);
          expect(toolNames(req)).not.toContain("ask_user");
          const wrote = req.messages.some((message) => message.role === "tool");
          if (!wrote) {
            return chunks([
              callChunk("w1", "write_file", { path: "docs/notes/note.md", content: "SECRET_BODY" }),
              callChunk("w2", "write_file", { path: "src/evil.md", content: "nope" }),
            ]);
          }
          return chunks([textChunk("Wrote note.md. One section.")]);
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("agent1", "agent", {
              description: "write the note",
              subagent_type: "worker",
              task: "Write docs/notes/note.md. Do not write anywhere else.",
              output_dir: "docs/notes",
            }),
            callChunk("parent_write", "write_file", {
              path: "docs/notes/extra.md",
              content: "clobber",
            }),
          ]);
        }
        return chunks([textChunk("noted")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession("work");
    await rt.submit(meta.session_id, "write a note");

    const note = await readFile(join(workspace, "docs", "notes", "note.md"), "utf8");
    expect(note).toBe("SECRET_BODY");
    await expect(readFile(join(workspace, "src", "evil.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "docs", "notes", "extra.md"), "utf8")).rejects.toThrow();
    const parent = JSON.stringify(await rt.loadMessages(meta.session_id));
    expect(parent).not.toContain("SECRET_BODY");
    expect(parent).toContain("docs/notes/note.md");
    const parentWrite = events.find(
      (event) => event.type === "tool_result" && event.tool_call_id === "parent_write",
    );
    expect(parentWrite).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("rejects a second worker whose output_dir overlaps the first", async () => {
    let workers = 0;
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        if (systemText(req).includes("You are a worker subagent")) {
          workers += 1;
          return chunks([textChunk("wrote the page")]);
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("ok", "agent", {
              description: "write page",
              subagent_type: "worker",
              task: "Create the page.",
              output_dir: "docs/guide",
            }),
            callChunk("bad", "agent", {
              description: "write chapter",
              subagent_type: "worker",
              task: "Create a chapter.",
              output_dir: "docs/guide/chapter",
            }),
          ]);
        }
        return chunks([textChunk("done")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession("overlap");
    await rt.submit(meta.session_id, "draft");
    expect(workers).toBe(1);
    const bad = events.find((event) => event.type === "tool_result" && event.tool_call_id === "bad");
    expect(bad).toMatchObject({ type: "tool_result", is_error: true });
    if (bad?.type === "tool_result") expect(bad.content).toMatch(/overlaps/);
  });

  it("stops an explore subagent after its own round cap and tells it how many rounds remain", async () => {
    let childCalls = 0;
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        if (systemText(req).includes("You are an explore subagent")) {
          childCalls += 1;
          return chunks([callChunk(`c${childCalls}`, "list_dir", { path: "." })]);
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("a1", "agent", {
              description: "list the root",
              subagent_type: "explore",
              task: "List the workspace root.",
            }),
          ]);
        }
        return chunks([textChunk("stopped")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config({ maxSteps: 50 }), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession("cap");
    await rt.submit(meta.session_id, "look");

    expect(childCalls).toBe(EXPLORE_TOOL_ROUNDS + 1);
    const rows = await listSubagentToolRows(workspace, meta.session_id);
    const listed = rows.filter((row) => row.name === "list_dir");
    expect(listed).toHaveLength(EXPLORE_TOOL_ROUNDS + 1);
    expect(listed[0]?.content).toContain(`Tool rounds left: ${EXPLORE_TOOL_ROUNDS - 1} of ${EXPLORE_TOOL_ROUNDS}`);
    expect(listed[EXPLORE_TOOL_ROUNDS - 1]?.content).toContain("Tool rounds left: 0 of");
    expect(listed[EXPLORE_TOOL_ROUNDS]?.content).toContain(`Skipped: reached max tool steps (${EXPLORE_TOOL_ROUNDS})`);
    const receipt = events.find((event) => event.type === "tool_result" && event.tool_call_id === "a1");
    expect(receipt).toMatchObject({ type: "tool_result" });
    if (receipt?.type === "tool_result") {
      expect(receipt.content).toContain(`Reached max tool steps (${EXPLORE_TOOL_ROUNDS})`);
    }
  });
});
