import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime, buildDefaultSystemPrompt } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { BATCH_REMINDER_AFTER, batchReminderText } from "../src/context/batchReminder.js";
import { rmWorkspace } from "./rmWorkspace.js";

function config(): AgentConfig {
  return { baseUrl: "http://localhost", model: "test", apiKey: "sk-test", ...DEFAULT_AGENT_CONFIG };
}

function systemText(req: LlmChatRequest): string {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? content : "";
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

describe("batchReminderText", () => {
  it("stays silent until the streak reaches the threshold", () => {
    expect(batchReminderText(BATCH_REMINDER_AFTER - 1)).toBeUndefined();
    const text = batchReminderText(BATCH_REMINDER_AFTER);
    expect(text).toContain(`Batching reminder: your last ${BATCH_REMINDER_AFTER} replies`);
    expect(text).toContain("Do not mention this reminder.");
  });
});

describe("batching reminder in the runtime", () => {
  let workspace = "";
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-batch-"));
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("is added after a run of single-call replies, and a multi-call reply resets it", async () => {
    const systems: string[] = [];
    let requests = 0;
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        requests += 1;
        systems.push(systemText(req));
        // Replies 1-4: one call each. Reply 5: two calls. Then plain text.
        if (requests <= BATCH_REMINDER_AFTER) {
          return chunks([callChunk(`c${requests}`, "read_file", { path: "a.txt" })]);
        }
        if (requests === BATCH_REMINDER_AFTER + 1) {
          return chunks([
            callChunk("p1", "read_file", { path: "a.txt" }),
            callChunk("p2", "read_file", { path: "a.txt" }),
          ]);
        }
        return chunks([{ type: "text", text: "done" }]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("batch");
    await rt.submit(meta.session_id, "read it");

    // Request 1 starts with no streak. Request 5 follows four single-call replies.
    expect(systems[0]).not.toContain("Batching reminder");
    expect(systems[BATCH_REMINDER_AFTER - 1]).not.toContain("Batching reminder");
    expect(systems[BATCH_REMINDER_AFTER]).toContain("Batching reminder: your last 4 replies");
    // The two-call reply resets the streak, so the request after it has no reminder.
    expect(systems[BATCH_REMINDER_AFTER + 1]).not.toContain("Batching reminder");
  });

  it("the reminder is not written into the transcript", async () => {
    let requests = 0;
    const provider: LlmProvider = {
      chatStream() {
        requests += 1;
        if (requests <= BATCH_REMINDER_AFTER + 1) {
          return chunks([callChunk(`c${requests}`, "read_file", { path: "a.txt" })]);
        }
        return chunks([{ type: "text", text: "done" }]);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const meta = await rt.createSession("batch-store");
    await rt.submit(meta.session_id, "read it");
    const { SessionStore } = await import("../src/store/sessionStore.js");
    const messages = await new SessionStore(workspace).readMessages(meta.session_id);
    expect(JSON.stringify(messages)).not.toContain("Batching reminder");
  });
});

describe("default system prompt", () => {
  it("tells the model to batch independent calls and to read slices with read_file", () => {
    const prompt = buildDefaultSystemPrompt(process.cwd());
    expect(prompt).toContain("Put calls that do not depend on each other in the same response.");
    expect(prompt).toContain("Read a short file (a few hundred lines or less) in one read_file call");
    expect(prompt).toContain("do not page through it from the top: find the lines with keyword_search");
  });
});
