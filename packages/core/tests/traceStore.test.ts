import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store/sessionStore.js";
import { TraceStore } from "../src/store/traceStore.js";

describe("TraceStore", () => {
  let workspace: string;
  let sessions: SessionStore;
  let traces: TraceStore;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    sessions = new SessionStore(workspace);
    traces = new TraceStore(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("appends trace events linked by session_id and turn_id", async () => {
    const meta = await sessions.createSession();
    const turn_id = "turn_abc";
    const ev = await traces.append({
      session_id: meta.session_id,
      turn_id,
      type: "llm_request",
      token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(ev.id.startsWith("trace_")).toBe(true);
    expect(ev.timestamp).toBeTruthy();
    const all = await traces.read(meta.session_id);
    expect(all).toHaveLength(1);
    expect(all[0].turn_id).toBe(turn_id);
    expect(all[0].token_usage?.total_tokens).toBe(15);
  });

  it("records cancel events", async () => {
    const meta = await sessions.createSession();
    await traces.append({
      session_id: meta.session_id,
      turn_id: "turn_1",
      type: "cancel",
      detail: { reason: "user" },
    });
    const all = await traces.read(meta.session_id);
    expect(all[0].type).toBe("cancel");
  });
});
