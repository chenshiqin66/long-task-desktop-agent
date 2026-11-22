import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import { isSkillName } from "../skills/frontmatter.js";
import { errorCode, replaceFile, withDirLock } from "../store/fileLock.js";
import { defaultAgentHome } from "../config/agentHome.js";
import {
  MEMORY_FILE_MAX_BYTES,
  checkMemoryFields,
  findSecret,
  parseMemoryFile,
  serializeMemory,
  type MemoryEntry,
  type MemoryOrigin,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  type UnreadableMemory,
} from "./entry.js";
import { resolveProject, writeProjectFile, type ProjectInfo } from "./projectKey.js";
import { migrateMemoryLayout, projectMemoryDir, userMemoryDir } from "./paths.js";

export type MemoryActor = "extractor" | "user";
export type JournalOp = "create" | "update" | "delete" | "restore";

/** One line of `journal.jsonl`. before and after are whole file texts; null means no file. */
export interface JournalLine {
  id: string;
  at: string;
  op: JournalOp;
  name: string;
  actor: MemoryActor;
  before: string | null;
  after: string | null;
  source?: MemorySource;
  /** On a restore line: the change it undid. */
  undoes?: string;
}

export interface JournalRecord extends JournalLine {
  scope: MemoryScope;
}

export interface MemoryListing {
  entries: MemoryEntry[];
  unreadable: UnreadableMemory[];
}

export interface MemoryWrite {
  scope: MemoryScope;
  name: string;
  type: MemoryType;
  description: string;
  body: string;
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: string };

const NO_PROJECT = "没有选中工作区，不能写本项目的记忆";
const JOURNAL_FILE = "journal.jsonl";

async function readText(path: string): Promise<{ text: string; mtime: Date } | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mtime: info.mtime };
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

async function readScope(scope: MemoryScope, dir: string, into: MemoryListing): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  for (const file of names.filter((name) => name.toLowerCase().endsWith(".md")).sort()) {
    const path = join(dir, file);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > MEMORY_FILE_MAX_BYTES) {
        into.unreadable.push({ scope, file, reason: "文件超过 64 KiB" });
        continue;
      }
      const parsed = parseMemoryFile(await readFile(path, "utf8"), { scope, fileName: file, mtime: info.mtime });
      if (parsed.ok) into.entries.push(parsed.entry);
      else into.unreadable.push({ scope, file, reason: parsed.reason });
    } catch {
      into.unreadable.push({ scope, file, reason: "读取失败" });
    }
  }
}

async function readJournal(dir: string): Promise<JournalLine[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, JOURNAL_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
  const lines: JournalLine[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    try {
      const row = JSON.parse(text) as JournalLine;
      if (typeof row.id === "string" && typeof row.name === "string") lines.push(row);
    } catch {
      // A line cut short by a crash. The lines around it still count.
    }
  }
  return lines;
}

/**
 * Memory for one workspace: `{home}/memory/user/` for every project and
 * `{home}/memory/projects/{key}/` (flat) for this repository. Each change made
 * through the store takes the directory lock, replaces the file, and appends
 * a journal line holding the whole text before and after, so it can be
 * undone. Edits made directly in the folder bypass all of this.
 */
export class MemoryStore {
  readonly home: string;
  readonly workspacePath: string | null;
  private readonly lockWaitMs: number | undefined;
  private project: Promise<ProjectInfo | null> | null = null;
  private layoutReady = false;

  constructor(opts: { workspacePath: string | null; home?: string; lockWaitMs?: number }) {
    this.home = opts.home ?? defaultAgentHome();
    this.workspacePath = opts.workspacePath;
    this.lockWaitMs = opts.lockWaitMs;
  }

  private ensureLayout(): void {
    if (this.layoutReady) return;
    migrateMemoryLayout(this.home);
    this.layoutReady = true;
  }

  projectInfo(): Promise<ProjectInfo | null> {
    this.project ??= this.workspacePath === null ? Promise.resolve(null) : resolveProject(this.workspacePath);
    return this.project;
  }

  async dir(scope: MemoryScope): Promise<string | null> {
    this.ensureLayout();
    if (scope === "user") return userMemoryDir(this.home);
    const project = await this.projectInfo();
    return project ? projectMemoryDir(this.home, project.key) : null;
  }

  async list(): Promise<MemoryListing> {
    const listing: MemoryListing = { entries: [], unreadable: [] };
    for (const scope of ["project", "user"] as const) {
      const dir = await this.dir(scope);
      if (dir) await readScope(scope, dir, listing);
    }
    return listing;
  }

  async read(name: string, scope?: MemoryScope): Promise<MemoryEntry[]> {
    const { entries } = await this.list();
    return entries.filter((entry) => entry.name === name && (!scope || entry.scope === scope));
  }

  async upsert(
    input: MemoryWrite,
    opts: { actor: MemoryActor; origin: MemoryOrigin; secrets: readonly string[]; source?: MemorySource },
  ): Promise<MemoryResult<JournalLine>> {
    const problem = checkMemoryFields(input);
    if (problem) return { ok: false, error: problem };
    const secret = findSecret(`${input.description}\n${input.body}`, opts.secrets);
    if (secret) return { ok: false, error: `含有${secret}，不能写进记忆` };
    const dir = await this.prepare(input.scope);
    if (!dir) return { ok: false, error: NO_PROJECT };
    return this.locked(dir, async () => {
      const fileName = `${input.name}.md`;
      const path = join(dir, fileName);
      const before = await readText(path);
      const previous = before ? parseMemoryFile(before.text, { scope: input.scope, fileName, mtime: before.mtime }) : null;
      const now = nowIso();
      const after = serializeMemory({
        scope: input.scope,
        name: input.name,
        description: input.description.trim(),
        type: input.type,
        created: previous?.ok ? previous.entry.created : now,
        modified: now,
        origin: opts.origin,
        ...(opts.source ? { source: opts.source } : {}),
        body: input.body.trim(),
      });
      await replaceFile(path, after);
      const line = await this.appendJournal(dir, {
        op: before ? "update" : "create",
        name: input.name,
        actor: opts.actor,
        before: before?.text ?? null,
        after,
        ...(opts.source ? { source: opts.source } : {}),
      });
      return { ok: true, value: line };
    });
  }

  /** The memory page changes only the description and the body. */
  async edit(
    scope: MemoryScope,
    name: string,
    change: { description: string; body: string },
    opts: { secrets: readonly string[] },
  ): Promise<MemoryResult<JournalLine>> {
    if (!isSkillName(name)) return { ok: false, error: `名字不合法：${name}` };
    const dir = await this.prepare(scope);
    if (!dir) return { ok: false, error: NO_PROJECT };
    return this.locked(dir, async () => {
      const fileName = `${name}.md`;
      const path = join(dir, fileName);
      const before = await readText(path);
      if (!before) return { ok: false, error: "这条记忆已经不在了" };
      const parsed = parseMemoryFile(before.text, { scope, fileName, mtime: before.mtime });
      if (!parsed.ok) return { ok: false, error: `文件无法读取：${parsed.reason}` };
      const next: MemoryEntry = {
        ...parsed.entry,
        description: change.description.trim(),
        body: change.body.trim(),
        modified: nowIso(),
        origin: "edited",
      };
      const problem = checkMemoryFields(next);
      if (problem) return { ok: false, error: problem };
      const secret = findSecret(`${next.description}\n${next.body}`, opts.secrets);
      if (secret) return { ok: false, error: `含有${secret}，不能写进记忆` };
      const after = serializeMemory(next);
      await replaceFile(path, after);
      return { ok: true, value: await this.appendJournal(dir, { op: "update", name, actor: "user", before: before.text, after }) };
    });
  }

  async remove(
    scope: MemoryScope,
    name: string,
    opts: { actor: MemoryActor; source?: MemorySource },
  ): Promise<MemoryResult<JournalLine>> {
    if (!isSkillName(name)) return { ok: false, error: `名字不合法：${name}` };
    const dir = await this.prepare(scope);
    if (!dir) return { ok: false, error: NO_PROJECT };
    return this.locked(dir, async () => {
      const path = join(dir, `${name}.md`);
      const before = await readText(path);
      if (!before) return { ok: false, error: `找不到记忆 ${name}` };
      await rm(path, { force: true });
      const line = await this.appendJournal(dir, {
        op: "delete",
        name,
        actor: opts.actor,
        before: before.text,
        after: null,
        ...(opts.source ? { source: opts.source } : {}),
      });
      return { ok: true, value: line };
    });
  }

  /** Puts back the text before one change, if the file still holds what that change wrote. */
  async undo(scope: MemoryScope, journalId: string): Promise<MemoryResult<JournalLine>> {
    const dir = await this.dir(scope);
    if (!dir) return { ok: false, error: NO_PROJECT };
    return this.locked(dir, async () => {
      const lines = await readJournal(dir);
      const target = lines.find((line) => line.id === journalId);
      if (!target) return { ok: false, error: "找不到这条变更记录" };
      if (target.op === "restore") return { ok: false, error: "撤销本身不能再撤销" };
      if (lines.some((line) => line.undoes === journalId)) return { ok: false, error: "这次变更已经撤销过了" };
      const path = join(dir, `${target.name}.md`);
      const current = await readText(path);
      if ((current?.text ?? null) !== target.after) return { ok: false, error: "这条记忆之后又被改过，先看最新内容" };
      if (target.before === null) await rm(path, { force: true });
      else await replaceFile(path, target.before);
      const line = await this.appendJournal(dir, {
        op: "restore",
        name: target.name,
        actor: "user",
        before: current?.text ?? null,
        after: target.before,
        undoes: journalId,
      });
      return { ok: true, value: line };
    });
  }

  /** Newest first across both scopes. */
  async journal(limit = 20): Promise<JournalRecord[]> {
    const rows: JournalRecord[] = [];
    for (const scope of ["user", "project"] as const) {
      const dir = await this.dir(scope);
      if (!dir) continue;
      for (const line of (await readJournal(dir)).reverse()) rows.push({ ...line, scope });
    }
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  }

  /** For "打开文件夹": the directory exists afterwards. Null without a workspace. */
  async ensureDir(scope: MemoryScope): Promise<string | null> {
    const dir = await this.prepare(scope);
    if (dir) await mkdir(dir, { recursive: true });
    return dir;
  }

  private async prepare(scope: MemoryScope): Promise<string | null> {
    this.ensureLayout();
    if (scope === "project") {
      const project = await this.projectInfo();
      if (!project) return null;
      const projectDir = projectMemoryDir(this.home, project.key);
      await mkdir(projectDir, { recursive: true });
      await writeProjectFile(projectDir, project);
    }
    return this.dir(scope);
  }

  private locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    return withDirLock(dir, "Memory", fn, this.lockWaitMs === undefined ? {} : { waitMs: this.lockWaitMs });
  }

  private async appendJournal(dir: string, line: Omit<JournalLine, "id" | "at">): Promise<JournalLine> {
    const full: JournalLine = { id: newId("memj"), at: nowIso(), ...line };
    await appendFile(join(dir, JOURNAL_FILE), `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }
}
