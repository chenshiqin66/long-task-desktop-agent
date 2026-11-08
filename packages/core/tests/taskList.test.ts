import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig, Message, RuntimeEvent } from "../src/types.js";
import { shouldRemindTasks, TASK_REMINDER_EVERY } from "../src/context/taskReminder.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { ToolHost, createBuiltinTools } from "../src/tools/host.js";
import type { ToolContext } from "../src/tools/types.js";
import { TaskStore, tasksDir } from "../src/store/taskStore.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
  };
}

async function* chunks(parts: LlmStreamChunk[]): AsyncIterable<LlmStreamChunk> {
  for (const part of parts) yield part;
}

describe("task list", () => {
  let workspace: string;
  const sessionId = "sess_tasks";
  let store: TaskStore;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-tasks-"));
    store = TaskStore.forSession(workspace, sessionId);
  });

  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("writes one json file per task and does not reuse a deleted id", async () => {
    const first = await store.create({
      subject: "Write schema",
      description: "Add the users table.",
    });
    const second = await store.create({
      subject: "Add the API",
      description: "Serve the users table.",
      blockedBy: ["1"],
    });
    expect(first.ok && first.value.id).toBe("1");
    expect(second.ok && second.value.blockedBy).toEqual(["1"]);
    const blocker = JSON.parse(await readFile(join(tasksDir(workspace, sessionId), "1.json"), "utf8")) as {
      blocks: string[];
    };
    expect(blocker.blocks).toEqual(["2"]);
    expect(await store.delete("1")).toMatchObject({ ok: true });
    const names = await readdir(tasksDir(workspace, sessionId));
    expect(names).not.toContain("1.json");
    const third = await store.create({
      subject: "Cover the API",
      description: "Test the users endpoint.",
    });
    expect(third.ok && third.value.id).toBe("3");
    const survivor = await store.get("2");
    expect(survivor.ok && survivor.value.blockedBy).toEqual([]);
  });

  it("lets one claim win, then complete releases the next task", async () => {
    await store.create({ subject: "Write schema", description: "Add the users table." });
    await store.create({
      subject: "Add the API",
      description: "Serve the users table.",
      blockedBy: [1],
    });
    const early = await store.claim("2", "main");
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toMatch(/blocked by #1/);

    const [left, right] = await Promise.all([store.claim("1", "alpha"), store.claim("1", "beta")]);
    const wins = [left, right].filter((result) => result.ok);
    expect(wins).toHaveLength(1);
    const owner = left.ok ? left.value.owner : right.ok ? right.value.owner : "";
    expect(await store.claim("1", "gamma")).toMatchObject({ ok: false });

    const wrong = await store.complete("1", owner === "alpha" ? "beta" : "alpha");
    expect(wrong.ok).toBe(false);
    const done = await store.complete("1", owner);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.unblocked.map((task) => task.id)).toEqual(["2"]);

    const claimed = await store.claim("2", "main");
    expect(claimed.ok).toBe(true);
    const onDisk = JSON.parse(await readFile(join(tasksDir(workspace, sessionId), "2.json"), "utf8")) as {
      blockedBy: string[];
      status: string;
    };
    expect(onDisk.blockedBy).toEqual(["1"]);
    expect(onDisk.status).toBe("in_progress");
  });

  it("rejects a dependency cycle and a claim that is still blocked", async () => {
    await store.create({ subject: "Write schema", description: "Add the users table." });
    await store.create({ subject: "Add the API", description: "Serve the users table.", blockedBy: ["1"] });
    const cycle = await store.update({ id: "1", addBlockedBy: ["2"] });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error).toMatch(/cycle/);
    const self = await store.update({ id: "1", addBlockedBy: ["1"] });
    expect(self.ok).toBe(false);

    const [first, second] = await Promise.all([store.claim("1", "main"), store.claim("2", "other")]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/blocked by #1/);
    await store.complete("1", "main");
    expect((await store.claim("2", "other")).ok).toBe(true);
    const frozen = await store.update({ id: "2", addBlockedBy: ["1"] });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error).toMatch(/pending/);
  });

  it("lists open blockers only, and file tools cannot overwrite the json", async () => {
    const host = new ToolHost(createBuiltinTools());
    const ctx: ToolContext = {
      workspacePath: workspace,
      sessionId,
      bashTimeoutMs: 5_000,
      maxToolOutputChars: 4_000,
      maxReadChars: 4_000,
      maxSearchResults: 10,
    };
    const created = await host.execute(
      "task_create",
      JSON.stringify({ subject: "Write schema", description: "Add the users table." }),
      ctx,
    );
    expect(created.is_error).toBe(false);
    await host.execute(
      "task_create",
      JSON.stringify({
        subject: "Add the API",
        description: "Serve the users table.",
        blocked_by: ["#1"],
      }),
      ctx,
    );
    await host.execute("claim_task", JSON.stringify({ task_id: "1" }), ctx);
    await host.execute("complete_task", JSON.stringify({ task_id: 1 }), ctx);
    const listed = await host.execute("task_list", "{}", ctx);
    expect(listed.content).toContain("#1 [completed] Write schema (main)");
    expect(listed.content).toContain("#2 [pending] Add the API");
    expect(listed.content).not.toContain("blocked by");

    const got = await host.execute("task_get", JSON.stringify({ task_id: "#2" }), ctx);
    expect(got.content).toContain("#1 [completed]");
    expect(got.content).toContain("open blockers: (none)");

    const overwrite = await host.execute(
      "write_file",
      JSON.stringify({
        path: `.agent/sessions/${sessionId}/tasks/1.json`,
        content: "{}",
      }),
      ctx,
    );
    expect(overwrite.is_error).toBe(true);
    expect(overwrite.content).toMatch(/\.agent/);
    const removed = await host.execute(
      "delete_file",
      JSON.stringify({ path: `.agent/sessions/${sessionId}/tasks/2.json` }),
      ctx,
    );
    expect(removed.is_error).toBe(true);
    expect(await host.execute("claim_task", "{}", ctx)).toMatchObject({ is_error: true });
    const noSession = await host.execute("task_list", "{}", { ...ctx, sessionId: undefined });
    expect(noSession.content).toMatch(/parent session/);
  });

  it("refuses a status edit and an unreadable file", async () => {
    const host = new ToolHost(createBuiltinTools());
    const ctx: ToolContext = {
      workspacePath: workspace,
      sessionId,
      bashTimeoutMs: 5_000,
      maxToolOutputChars: 4_000,
      maxReadChars: 4_000,
      maxSearchResults: 10,
    };
    await host.execute(
      "task_create",
      JSON.stringify({ subject: "Write schema", description: "Add the users table." }),
      ctx,
    );
    const status = await host.execute(
      "task_update",
      JSON.stringify({ task_id: "1", status: "completed" }),
      ctx,
    );
    expect(status.is_error).toBe(true);
    expect(status.content).toMatch(/claim_task/);
    const dir = tasksDir(workspace, sessionId);
    await writeFile(join(dir, "2.json"), "{", "utf8");
    const blocked = await store.create({ subject: "Add the API", description: "Serve the users table." });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/Unreadable/);
  });

  it("persists a task when the parent calls task_create", async () => {
    let calls = 0;
    let sawCreated = false;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        if (calls === 1) {
          return chunks([
            {
              type: "tool_call_delta",
              tool_call: {
                id: "c1",
                type: "function",
                function: {
                  name: "task_create",
                  arguments: JSON.stringify({
                    subject: "Write schema",
                    description: "Add the users table.",
                  }),
                },
              },
            },
          ]);
        }
        const tool = req.messages.find((message) => message.role === "tool");
        sawCreated = typeof tool?.content === "string" && tool.content.includes("Created #1");
        return chunks([{ type: "text", text: "recorded" }]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession("tasks");
    await rt.submit(meta.session_id, "plan the schema work");
    expect(sawCreated).toBe(true);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
    const raw = await readFile(join(tasksDir(workspace, meta.session_id), "1.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      id: "1",
      status: "pending",
      subject: "Write schema",
    });
    const rootTasks = readdir(join(workspace, "tasks")).catch(() => []);
    expect(await rootTasks).toEqual([]);
  });

  it("claims an assigned task as the subagent, and does not start a blocked one", async () => {
    const textOf = (req: LlmChatRequest): string =>
      req.messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        const system = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const body = textOf(req);
        if (system.includes("You are an explore subagent")) {
          if (body.includes("Task #2")) throw new Error("blocked task must not start");
          const done = req.messages.some((message) => message.role === "tool");
          if (!done) {
            return chunks([
              {
                type: "tool_call_delta",
                tool_call: {
                  id: "done1",
                  type: "function",
                  function: { name: "complete_task", arguments: JSON.stringify({ task_id: "1" }) },
                },
              },
            ]);
          }
          return chunks([{ type: "text", text: "schema recorded" }]);
        }
        const latest = [...req.messages].reverse().find((message) => message.role === "user");
        const taskId = latest?.content === "assign the blocked one" ? "2" : "1";
        const answered = req.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === (taskId === "2" ? "blocked" : "assigned"),
        );
        if (answered) return chunks([{ type: "text", text: "recorded" }]);
        const id = taskId === "2" ? "blocked" : "assigned";
        return chunks([
          {
            type: "tool_call_delta",
            tool_call: {
              id,
              type: "function",
              function: {
                name: "subagent",
                arguments: JSON.stringify({
                  description: taskId === "2" ? "add the api" : "write schema",
                  subagent_type: "explore",
                  task: taskId === "2" ? "Describe the API." : "Describe the users table.",
                  task_id: taskId,
                }),
              },
            },
          },
        ]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("assign");
    const tasks = TaskStore.forSession(workspace, meta.session_id);
    await tasks.create({ subject: "Write schema", description: "Add the users table." });
    await tasks.create({
      subject: "Add the API",
      description: "Serve the users table.",
      blockedBy: ["1"],
    });
    await rt.submit(meta.session_id, "assign the blocked one");
    let messages = await rt.loadMessages(meta.session_id);
    const blocked = messages.find((message) => message.role === "tool" && message.tool_call_id === "blocked");
    expect(blocked?.is_error).toBe(true);
    expect(blocked?.content).toMatch(/blocked by #1/);
    expect((await tasks.get("2")).ok && (await tasks.get("2")).value).toMatchObject({ status: "pending" });

    await rt.submit(meta.session_id, "assign the schema");
    messages = await rt.loadMessages(meta.session_id);
    const receipt = messages.find((message) => message.role === "tool" && message.tool_call_id === "assigned");
    expect(receipt?.is_error).toBe(false);
    const finished = await tasks.get("1");
    expect(finished.ok && finished.value.status).toBe("completed");
    expect(finished.ok && finished.value.owner).toMatch(/^subagent_/);
    const still = await tasks.get("2");
    expect(still.ok && still.value).toMatchObject({ status: "pending", blockedBy: ["1"] });
  });

  it("returns a claimed task to pending when the subagent errors", async () => {
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        const system = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (system.includes("You are an explore subagent")) {
          throw new Error("boom");
        }
        const again = req.messages.some((message) => message.role === "tool");
        if (!again) {
          return chunks([
            {
              type: "tool_call_delta",
              tool_call: {
                id: "boom",
                type: "function",
                function: {
                  name: "subagent",
                  arguments: JSON.stringify({
                    description: "write schema",
                    subagent_type: "explore",
                    task: "Describe the users table.",
                    task_id: "1",
                  }),
                },
              },
            },
          ]);
        }
        return chunks([{ type: "text", text: "stopped" }]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("release");
    const tasks = TaskStore.forSession(workspace, meta.session_id);
    await tasks.create({ subject: "Write schema", description: "Add the users table." });
    await rt.submit(meta.session_id, "try the schema");
    const messages = await rt.loadMessages(meta.session_id);
    const receipt = messages.find((message) => message.role === "tool");
    expect(receipt?.is_error).toBe(true);
    expect(receipt?.content).toMatch(/Released back to pending: #1/);
    const task = await tasks.get("1");
    expect(task.ok && task.value.status).toBe("pending");
    expect(task.ok && task.value.owner).toBeUndefined();
  });

  it("shows open tasks again after ten replies that did not touch them", async () => {
    const blanks = (n: number, tool?: string): Message[] =>
      Array.from({ length: n }, (_, index) => ({
        id: `m${index}`,
        session_id: "sess_tasks",
        turn_id: "turn",
        role: "assistant" as const,
        content: "ok",
        created_at: "t",
        ...(tool && index === 0
          ? {
              tool_calls: [
                { id: "c", type: "function" as const, function: { name: tool, arguments: "{}" } },
              ],
            }
          : {}),
      }));
    expect(
      shouldRemindTasks({ messages: blanks(TASK_REMINDER_EVERY - 1), openTaskCount: 1, assistantCountAtLastReminder: null }),
    ).toBe(false);
    expect(
      shouldRemindTasks({ messages: blanks(TASK_REMINDER_EVERY), openTaskCount: 1, assistantCountAtLastReminder: null }),
    ).toBe(true);
    expect(
      shouldRemindTasks({ messages: blanks(TASK_REMINDER_EVERY), openTaskCount: 0, assistantCountAtLastReminder: null }),
    ).toBe(false);
    expect(
      shouldRemindTasks({
        messages: blanks(TASK_REMINDER_EVERY, "claim_task"),
        openTaskCount: 1,
        assistantCountAtLastReminder: null,
      }),
    ).toBe(false);

    let reminded = false;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        const system = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (system.includes("Task reminder")) reminded = true;
        return chunks([{ type: "text", text: "ok" }]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("remind");
    await TaskStore.forSession(workspace, meta.session_id).create({
      subject: "Write schema",
      description: "Add the users table.",
    });
    for (let i = 0; i < TASK_REMINDER_EVERY; i++) await rt.submit(meta.session_id, "continue");
    expect(reminded).toBe(false);
    await rt.submit(meta.session_id, "continue");
    expect(reminded).toBe(true);
  });
});
