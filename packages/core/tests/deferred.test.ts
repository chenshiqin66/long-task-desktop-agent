import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { TaskStore } from "../src/store/taskStore.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { InboxStore } from "../src/store/inboxStore.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return { baseUrl: "http://localhost", model: "test", apiKey: "sk-test", ...DEFAULT_AGENT_CONFIG };
}

function systemText(req: LlmChatRequest): string {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

function userText(req: LlmChatRequest): string {
  const content = req.messages.at(-1)?.content;
  return typeof content === "string" ? content : "";
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
    tool_call: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
  };
}

function doneAfter(rt: AgentRuntime, count: number): Promise<void> {
  let seen = 0;
  return new Promise((resolve) => {
    rt.onEvent((event) => {
      if (event.type !== "done") return;
      seen += 1;
      if (seen >= count) resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

describe("deferred subagent", () => {
  let workspace = "";
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-deferred-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("accepts immediately and posts the receipt after a stopped turn", async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let sawReceipt!: () => void;
    const receiptSeen = new Promise<void>((resolve) => {
      sawReceipt = resolve;
    });
    let parentCalls = 0;
    let rt!: AgentRuntime;
    const provider: LlmProvider = {
      chatStream: (req) => {
        if (systemText(req).includes("You are an explore subagent")) {
          return (async function* () {
            await childGate;
            yield textChunk("the login is in auth.ts");
          })();
        }
        parentCalls += 1;
        const text = userText(req);
        if (parentCalls === 1) {
          return chunks([
            callChunk("call_sub", "subagent", {
              description: "read later",
              subagent_type: "explore",
              task: "Find the login check.",
              task_id: "1",
              delivery: "deferred",
            }),
          ]);
        }
        if (text.includes("后台任务完成")) {
          sawReceipt();
          return chunks([textChunk("ack")]);
        }
        rt.cancel();
        return chunks([textChunk("stopping")]);
      },
    };
    rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const settled = doneAfter(rt, 2);
    const meta = await rt.createSession();
    await TaskStore.forSession(workspace, meta.session_id).create({
      subject: "find login",
      description: "Where is the check?",
    });
    try {
      await rt.watchSession(meta.session_id);
      await rt.submit(meta.session_id, "start deferred");
      const midway = await new SessionStore(workspace).readMessages(meta.session_id);
      const acceptance = midway.find((message) => message.role === "tool");
      expect(acceptance?.content).toContain("Accepted");
      expect(acceptance?.content).toContain("Task #1 is claimed");
      expect(acceptance?.content).not.toContain("auth.ts");
      expect(acceptance?.content).not.toContain("Released back to pending");
      releaseChild();
      await withTimeout(receiptSeen, "receipt");
      await withTimeout(settled, "wake done");
    } finally {
      releaseChild();
    }
    const done = await new SessionStore(workspace).readMessages(meta.session_id);
    const notice = done.find((message) => message.name === "task-notification");
    expect(notice?.content).toContain("the login is in auth.ts");
    expect(notice?.content).toContain("Released back to pending: #1");
    expect(notice?.content).not.toContain("Cancelled: subagent stopped");
    const task = await TaskStore.forSession(workspace, meta.session_id).get("1");
    expect(task.ok && task.value.status).toBe("pending");
  });

  it("keeps a deferred output_dir locked until the receipt is in the transcript", async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let parentCalls = 0;
    let afterReceipt = false;
    let rt!: AgentRuntime;
    const provider: LlmProvider = {
      chatStream: (req) => {
        if (systemText(req).includes("You are a worker subagent")) {
          return (async function* () {
            await childGate;
            yield textChunk("page is drafted");
          })();
        }
        parentCalls += 1;
        const text = userText(req);
        if (parentCalls === 1) {
          return chunks([
            callChunk("call_worker", "subagent", {
              description: "draft the page",
              subagent_type: "worker",
              task: "Write the notes page.",
              output_dir: "docs/notes",
              delivery: "deferred",
            }),
          ]);
        }
        if (text.includes("后台任务完成")) {
          afterReceipt = true;
          return chunks([
            callChunk("call_write_2", "write_file", { path: "docs/notes/page.txt", content: "parent edit" }),
          ]);
        }
        if (afterReceipt) return chunks([textChunk("done")]);
        if (parentCalls === 2) {
          return chunks([
            callChunk("call_write_1", "write_file", { path: "docs/notes/page.txt", content: "too soon" }),
          ]);
        }
        return chunks([textChunk("done")]);
      },
    };
    rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const settled = doneAfter(rt, 2);
    const meta = await rt.createSession();
    try {
      await rt.watchSession(meta.session_id);
      await rt.submit(meta.session_id, "draft later");
      const midway = await new SessionStore(workspace).readMessages(meta.session_id);
      const blocked = midway.filter((message) => message.role === "tool").map((message) => message.content);
      expect(blocked.some((content) => content.includes("still in use"))).toBe(true);
      await expect(readFile(join(workspace, "docs", "notes", "page.txt"), "utf8")).rejects.toThrow();
      releaseChild();
      await withTimeout(settled, "wake done");
    } finally {
      releaseChild();
    }
    expect(await readFile(join(workspace, "docs", "notes", "page.txt"), "utf8")).toBe("parent edit");
  });

  it("deleting a session stops its deferred subagent and leaves nothing behind", async () => {
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream: (req) => {
        if (systemText(req).includes("You are an explore subagent")) {
          return (async function* () {
            childStarted();
            await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("aborted");
          })();
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("call_sub", "subagent", {
              description: "read later",
              subagent_type: "explore",
              task: "Find the login check.",
              task_id: "1",
              delivery: "deferred",
            }),
          ]);
        }
        return chunks([textChunk("waiting")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession();
    await TaskStore.forSession(workspace, meta.session_id).create({
      subject: "find login",
      description: "Where is the check?",
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await rt.submit(meta.session_id, "start deferred");
      await withTimeout(started, "child start");
      await rt.deleteSession(meta.session_id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(access(join(workspace, ".agent", "sessions", meta.session_id))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("does not enqueue a receipt for a joined subagent", async () => {
    let parentCalls = 0;
    const provider: LlmProvider = {
      chatStream: (req) => {
        if (systemText(req).includes("You are an explore subagent")) {
          return chunks([textChunk("joined report")]);
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return chunks([
            callChunk("call_joined", "subagent", {
              description: "read now",
              subagent_type: "explore",
              task: "Find the login check.",
            }),
          ]);
        }
        return chunks([textChunk("done")]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession();
    await rt.watchSession(meta.session_id);
    await rt.submit(meta.session_id, "join");
    const messages = await new SessionStore(workspace).readMessages(meta.session_id);
    expect(messages.some((message) => message.role === "tool" && message.content.includes("joined report"))).toBe(true);
    expect(messages.some((message) => message.name === "task-notification")).toBe(false);
    expect(await new InboxStore(workspace).read(meta.session_id)).toEqual([]);
  });
});
