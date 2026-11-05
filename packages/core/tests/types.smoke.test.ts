import { describe, it, expect } from "vitest";
import { newId, nowIso } from "../src/ids.js";
import type { Message, SessionMeta, RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";

describe("ids", () => {
  it("newId returns prefix_ plus unique suffix", () => {
    const a = newId("msg");
    const b = newId("msg");
    expect(a.startsWith("msg_")).toBe(true);
    expect(b.startsWith("msg_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("nowIso returns ISO-8601 string", () => {
    const s = nowIso();
    expect(new Date(s).toISOString()).toBe(s);
  });
});

describe("types compile shape", () => {
  it("Message and SessionMeta accept required fields", () => {
    const meta: SessionMeta = {
      session_id: "sess_1",
      workspace_path: "/tmp/ws",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const msg: Message = {
      id: "msg_1",
      session_id: meta.session_id,
      turn_id: "turn_1",
      role: "user",
      content: "hi",
      created_at: nowIso(),
    };
    const ev: RuntimeEvent = { type: "done", turn_id: "turn_1", reason: "completed" };
    const cfg: AgentConfig = {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-test",
      apiKey: "sk-test",
      ...DEFAULT_AGENT_CONFIG,
    };
    expect(msg.role).toBe("user");
    expect(ev.type).toBe("done");
    expect(cfg.maxSteps).toBe(50);
  });
});
