import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { SHELL_TOOL_NAME } from "../src/tools/host.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig, Message } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { InboxStore, TASK_NOTIFICATION_NAME, planDrain } from "../src/store/inboxStore.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { nowIso } from "../src/ids.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return { baseUrl: "http://localhost", model: "test", apiKey: "sk-test", ...DEFAULT_AGENT_CONFIG };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
}

function userText(messages: LlmChatRequest["messages"]): string[] {
  return messages
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content as string);
}

describe("task notification inbox", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-inbox-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("merges pending notes into one message and retries the same id after a claim", () => {
    const sessionId = "sess_inbox";
    const lines = [
      {
        op: "enqueue" as const,
        id: "note_1",
        subagent_id: "subagent_a",
        task_id: "3",
        content: "report",
        ok: true,
        created_at: "t0",
      },
      {
        op: "enqueue" as const,
        id: "note_2",
        subagent_id: "subagent_b",
        content: "failed write",
        ok: false,
        created_at: "t1",
      },
      {
        op: "claim" as const,
        message_id: "msg_fixed",
        turn_id: "turn_old",
        ids: ["note_1", "note_2"],
        created_at: "t2",
      },
    ];
    const planned = planDrain(sessionId, lines, [], "turn_new");
    expect(planned.action).toBe("write");
    if (planned.action !== "write") return;
    expect(planned.appendClaim).toBeNull();
    expect(planned.message.id).toBe("msg_fixed");
    expect(planned.message.turn_id).toBe("turn_old");
    expect(planned.message.name).toBe(TASK_NOTIFICATION_NAME);
    expect(planned.message.content).toContain("subagent_a");
    expect(planned.message.content).toContain("任务 #3");
    expect(planned.message.content).toContain("subagent_b");
    expect(planned.message.content).toContain("不是用户的新指令");

    const again = planDrain(sessionId, lines, [planned.message, assistant("done")], "turn_new");
    expect(again).toEqual({ action: "consume_only", messageId: "msg_fixed", callModel: false });
  });

  it("does not call the model for an unwatched session, then puts the receipt ahead of the next user message", async () => {
    const seen: string[][] = [];
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        seen.push(userText(req.messages));
        return textOnly("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    await rt.postTaskNotification(meta.session_id, {
      subagentId: "subagent_a",
      taskId: "1",
      content: "files are in out/",
      ok: true,
    });
    expect(seen).toHaveLength(0);
    await rt.submit(meta.session_id, "continue");
    expect(seen).toHaveLength(1);
    const users = seen[0]!;
    expect(users.at(-1)).toBe("continue");
    expect(users.at(-2)).toContain("files are in out/");
    expect(users.at(-2)).toContain("任务 #1");
  });

  it("starts a continuation for the open session and shows the model the receipt", async () => {
    const seen: string[][] = [];
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        seen.push(userText(req.messages));
        return textOnly("picked up");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    await rt.watchSession(meta.session_id);
    await rt.postTaskNotification(meta.session_id, {
      id: "note_a",
      subagentId: "subagent_a",
      content: "explore finished",
      ok: true,
    });
    await rt.postTaskNotification(meta.session_id, {
      id: "note_b",
      subagentId: "subagent_b",
      content: "worker finished",
      ok: true,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]![0]).toContain("explore finished");
    expect(seen[1]!.at(-1)).toContain("worker finished");
    const stored = await rt.loadMessages(meta.session_id);
    const notes = stored.filter((message) => message.name === TASK_NOTIFICATION_NAME);
    expect(notes).toHaveLength(2);
    expect(notes.every((message) => message.turn_id === stored.find((item) => item.role === "assistant")?.turn_id || message.role === "user")).toBe(true);
  });

  it("appends the receipt after tool results and before the next model call", async () => {
    let calls = 0;
    let second: LlmChatRequest["messages"] = [];
    const rtHolder: { rt?: AgentRuntime; sessionId?: string } = {};
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            await rtHolder.rt!.postTaskNotification(rtHolder.sessionId!, {
              subagentId: "subagent_a",
              content: "background done",
              ok: true,
            });
            yield {
              type: "tool_call_delta" as const,
              tool_call: {
                id: "call_1",
                type: "function" as const,
                function: { name: SHELL_TOOL_NAME, arguments: JSON.stringify({ command: "echo hi" }) },
              },
            };
          })();
        }
        second = req.messages;
        return textOnly("used the receipt");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    rtHolder.rt = rt;
    rtHolder.sessionId = meta.session_id;
    await rt.submit(meta.session_id, "go");
    expect(calls).toBe(2);
    const toolAt = second.findIndex((message) => message.role === "tool");
    const noteAt = second.findIndex(
      (message) => message.role === "user" && String(message.content).includes("background done"),
    );
    expect(toolAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(toolAt);
  });

  it("calls the model again when a receipt arrives during the final answer", async () => {
    let calls = 0;
    let second = "";
    const rtHolder: { rt?: AgentRuntime; sessionId?: string } = {};
    const recording: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            yield { type: "text" as const, text: "first answer" };
            await rtHolder.rt!.postTaskNotification(rtHolder.sessionId!, {
              subagentId: "subagent_a",
              content: "late result",
              ok: true,
            });
          })();
        }
        second = userText(req.messages).join("\n");
        return textOnly("second");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider: recording });
    const meta = await rt.createSession("t");
    rtHolder.rt = rt;
    rtHolder.sessionId = meta.session_id;
    await rt.submit(meta.session_id, "question");
    expect(calls).toBe(2);
    expect(second).toContain("late result");
    expect(second).toContain("question");
  });

  it("keeps a receipt queued across cancel and writes it ahead of the next send", async () => {
    let calls = 0;
    const seen: string[][] = [];
    const rtHolder: { rt?: AgentRuntime; sessionId?: string } = {};
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        seen.push(userText(req.messages));
        if (calls === 1) {
          return (async function* () {
            yield { type: "text" as const, text: "partial" };
            rtHolder.rt!.cancel();
            await rtHolder.rt!.postTaskNotification(rtHolder.sessionId!, {
              subagentId: "subagent_a",
              content: "after stop",
              ok: false,
            });
          })();
        }
        return textOnly("later");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    rtHolder.rt = rt;
    rtHolder.sessionId = meta.session_id;
    await rt.watchSession(meta.session_id);
    await rt.submit(meta.session_id, "run");
    expect(calls).toBe(1);
    await rt.submit(meta.session_id, "next");
    expect(calls).toBe(2);
    expect(seen[1]!.at(-1)).toBe("next");
    expect(seen[1]!.at(-2)).toContain("after stop");
  });

  it("sends a message typed during the continuation after the receipt", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const seen: string[][] = [];
    const rtHolder: { rt?: AgentRuntime; sessionId?: string } = {};
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        seen.push(userText(req.messages));
        if (calls === 1) {
          return (async function* () {
            yield { type: "text" as const, text: "ack" };
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          })();
        }
        return textOnly("combined");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    rtHolder.rt = rt;
    rtHolder.sessionId = meta.session_id;
    await rt.watchSession(meta.session_id);
    const running = rt.postTaskNotification(meta.session_id, {
      subagentId: "subagent_a",
      content: "receipt body",
      ok: true,
    });
    await waitFor(() => calls === 1 && release != null);
    await rt.submit(meta.session_id, "follow up");
    release!();
    await running;
    expect(calls).toBe(2);
    const second = seen[1]!;
    expect(second.at(-1)).toBe("follow up");
    expect(second.join("\n")).toContain("receipt body");
    const followAt = second.lastIndexOf("follow up");
    const receiptAt = second.findIndex((line) => line.includes("receipt body"));
    expect(followAt).toBeGreaterThan(receiptAt);
  });

  it("rewrites a claimed receipt once and does not call the model when it was already answered", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream() {
        calls += 1;
        return textOnly("should not run");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("t");
    const store = new SessionStore(workspace);
    const inbox = new InboxStore(workspace);
    const message: Message = {
      id: "msg_fixed",
      session_id: meta.session_id,
      turn_id: "turn_old",
      role: "user",
      name: TASK_NOTIFICATION_NAME,
      content: "后台任务完成。这是完成回执，不是用户的新指令。\n- subagent_a（未挂任务）已结束：saved",
      created_at: nowIso(),
    };
    await store.appendMessage(message);
    await store.appendMessage({
      id: "msg_answer",
      session_id: meta.session_id,
      turn_id: "turn_old",
      role: "assistant",
      content: "already answered",
      created_at: nowIso(),
    });
    await inbox.append(meta.session_id, {
      op: "enqueue",
      id: "note_1",
      subagent_id: "subagent_a",
      content: "saved",
      ok: true,
      created_at: nowIso(),
    });
    await inbox.append(meta.session_id, {
      op: "claim",
      message_id: "msg_fixed",
      turn_id: "turn_old",
      ids: ["note_1"],
      created_at: nowIso(),
    });
    await rt.watchSession(meta.session_id);
    expect(calls).toBe(0);
    const stored = await rt.loadMessages(meta.session_id);
    expect(stored.filter((item) => item.id === "msg_fixed")).toHaveLength(1);
    expect(await inbox.hasPending(meta.session_id)).toBe(false);
  });
});

function assistant(content: string): Message {
  return {
    id: "msg_assistant",
    session_id: "sess_inbox",
    turn_id: "turn_old",
    role: "assistant",
    content,
    created_at: "t3",
  };
}

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (ready()) {
        resolve();
        return;
      }
      if (Date.now() - start > 2000) {
        reject(new Error("timed out"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}
