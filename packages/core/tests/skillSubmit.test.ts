import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { installSkill } from "../src/skills/installedSkills.js";
import type { LlmChatRequest, LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "../src/types.js";

function config(): AgentConfig {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
  };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
  yield { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

describe("skill bodies on submit", () => {
  let workspace: string;
  let skillsRoot: string;
  let source: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    skillsRoot = await mkdtemp(join(tmpdir(), "agent-skills-"));
    source = await mkdtemp(join(tmpdir(), "agent-skill-src-"));
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: demo\ndescription: Make slides.\n---\nDo the thing.\n",
      "utf8",
    );
    await installSkill(source, skillsRoot);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsRoot, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  it("attaches the body for one submit only and rejects an unknown token before persisting", async () => {
    const systems: string[] = [];
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        const system = req.messages[0]?.content;
        systems.push(typeof system === "string" ? system : "");
        return textOnly("ok");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot });
    const session = await rt.createSession("t");
    await expect(rt.submit(session.session_id, "use /missing")).rejects.toThrow(/未知技能 \/missing/);
    expect(await rt.loadMessages(session.session_id)).toEqual([]);

    await rt.submit(session.session_id, "please /demo");
    await rt.submit(session.session_id, "next");
    const messages = await rt.loadMessages(session.session_id);
    expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "please /demo",
      "next",
    ]);
    expect(systems[0]).toContain("# Skill body: demo");
    expect(systems[0]).toContain("Do the thing.");
    expect(systems[1]).not.toContain("# Skill body:");
    expect(systems[1]).toContain("# Installed skills");
  });

  it("sends a message that only mentions an absolute path", async () => {
    const provider: LlmProvider = { chatStream: () => textOnly("ok") };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot });
    const session = await rt.createSession("t");
    await rt.submit(session.session_id, "看看 /etc/hosts");
    const messages = await rt.loadMessages(session.session_id);
    expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "看看 /etc/hosts",
    ]);
  });

  it("attaches a skill mentioned in a message held during a completion notice", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const systems: string[] = [];
    const provider: LlmProvider = {
      chatStream(req: LlmChatRequest) {
        calls += 1;
        const system = req.messages[0]?.content;
        systems.push(typeof system === "string" ? system : "");
        if (calls === 1) {
          return (async function* () {
            yield { type: "text" as const, text: "ack" };
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          })();
        }
        return textOnly("next");
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider, skillsRoot });
    const session = await rt.createSession("held");
    await rt.watchSession(session.session_id);
    const running = rt.postTaskNotification(session.session_id, {
      subagentId: "subagent_a",
      content: "receipt mentions /demo but is not a user request",
      ok: true,
    });
    const started = Date.now();
    while (calls !== 1 || release == null) {
      if (Date.now() - started > 2_000) throw new Error("wake did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await rt.submit(session.session_id, "please /demo and /missing");
    release!();
    await running;
    expect(calls).toBe(2);
    expect(systems[0]).not.toContain("# Skill body:");
    expect(systems[1]).toContain("# Skill body: demo");
    expect(systems[1]).toContain("Do the thing.");
    expect(systems[1]).not.toContain("# Skill body: missing");
  });
});
