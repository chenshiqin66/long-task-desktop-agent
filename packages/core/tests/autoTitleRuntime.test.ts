import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { DeferredAskGate } from "../src/runtime/askGate.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config() {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
  };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
}

describe("auto session title", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("names the session after the 3rd user turn", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        const last = req.messages[req.messages.length - 1]?.content ?? "";
        // Title-generation prompt asks for 标题
        if (/会话标题/.test(last) || /写一个简短会话标题/.test(last)) {
          return textOnly("三轮对话测试名");
        }
        return textOnly(`答${calls}`);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const titles: string[] = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "session_title") titles.push(e.title);
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "第一轮内容");
    await rt.submit(meta.session_id, "第二轮内容");
    expect(titles).toHaveLength(0);
    await rt.submit(meta.session_id, "第三轮内容");
    expect(titles).toEqual(["三轮对话测试名"]);
    const sessions = await rt.listSessions();
    const s = sessions.find((x) => x.session_id === meta.session_id)!;
    expect(s.title).toBe("三轮对话测试名");
    expect(s.title_source).toBe("auto");

    // Fourth turn must not rename again
    await rt.submit(meta.session_id, "第四轮");
    expect(titles).toHaveLength(1);
  });

  it("counts an ask_user answer, so the second submit is the third utterance", async () => {
    const gate = new DeferredAskGate();
    let asked = false;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        const last = req.messages[req.messages.length - 1]?.content ?? "";
        if (/写一个简短会话标题/.test(last)) return textOnly("天泽AI邀约系统");
        const answered = req.messages.some(
          (message) => message.role === "tool" && message.content.includes("深挖产品能力"),
        );
        if (!asked && !answered) {
          asked = true;
          return (async function* () {
            yield {
              type: "tool_call_delta" as const,
              tool_call: {
                id: "call_ask",
                type: "function" as const,
                function: {
                  name: "ask_user",
                  arguments: JSON.stringify({ question: "指哪一个？" }),
                },
              },
            };
          })();
        }
        return textOnly("最终回答");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config(),
      provider,
      asks: gate,
    });
    const titles: string[] = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "session_title") titles.push(e.title);
      if (e.type === "ask_user") {
        queueMicrotask(() => gate.answer(e.request_id, "天泽AI深挖产品能力与落地模式"));
      }
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "检索天泽");
    expect(titles).toHaveLength(0);
    await rt.submit(meta.session_id, "再补一份对比表");
    expect(titles).toEqual(["天泽AI邀约系统"]);
  });

  it("skips auto-title when user already renamed", async () => {
    const provider: LlmProvider = {
      chatStream() {
        return textOnly("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const titles: string[] = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "session_title") titles.push(e.title);
    });
    const meta = await rt.createSession();
    await rt.renameSession(meta.session_id, "我手改的名字", { source: "user" });
    await rt.submit(meta.session_id, "一");
    await rt.submit(meta.session_id, "二");
    await rt.submit(meta.session_id, "三");
    expect(titles).toHaveLength(0);
    const s = (await rt.listSessions()).find((x) => x.session_id === meta.session_id)!;
    expect(s.title).toBe("我手改的名字");
    expect(s.title_source).toBe("user");
  });
});
