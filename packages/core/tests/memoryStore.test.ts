import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, type MemoryWrite } from "../src/memory/store.js";
import { LockTimeoutError } from "../src/store/fileLock.js";
import { rmWorkspace } from "./rmWorkspace.js";

const SOURCE = { workspace: "D:\\work\\demo", session: "sess_1", message: "msg_1" };
const NOTE: MemoryWrite = {
  scope: "project",
  name: "run-root-start",
  type: "feedback",
  description: "改了 core 之后用根目录的 npm start",
  body: "改了 packages/core 之后，用根目录的 `npm start`。",
};
const BY_EXTRACTOR = { actor: "extractor" as const, origin: "extracted" as const, secrets: [] };

describe("MemoryStore", () => {
  let base: string;
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-memstore-"));
    home = join(base, "home");
    workspace = join(base, "ws");
    await mkdir(join(workspace, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  function store(): MemoryStore {
    return new MemoryStore({ workspacePath: workspace, home });
  }

  it("creates a note with every field and logs one journal line", async () => {
    const s = store();
    expect((await s.upsert(NOTE, { ...BY_EXTRACTOR, source: SOURCE })).ok).toBe(true);
    const dir = (await s.dir("project"))!;
    const text = await readFile(join(dir, "run-root-start.md"), "utf8");
    expect(text).toMatch(
      /^---\nname: run-root-start\ndescription: 改了 core 之后用根目录的 npm start\ntype: feedback\ncreated: .+\nmodified: .+\norigin: extracted\nsource_workspace: D:\\work\\demo\nsource_session: sess_1\nsource_message: msg_1\n---\n改了 packages\/core/,
    );
    const journal = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ op: "create", name: "run-root-start", actor: "extractor", before: null, after: text, source: SOURCE });
    expect(journal[0].id).toMatch(/^memj_/);
    const project = JSON.parse(await readFile(join(dir, "..", "project.json"), "utf8"));
    expect(project).toMatchObject({ root: workspace, is_git: true });
  });

  it("keeps created when it overwrites a note and logs the old text", async () => {
    const s = store();
    await s.upsert(NOTE, BY_EXTRACTOR);
    const first = (await s.list()).entries[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await s.upsert({ ...NOTE, body: "新的正文。" }, BY_EXTRACTOR);
    expect(again.ok && again.value.op).toBe("update");
    expect(again.ok && again.value.before).toContain("改了 packages/core");
    const second = (await s.list()).entries[0]!;
    expect(second.created).toBe(first.created);
    expect(second.modified > first.modified).toBe(true);
    expect(second.body).toBe("新的正文。");
  });

  it("edits description and body from the memory page and marks the note edited", async () => {
    const s = store();
    await s.upsert(NOTE, { ...BY_EXTRACTOR, source: SOURCE });
    const edited = await s.edit("project", "run-root-start", { description: "改 core 后用根目录启动", body: "用根目录的 npm start。" }, { secrets: [] });
    expect(edited.ok && edited.value.actor).toBe("user");
    expect((await s.list()).entries[0]).toMatchObject({ origin: "edited", type: "feedback", description: "改 core 后用根目录启动", source: SOURCE });
    expect(await s.edit("project", "missing-note", { description: "d", body: "b" }, { secrets: [] })).toMatchObject({ ok: false });
  });

  it("deletes a note and logs the text it removed", async () => {
    const s = store();
    await s.upsert(NOTE, BY_EXTRACTOR);
    const removed = await s.remove("project", "run-root-start", { actor: "user" });
    expect(removed.ok && removed.value).toMatchObject({ op: "delete", after: null });
    expect((await s.list()).entries).toEqual([]);
    expect((await s.remove("project", "run-root-start", { actor: "user" })).ok).toBe(false);
  });

  it("enforces name, type and scope rules", async () => {
    const s = store();
    expect(await s.upsert({ ...NOTE, type: "user" }, BY_EXTRACTOR)).toMatchObject({ ok: false });
    expect(await s.upsert({ ...NOTE, scope: "user", type: "project" }, BY_EXTRACTOR)).toMatchObject({ ok: false });
    expect(await s.upsert({ ...NOTE, name: "Run Root" }, BY_EXTRACTOR)).toMatchObject({ ok: false });
    expect(await s.upsert({ ...NOTE, body: "   " }, BY_EXTRACTOR)).toMatchObject({ ok: false });
    expect(await s.remove("project", "../escape", { actor: "user" })).toMatchObject({ ok: false });
    expect((await s.list()).entries).toEqual([]);
  });

  it("rejects the three kinds of secrets and writes nothing", async () => {
    const s = store();
    for (const body of [
      "the key is configured-secret-value",
      "call https://api.example.com/v1?api_key=abcdef123456",
      `token ghp_${"a".repeat(30)}`,
    ]) {
      const result = await s.upsert({ ...NOTE, body }, { ...BY_EXTRACTOR, secrets: ["configured-secret-value"] });
      expect(result).toMatchObject({ ok: false });
    }
    expect(await readdir((await s.dir("project"))!).catch(() => [])).not.toContain("journal.jsonl");
  });

  it("reads a hand-written note with only description, type and body", async () => {
    const dir = join(home, "memory");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "reply-language.md");
    await writeFile(path, "\uFEFF---\ndescription: 回复用中文，代码注释和提交信息用英文\ntype: user\n---\n回复用中文。代码注释和提交信息用英文。\n", "utf8");
    const when = new Date("2026-11-05T08:00:00.000Z");
    await utimes(path, when, when);
    expect((await store().list()).entries).toEqual([
      {
        scope: "user",
        name: "reply-language",
        description: "回复用中文，代码注释和提交信息用英文",
        type: "user",
        created: when.toISOString(),
        modified: when.toISOString(),
        origin: "manual",
        body: "回复用中文。代码注释和提交信息用英文。",
      },
    ]);
  });

  it("lists invalid files as unreadable with a reason and keeps the rest", async () => {
    const dir = join(home, "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "good.md"), "---\ndescription: ok\ntype: user\n---\nfine\n", "utf8");
    await writeFile(join(dir, "Bad Name.md"), "---\ndescription: x\ntype: user\n---\nbody\n", "utf8");
    await writeFile(join(dir, "wrong-type.md"), "---\ndescription: x\ntype: project\n---\nbody\n", "utf8");
    await writeFile(join(dir, "mismatch.md"), "---\nname: other\ndescription: x\ntype: user\n---\nbody\n", "utf8");
    await writeFile(join(dir, "huge.md"), `---\ndescription: x\ntype: user\n---\n${"x".repeat(70 * 1024)}`, "utf8");
    await writeFile(join(dir, "notes.txt"), "ignored", "utf8");
    const listing = await store().list();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["good"]);
    expect(listing.unreadable.map((item) => item.file).sort()).toEqual(["Bad Name.md", "huge.md", "mismatch.md", "wrong-type.md"]);
    expect(listing.unreadable.every((item) => item.scope === "user" && item.reason.length > 0)).toBe(true);
  });

  it("undoes a change only while the file still holds what that change wrote", async () => {
    const s = store();
    const created = await s.upsert(NOTE, BY_EXTRACTOR);
    if (!created.ok) throw new Error(created.error);
    const path = join((await s.dir("project"))!, "run-root-start.md");
    await writeFile(path, "hand edit", "utf8");
    expect(await s.undo("project", created.value.id)).toEqual({ ok: false, error: "这条记忆之后又被改过，先看最新内容" });
    await writeFile(path, created.value.after!, "utf8");
    const undone = await s.undo("project", created.value.id);
    expect(undone.ok && undone.value).toMatchObject({ op: "restore", undoes: created.value.id, after: null });
    expect((await s.list()).entries).toEqual([]);
    expect(await s.undo("project", created.value.id)).toEqual({ ok: false, error: "这次变更已经撤销过了" });
    if (!undone.ok) throw new Error(undone.error);
    expect(await s.undo("project", undone.value.id)).toEqual({ ok: false, error: "撤销本身不能再撤销" });
    expect((await s.journal()).map((row) => row.op)).toEqual(["restore", "create"]);
  });

  it("does not lose updates when two stores write one directory at once", async () => {
    const a = store();
    const b = store();
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).upsert({ ...NOTE, name: `note-${i}` }, BY_EXTRACTOR)));
    expect((await a.list()).entries).toHaveLength(10);
    expect(await a.journal(50)).toHaveLength(10);
  });

  it("fails with LockTimeoutError while another writer holds the lock", async () => {
    const s = new MemoryStore({ workspacePath: workspace, home, lockWaitMs: 50 });
    const dir = (await s.dir("project"))!;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".lock"), `${process.pid} ${Date.now()}\n`, "utf8");
    await expect(s.upsert(NOTE, BY_EXTRACTOR)).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("works without a workspace, with the user scope only", async () => {
    const s = new MemoryStore({ workspacePath: null, home });
    expect(await s.dir("project")).toBeNull();
    expect(await s.ensureDir("project")).toBeNull();
    expect(await s.upsert(NOTE, BY_EXTRACTOR)).toEqual({ ok: false, error: "没有选中工作区，不能写本项目的记忆" });
    expect((await s.upsert({ ...NOTE, scope: "user" }, BY_EXTRACTOR)).ok).toBe(true);
    expect((await s.list()).entries.map((entry) => entry.scope)).toEqual(["user"]);
    expect(await s.ensureDir("user")).toBe(join(home, "memory"));
  });
});
