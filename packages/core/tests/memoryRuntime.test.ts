import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime, buildDefaultSystemPrompt } from "../src/runtime/agentRuntime.js";
import { assembleContext, elideStaleToolResults } from "../src/context/assemble.js";
import { classifyToolCall } from "../src/tools/policy.js";
import { MemoryStore } from "../src/memory/store.js";
import { AUTO_MEMORY_OFF_LINE } from "../src/memory/prompt.js";
import type { RuntimeMemory } from "../src/memory/turn.js";
import type { LlmChatRequest, LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG, type AgentConfig, type Message } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return { baseUrl: "http://127.0.0.1:9", model: "test-model", apiKey: "test-key", ...DEFAULT_AGENT_CONFIG };
}

function text(value: string): LlmStreamChunk {
  return { type: "text", text: value };
}

function call(id: string, name: string, args: Record<string, unknown>): LlmStreamChunk {
  return { type: "tool_call_delta", tool_call: { id, type: "function", function: { name, arguments: JSON.stringify(args) } } };
}

function systemText(req: LlmChatRequest): string {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

describe("memory in the runtime", () => {
  let base: string;
  let workspace: string;
  let home: string;
  let skillsRoot: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-memrt-"));
    workspace = join(base, "ws");
    home = join(base, "home");
    skillsRoot = join(base, "skills");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(skillsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  function memory(autoMemory = true): RuntimeMemory {
    return { store: new MemoryStore({ workspacePath: workspace, home }), autoMemory: async () => autoMemory };
  }

  it("reads memory once per turn and answers memory_read from the files", async () => {
    const mem = memory();
    await writeFile(join(workspace, "AGENTS.md"), "Project rule: two spaces.", "utf8");
    const systems: string[] = [];
    const toolLists: string[][] = [];
    let calls = 0;
    const provider: LlmProvider = {
      async *chatStream(req) {
        calls += 1;
        systems.push(systemText(req));
        toolLists.push(req.tools.map((tool) => tool.name));
        if (calls === 1) {
          await mem.store.upsert(
            { scope: "project", name: "deadline", type: "project", description: "12 月 5 日发版", body: "版本要在 2026-12-05 之前发出。" },
            { actor: "extractor", origin: "extracted", secrets: [] },
          );
          yield call("m1", "memory_read", { name: "deadline" });
          return;
        }
        yield text("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot, memory: mem });
    const meta = await rt.createSession("memory");
    await rt.submit(meta.session_id, "first");
    await rt.submit(meta.session_id, "second");

    expect(calls).toBe(3);
    const rulesAt = systems[0]!.indexOf("Memory:\n- Notes in the Memory section");
    const projectAt = systems[0]!.indexOf("# Project instructions\nSource: AGENTS.md\nProject rule: two spaces.");
    expect(rulesAt).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(rulesAt);
    expect(systems[1]).not.toContain("- [project] deadline");
    expect(systems[2]).toContain("- [project] deadline（本项目，今天）：12 月 5 日发版");
    expect(toolLists[0]).toContain("memory_read");
    const tool = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "tool");
    expect(tool).toMatchObject({ name: "memory_read", is_error: false });
    expect(tool?.content).toContain("版本要在 2026-12-05 之前发出。");
  });

  it("says automatic memory is off even when there are no notes", async () => {
    let system = "";
    const provider: LlmProvider = {
      async *chatStream(req) {
        system = systemText(req);
        yield text("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot, memory: memory(false) });
    const meta = await rt.createSession("memory");
    await rt.submit(meta.session_id, "hi");
    expect(system).toContain(`# Memory\n${AUTO_MEMORY_OFF_LINE}`);
  });

  it("answers memory_read with an error when the runtime has no memory", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      async *chatStream() {
        calls += 1;
        if (calls === 1) {
          yield call("m1", "memory_read", {});
          return;
        }
        yield text("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot });
    const meta = await rt.createSession("memory");
    await rt.submit(meta.session_id, "hi");
    const tool = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "tool");
    expect(tool).toMatchObject({ name: "memory_read", is_error: true });
    expect(tool?.content).toContain("Memory is not available");
  });

  it("puts the rules in the default prompt and runs memory_read without asking", () => {
    const prompt = buildDefaultSystemPrompt("D:\\work\\demo");
    expect(prompt).toContain("You cannot save notes.");
    expect(prompt).toContain("call memory_read with its name");
    expect(prompt).toContain("Subagents do not see memory notes.");
    expect(classifyToolCall("memory_read", "{}").risk).toBe("read");
  });
});

describe("memory in the assembled context", () => {
  const msg = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({
    id,
    session_id: "s",
    turn_id: "t",
    role,
    content,
    created_at: "2026-11-17T00:00:00.000Z",
    ...extra,
  });

  it("puts memory after the system prompt and before the skill catalog", () => {
    const ctx = assembleContext({
      systemPrompt: "SYSTEM",
      memory: "MEMORY BLOCK",
      history: [],
      currentUser: msg("u1", "user", "hi"),
      contextCharLimit: 100_000,
      installedSkills: [{ name: "demo-skill", description: "Demo" }],
      extraSystem: "REMINDER",
    });
    const system = String(ctx.messages[0]!.content);
    const positions = ["SYSTEM", "MEMORY BLOCK", "demo-skill", "REMINDER"].map((part) => system.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("takes the memory length out of the history budget", () => {
    const history = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", `${i} ${"x".repeat(1000)}`));
    const last = msg("u99", "user", "now");
    const plain = assembleContext({ systemPrompt: "S", history, currentUser: last, contextCharLimit: 20_000 });
    const withMemory = assembleContext({ systemPrompt: "S", memory: "M".repeat(8_000), history, currentUser: last, contextCharLimit: 20_000 });
    expect(withMemory.messages.length).toBeLessThan(plain.messages.length);
  });

  it("shortens an old memory_read result like other bulk reads", () => {
    const toolCall = (id: string, name: string, args: string) => ({ id, type: "function" as const, function: { name, arguments: args } });
    const out = elideStaleToolResults([
      msg("u1", "user", "go"),
      msg("a1", "assistant", "", { tool_calls: [toolCall("c1", "memory_read", '{"name":"deadline"}')] }),
      msg("t1", "tool", "y".repeat(800), { name: "memory_read", tool_call_id: "c1", tool_call_arguments: '{"name":"deadline"}' }),
      msg("a2", "assistant", "", { tool_calls: [toolCall("c2", "list_dir", '{"path":"."}')] }),
      msg("t2", "tool", "a.txt", { name: "list_dir", tool_call_id: "c2", tool_call_arguments: '{"path":"."}' }),
    ]);
    expect(out[2]!.content).toBe("此前 memory_read 的结果已省略（deadline，800 字）。需要时再调用。");
  });
});
