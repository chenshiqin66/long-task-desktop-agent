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
});
