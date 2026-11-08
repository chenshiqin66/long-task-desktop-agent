import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPLAIN_SYSTEM_PROMPT,
  buildExplainUserContent,
  clipKeeping,
  sourceTurnContext,
  visibleExplainText,
} from "../src/explain/context.js";
import { ExplainRuntime } from "../src/runtime/explainRuntime.js";
import { SessionStore } from "../src/store/sessionStore.js";
import type { AgentConfig, LlmChatRequest, LlmProvider, LlmStreamChunk, Message } from "../src/index.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return { baseUrl: "http://localhost", model: "test", apiKey: "sk-test", ...DEFAULT_AGENT_CONFIG, ...over };
}

function textProvider(text: string, seen: LlmChatRequest[]): LlmProvider {
  return {
    chatStream(req) {
      seen.push(req);
      return textOnly(text);
    },
  };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
}

describe("explain context", () => {
  it("keeps the reminder out of the visible bubble and in front of the user input", () => {
    const stored = buildExplainUserContent("选中的句子", { user: "问题", assistant: "回答" });
    expect(stored.startsWith("<system reminder>\n")).toBe(true);
    expect(stored).toContain("这是用户的提问语境，请尽量基于此语境回答用户的问题");
    expect(visibleExplainText(stored)).toBe("选中的句子");
    expect(visibleExplainText("没有提醒")).toBe("没有提醒");
  });

  it("uses only the selected turn and skips tool output", () => {
    const messages = [
      msg("u1", "turn-a", "user", "第一问"),
      msg("a1", "turn-a", "assistant", "第一答"),
      msg("u2", "turn-b", "user", "第二问"),
      msg("a2", "turn-b", "assistant", "请看「关键句」这段"),
      msg("t1", "turn-b", "tool", "工具原文不应该出现", { name: "bash" }),
    ];
    const found = sourceTurnContext(messages, ["a2"], "关键句");
    expect(found).toEqual({ user: "第二问", assistant: "请看「关键句」这段" });
    expect(sourceTurnContext(messages, [], "关键句")?.assistant).toContain("关键句");
  });

  it("clips a long side but keeps the selected sentence", () => {
    const selected = "选中这句";
    const text = `${"前".repeat(5000)}${selected}${"后".repeat(5000)}`;
    const clipped = clipKeeping(text, selected, 100);
    expect(clipped).toContain(selected);
    expect(clipped.length).toBeLessThan(text.length);
  });
});

describe("ExplainRuntime", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "explain-ws-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("stores an independent transcript and sends only system plus that history", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession("原标题");
    await sessions.appendMessage({
      ...msg("main", "turn-main", "user", "主会话"),
      session_id: meta.session_id,
    });
    const seen: LlmChatRequest[] = [];
    const rt = new ExplainRuntime({
      workspacePath: workspace,
      config: config(),
      provider: textProvider("简短解释", seen),
    });
    await rt.submit(meta.session_id, "选中的句子", undefined, { user: "主问题", assistant: "主回答" });

    const main = await sessions.readMessages(meta.session_id);
    expect(main.map((message) => message.content)).toEqual(["主会话"]);
    expect((await sessions.getMeta(meta.session_id)).title).toBe("原标题");

    const explain = await rt.loadMessages(meta.session_id);
    expect(explain.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(visibleExplainText(explain[0]!.content)).toBe("选中的句子");
    expect(explain[0]!.content).toContain("<system reminder>");
    expect(explain[1]!.content).toBe("简短解释");

    const request = seen[0]!;
    expect(request.tools.map((tool) => tool.name)).toEqual(["web_search"]);
    expect(request.tools[0]!.description).toContain("at most 3");
    expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(String(request.messages[0]!.content)).toContain(EXPLAIN_SYSTEM_PROMPT);
    expect(String(request.messages[0]!.content)).not.toContain("Installed skills");
    expect(String(request.messages[1]!.content)).toContain("主问题");
    expect(String(request.messages[1]!.content).endsWith("选中的句子")).toBe(true);

    const rawExplain = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "explain-messages.jsonl"),
      "utf8",
    );
    expect(rawExplain).toContain("简短解释");
    const mainRaw = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "messages.jsonl"),
      "utf8",
    );
    expect(mainRaw).not.toContain("简短解释");
  });

  it("does not repeat the reminder on a typed follow-up", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession();
    const rt = new ExplainRuntime({
      workspacePath: workspace,
      config: config(),
      provider: textProvider("好", []),
    });
    await rt.submit(meta.session_id, "第一句", undefined, { user: "问", assistant: "答" });
    await rt.submit(meta.session_id, "展开讲讲");
    const messages = await rt.loadMessages(meta.session_id);
    const follow = messages.filter((message) => message.role === "user")[1]!;
    expect(follow.content).toBe("展开讲讲");
  });

  it("rejects a second submit while the first is still running", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: LlmProvider = {
      async *chatStream() {
        started();
        yield { type: "text", text: "还在写" };
        await gate;
      },
    };
    const rt = new ExplainRuntime({ workspacePath: workspace, config: config(), provider });
    const first = rt.submit(meta.session_id, "一句");
    await startedGate;
    await expect(rt.submit(meta.session_id, "另一句")).rejects.toThrow(/解释还在进行/);
    release();
    await first;
  });

  it("stops the in-flight turn without touching the main transcript", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession();
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: LlmProvider = {
      async *chatStream(req) {
        yield { type: "text", text: "写到一半" };
        started();
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const rt = new ExplainRuntime({ workspacePath: workspace, config: config(), provider });
    const pending = rt.submit(meta.session_id, "一句");
    await startedGate;
    rt.cancel();
    await pending;
    const explain = await rt.loadMessages(meta.session_id);
    expect(explain[1]!.content).toContain("写到一半");
    expect(await sessions.readMessages(meta.session_id)).toEqual([]);
  });

  it("runs only web_search and stores explain-prefixed images", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession();
    let step = 0;
    const provider: LlmProvider = {
      async *chatStream() {
        step += 1;
        if (step === 1) {
          yield {
            type: "tool_call_delta",
            tool_call: {
              id: "call_bash",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
            },
          };
          return;
        }
        yield { type: "text", text: "查完了" };
      },
    };
    const rt = new ExplainRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      fetchImpl: async () => {
        throw new Error("search should not be called");
      },
    });
    await rt.submit(meta.session_id, "看图", [{ mime: "image/png", base64: PNG }]);
    const messages = await rt.loadMessages(meta.session_id);
    const tool = messages.find((message) => message.role === "tool");
    expect(tool?.is_error).toBe(true);
    expect(tool?.content).toContain("Unknown tool: bash");
    expect(messages.at(-1)?.content).toBe("查完了");
    expect(messages[0]!.images?.[0]?.path.startsWith("images/explain-img_")).toBe(true);
    const dataUrl = await rt.readImage(meta.session_id, messages[0]!.images![0]!.path);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("remembers the panel open flag without a title", async () => {
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession("保持");
    const rt = new ExplainRuntime({
      workspacePath: workspace,
      config: config(),
      provider: textProvider("x", []),
    });
    expect(await rt.getOpen(meta.session_id)).toBe(false);
    await rt.setOpen(meta.session_id, true);
    expect(await rt.getOpen(meta.session_id)).toBe(true);
    expect((await sessions.getMeta(meta.session_id)).title).toBe("保持");
  });
});

function msg(
  id: string,
  turnId: string,
  role: Message["role"],
  content: string,
  extra?: Partial<Message>,
): Message {
  return {
    id,
    session_id: "sess_test",
    turn_id: turnId,
    role,
    content,
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}
