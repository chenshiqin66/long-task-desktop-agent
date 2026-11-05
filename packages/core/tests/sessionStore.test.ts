import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, sessionDir } from "../src/store/sessionStore.js";
import { TraceStore } from "../src/store/traceStore.js";
import { newId, nowIso } from "../src/ids.js";
import type { Message } from "../src/types.js";

describe("SessionStore", () => {
  let workspace: string;
  let store: SessionStore;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    store = new SessionStore(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("createSession writes meta under .agent/sessions/{id}/meta.json", async () => {
    const meta = await store.createSession("demo");
    expect(meta.session_id).toMatch(/^sess_/);
    expect(meta.workspace_path).toBe(workspace);
    expect(meta.title).toBe("demo");
    const raw = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "meta.json"),
      "utf8",
    );
    expect(JSON.parse(raw).session_id).toBe(meta.session_id);
  });

  it("appendMessage and readMessages round-trip jsonl", async () => {
    const meta = await store.createSession();
    const msg: Message = {
      id: newId("msg"),
      session_id: meta.session_id,
      turn_id: newId("turn"),
      role: "user",
      content: "hello",
      created_at: nowIso(),
    };
    await store.appendMessage(msg);
    const msgs = await store.readMessages(meta.session_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(msg);
  });

  it("listSessions returns created sessions", async () => {
    const a = await store.createSession("a");
    const b = await store.createSession("b");
    const list = await store.listSessions();
    const ids = list.map((m) => m.session_id).sort();
    expect(ids).toEqual([a.session_id, b.session_id].sort());
  });

  it("appendMessage throws when session missing", async () => {
    await expect(
      store.appendMessage({
        id: newId("msg"),
        session_id: "sess_missing",
        turn_id: newId("turn"),
        role: "user",
        content: "x",
        created_at: nowIso(),
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects path-traversal sessionId and does not create files outside .agent/sessions/", async () => {
    const evilIds = ["../evil", "../../evil", "..%2fevil", "sess/../x", "a/b", "sess with space"];
    for (const id of evilIds) {
      expect(() => sessionDir(workspace, id)).toThrow(/invalid session/i);
    }

    const traces = new TraceStore(workspace);
    await expect(
      traces.append({
        session_id: "../../evil",
        turn_id: "turn_x",
        type: "turn_start",
      }),
    ).rejects.toThrow(/invalid session/i);

    await expect(access(join(workspace, "evil"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(workspace, "..", "evil"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sessionDir accepts generated sess_ ids", async () => {
    const meta = await store.createSession();
    const dir = sessionDir(workspace, meta.session_id);
    expect(dir).toBe(join(workspace, ".agent", "sessions", meta.session_id));
  });

  it("renameSession updates title in meta.json", async () => {
    const meta = await store.createSession("old");
    const updated = await store.renameSession(meta.session_id, "new title");
    expect(updated.title).toBe("new title");
    const raw = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "meta.json"),
      "utf8",
    );
    expect(JSON.parse(raw).title).toBe("new title");
  });

  it("deleteSession removes session directory", async () => {
    const meta = await store.createSession("gone");
    await store.deleteSession(meta.session_id);
    await expect(access(join(workspace, ".agent", "sessions", meta.session_id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const list = await store.listSessions();
    expect(list.find((m) => m.session_id === meta.session_id)).toBeUndefined();
  });
});
