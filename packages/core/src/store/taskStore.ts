import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../ids.js";
import { sessionDir } from "./sessionStore.js";

/**
 * One JSON file per task, under the session:
 * `{workspace}/.agent/sessions/{sessionId}/tasks/{id}.json`
 *
 * Claude Code keeps a task list outside the repo, one directory per session.
 * This project already stores session state in `.agent`, which list_dir and
 * keyword_search skip. A `tasks/` directory at the workspace root would be
 * shared by every session and editable with write_file, which skips
 * claim_task / complete_task.
 *
 * Status is only pending, in_progress, or completed. A task is blocked when
 * it is pending and some blockedBy id is not completed. That is not a fourth
 * status. blocks is the reverse edge, kept so a delete can find dependents
 * without guessing. The directory lock makes claim and complete atomic:
 * two callers cannot both observe pending and both become the owner.
 * Separate files keep one unreadable task from discarding the rest.
 * Ids are decimal strings and are not reused after delete (.highwatermark).
 *
 * owner is who claimed the task. The parent defaults to "main". A subagent
 * run that is given a task id is claimed as that subagent before it starts.
 * Subagents may list, get, claim, and complete. They cannot create, update,
 * or delete tasks. releaseInProgress returns a failed subagent's claims to
 * pending so a blocker is not stuck on an owner that has stopped.
 */

const TASK_ID_RE = /^[1-9][0-9]{0,8}$/;
const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 8_000;
const OWNER_MAX = 120;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 15_000;

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  /** Tasks that cannot start until this one is completed. */
  blocks: string[];
  /** Tasks that must be completed before this one can be claimed. */
  blockedBy: string[];
  /** Set by claim and kept after complete. Absent while pending. */
  owner?: string;
  created_at: string;
  updated_at: string;
}

export type TaskResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TaskListSnapshot {
  tasks: TaskRecord[];
  unreadable: string[];
}

export function tasksDir(workspacePath: string, sessionId: string): string {
  return join(sessionDir(workspacePath, sessionId), "tasks");
}

export function cleanTaskId(raw: unknown): string | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return null;
    raw = String(raw);
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^#/, "");
  return TASK_ID_RE.test(text) ? text : null;
}

export function openBlockedBy(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): string[] {
  return task.blockedBy.filter((id) => {
    const dep = byId.get(id);
    return !dep || dep.status !== "completed";
  });
}

export class TaskStore {
  constructor(private readonly dir: string) {}

  static forSession(workspacePath: string, sessionId: string): TaskStore {
    return new TaskStore(tasksDir(workspacePath, sessionId));
  }

  async list(): Promise<TaskListSnapshot> {
    const loaded = await loadTasks(this.dir);
    const tasks = [...loaded.tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
    return { tasks, unreadable: loaded.unreadable };
  }

  async get(id: string): Promise<TaskResult<TaskRecord>> {
    const parsed = cleanTaskId(id);
    if (!parsed) return { ok: false, error: "Invalid task id" };
    const loaded = await loadTasks(this.dir);
    if (loaded.unreadable.includes(`${parsed}.json`)) {
      return { ok: false, error: `Task file ${parsed}.json is unreadable` };
    }
    const task = loaded.tasks.get(parsed);
    if (!task) return { ok: false, error: `No task #${parsed}` };
    return { ok: true, value: task };
  }

  async create(input: {
    subject: string;
    description: string;
    blockedBy?: readonly unknown[];
  }): Promise<TaskResult<TaskRecord>> {
    const subject = cleanSubject(input.subject);
    if (!subject.ok) return subject;
    const description = cleanDescription(input.description);
    if (!description.ok) return description;
    const blockedBy = cleanIdList(input.blockedBy ?? []);
    if (!blockedBy.ok) return blockedBy;

    return this.mutate(async (all) => {
      for (const dep of blockedBy.ids) {
        if (!all.has(dep)) return { ok: false, error: `No task #${dep}` };
      }
      const mark = await readHighWaterMark(this.dir);
      const highest = Math.max(mark, 0, ...[...all.keys()].map((id) => Number(id)));
      const id = String(highest + 1);
      const now = nowIso();
      const task: TaskRecord = {
        id,
        subject: subject.subject,
        description: description.description,
        status: "pending",
        blocks: [],
        blockedBy: blockedBy.ids,
        created_at: now,
        updated_at: now,
      };
      await writeHighWaterMark(this.dir, highest + 1);
      for (const dep of blockedBy.ids) {
        const blocker = all.get(dep)!;
        if (!blocker.blocks.includes(id)) {
          blocker.blocks.push(id);
          blocker.updated_at = now;
          await writeTask(this.dir, blocker);
        }
      }
      await writeTask(this.dir, task);
      return { ok: true, value: task };
    });
  }

  /** pending → in_progress. Fails if another owner already won, or a blocker is open. */
  async claim(id: string, owner: string): Promise<TaskResult<TaskRecord>> {
    const parsed = cleanTaskId(id);
    if (!parsed) return { ok: false, error: "Invalid task id" };
    const who = cleanOwner(owner);
    if (!who.ok) return who;
    return this.mutate(async (all) => {
      const task = all.get(parsed);
      if (!task) return { ok: false, error: `No task #${parsed}` };
      if (task.status !== "pending") {
        const owned = task.owner ? `, owned by ${task.owner}` : "";
        return { ok: false, error: `Task #${parsed} is ${task.status}${owned}` };
      }
      const open = openBlockedBy(task, all);
      if (open.length > 0) {
        return { ok: false, error: `Task #${parsed} is blocked by ${open.map((dep) => `#${dep}`).join(", ")}` };
      }
      task.status = "in_progress";
      task.owner = who.owner;
      task.updated_at = nowIso();
      await writeTask(this.dir, task);
      return { ok: true, value: task };
    });
  }

  /** in_progress → completed, only for the owner that claimed it. */
  async complete(
    id: string,
    owner: string,
  ): Promise<TaskResult<{ task: TaskRecord; unblocked: TaskRecord[] }>> {
    const parsed = cleanTaskId(id);
    if (!parsed) return { ok: false, error: "Invalid task id" };
    const who = cleanOwner(owner);
    if (!who.ok) return who;
    return this.mutate(async (all) => {
      const task = all.get(parsed);
      if (!task) return { ok: false, error: `No task #${parsed}` };
      if (task.status !== "in_progress") {
        return { ok: false, error: `Task #${parsed} is ${task.status}, cannot complete` };
      }
      if (task.owner !== who.owner) {
        return {
          ok: false,
          error: `Task #${parsed} is owned by ${task.owner ?? "nobody"}, not ${who.owner}`,
        };
      }
      const blockedBefore = new Set(
        [...all.values()]
          .filter((item) => item.status === "pending" && openBlockedBy(item, all).length > 0)
          .map((item) => item.id),
      );
      task.status = "completed";
      task.updated_at = nowIso();
      await writeTask(this.dir, task);
      const unblocked = [...all.values()]
        .filter(
          (item) =>
            item.id !== task.id &&
            item.status === "pending" &&
            item.blockedBy.includes(task.id) &&
            blockedBefore.has(item.id) &&
            openBlockedBy(item, all).length === 0,
        )
        .sort((a, b) => Number(a.id) - Number(b.id));
      return { ok: true, value: { task, unblocked } };
    });
  }

  /**
   * in_progress → pending for this owner only. Used when that owner stops
   * before complete_task. Completed tasks stay completed.
   */
  async releaseInProgress(owner: string): Promise<TaskRecord[]> {
    const who = cleanOwner(owner);
    if (!who.ok) return [];
    try {
      await stat(this.dir);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
    const result = await this.mutate(async (all) => {
      const released: TaskRecord[] = [];
      const now = nowIso();
      for (const task of all.values()) {
        if (task.status !== "in_progress" || task.owner !== who.owner) continue;
        task.status = "pending";
        delete task.owner;
        task.updated_at = now;
        await writeTask(this.dir, task);
        released.push(task);
      }
      return { ok: true as const, value: released };
    });
    return result.ok ? result.value : [];
  }

  /**
   * Words and dependency links only. Status stays on claim / complete.
   * Dependencies can change only while the task is pending.
   */
  async update(input: {
    id: string;
    subject?: string;
    description?: string;
    addBlockedBy?: readonly unknown[];
    removeBlockedBy?: readonly unknown[];
  }): Promise<TaskResult<TaskRecord>> {
    const parsed = cleanTaskId(input.id);
    if (!parsed) return { ok: false, error: "Invalid task id" };
    const subject = input.subject === undefined ? undefined : cleanSubject(input.subject);
    if (subject && !subject.ok) return subject;
    const description = input.description === undefined ? undefined : cleanDescription(input.description);
    if (description && !description.ok) return description;
    const add = input.addBlockedBy === undefined ? undefined : cleanIdList(input.addBlockedBy);
    if (add && !add.ok) return add;
    const remove = input.removeBlockedBy === undefined ? undefined : cleanIdList(input.removeBlockedBy);
    if (remove && !remove.ok) return remove;
    if (!subject && !description && !add && !remove) {
      return { ok: false, error: "Nothing to change" };
    }
    const addIds = add && add.ok ? add.ids : [];
    const removeIds = remove && remove.ok ? remove.ids : [];
    const overlap = addIds.find((id) => removeIds.includes(id));
    if (overlap) return { ok: false, error: `Task #${overlap} is both added and removed` };

    return this.mutate(async (all) => {
      const task = all.get(parsed);
      if (!task) return { ok: false, error: `No task #${parsed}` };
      if ((addIds.length > 0 || removeIds.length > 0) && task.status !== "pending") {
        return {
          ok: false,
          error: `Task #${parsed} is ${task.status}. Dependencies can change only while it is pending`,
        };
      }
      if (subject && subject.ok) task.subject = subject.subject;
      if (description && description.ok) task.description = description.description;
      const now = nowIso();
      for (const blockerId of removeIds) {
        task.blockedBy = task.blockedBy.filter((id) => id !== blockerId);
        const blocker = all.get(blockerId);
        if (blocker) {
          blocker.blocks = blocker.blocks.filter((id) => id !== task.id);
          blocker.updated_at = now;
        }
      }
      for (const blockerId of addIds) {
        if (blockerId === task.id) return { ok: false, error: `Task #${task.id} cannot be blocked by itself` };
        const blocker = all.get(blockerId);
        if (!blocker) return { ok: false, error: `No task #${blockerId}` };
        if (dependsOn(blockerId, task.id, all)) {
          return { ok: false, error: `Task #${task.id} cannot be blocked by #${blockerId}: that would cycle` };
        }
        if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
        if (!blocker.blocks.includes(task.id)) {
          blocker.blocks.push(task.id);
          blocker.updated_at = now;
        }
      }
      task.updated_at = now;
      for (const item of all.values()) {
        if (item.updated_at === now || item.id === task.id) await writeTask(this.dir, item);
      }
      return { ok: true, value: task };
    });
  }

  async delete(id: string): Promise<TaskResult<TaskRecord>> {
    const parsed = cleanTaskId(id);
    if (!parsed) return { ok: false, error: "Invalid task id" };
    return this.mutate(async (all) => {
      const task = all.get(parsed);
      if (!task) return { ok: false, error: `No task #${parsed}` };
      const now = nowIso();
      for (const other of all.values()) {
        if (other.id === task.id) continue;
        const blocks = other.blocks.filter((item) => item !== task.id);
        const blockedBy = other.blockedBy.filter((item) => item !== task.id);
        if (blocks.length === other.blocks.length && blockedBy.length === other.blockedBy.length) continue;
        other.blocks = blocks;
        other.blockedBy = blockedBy;
        other.updated_at = now;
        await writeTask(this.dir, other);
      }
      all.delete(task.id);
      await rm(taskPath(this.dir, task.id), { force: true });
      const mark = await readHighWaterMark(this.dir);
      if (Number(task.id) > mark) await writeHighWaterMark(this.dir, Number(task.id));
      return { ok: true, value: task };
    });
  }

  private async mutate<T>(fn: (all: Map<string, TaskRecord>) => Promise<TaskResult<T>>): Promise<TaskResult<T>> {
    return withTaskLock(this.dir, async () => {
      const loaded = await loadTasks(this.dir);
      if (loaded.unreadable.length > 0) {
        return { ok: false, error: `Unreadable task file: ${loaded.unreadable.join(", ")}` };
      }
      return fn(loaded.tasks);
    });
  }
}

function cleanSubject(raw: string): { ok: true; subject: string } | { ok: false; error: string } {
  const subject = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!subject) return { ok: false, error: "subject is required" };
  if (subject.length > SUBJECT_MAX) {
    return { ok: false, error: `subject is too long (${subject.length} chars; max ${SUBJECT_MAX})` };
  }
  return { ok: true, subject };
}

function cleanDescription(raw: string): { ok: true; description: string } | { ok: false; error: string } {
  const description = String(raw ?? "").trim();
  if (!description) return { ok: false, error: "description is required" };
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `description is too long (${description.length} chars; max ${DESCRIPTION_MAX})` };
  }
  return { ok: true, description };
}

function cleanOwner(raw: string): { ok: true; owner: string } | { ok: false; error: string } {
  const owner = String(raw ?? "").trim();
  if (!owner) return { ok: false, error: "owner is required" };
  if (/[\r\n]/.test(owner)) return { ok: false, error: "owner cannot contain a newline" };
  if (owner.length > OWNER_MAX) {
    return { ok: false, error: `owner is too long (${owner.length} chars; max ${OWNER_MAX})` };
  }
  return { ok: true, owner };
}

function cleanIdList(
  raw: readonly unknown[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "blocked_by must be a list of task ids" };
  const ids: string[] = [];
  for (const item of raw) {
    const id = cleanTaskId(item);
    if (!id) return { ok: false, error: `Invalid task id: ${JSON.stringify(item)}` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** True when `start` already depends on `target` through blockedBy. */
function dependsOn(start: string, target: string, all: ReadonlyMap<string, TaskRecord>): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = all.get(id);
    if (!task) continue;
    for (const next of task.blockedBy) stack.push(next);
  }
  return false;
}

function taskPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

async function loadTasks(dir: string): Promise<{ tasks: Map<string, TaskRecord>; unreadable: string[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { tasks: new Map(), unreadable: [] };
    }
    throw err;
  }
  const tasks = new Map<string, TaskRecord>();
  const unreadable: string[] = [];
  for (const name of names) {
    if (!/^[1-9][0-9]{0,8}\.json$/.test(name)) continue;
    let task: TaskRecord | null;
    try {
      task = parseTask(await readFile(join(dir, name), "utf8"));
    } catch {
      unreadable.push(name);
      continue;
    }
    if (!task || `${task.id}.json` !== name) {
      unreadable.push(name);
      continue;
    }
    tasks.set(task.id, task);
  }
  return { tasks, unreadable };
}

function parseTask(raw: string): TaskRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !TASK_ID_RE.test(row.id)) return null;
  if (row.status !== "pending" && row.status !== "in_progress" && row.status !== "completed") return null;
  if (typeof row.subject !== "string" || typeof row.description !== "string") return null;
  if (!Array.isArray(row.blocks) || !Array.isArray(row.blockedBy)) return null;
  if (!row.blocks.every((item) => typeof item === "string" && TASK_ID_RE.test(item))) return null;
  if (!row.blockedBy.every((item) => typeof item === "string" && TASK_ID_RE.test(item))) return null;
  if (typeof row.created_at !== "string" || typeof row.updated_at !== "string") return null;
  if (row.owner !== undefined && typeof row.owner !== "string") return null;
  const task: TaskRecord = {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    blocks: [...row.blocks],
    blockedBy: [...row.blockedBy],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (typeof row.owner === "string" && row.owner.trim()) task.owner = row.owner;
  return task;
}

async function writeTask(dir: string, task: TaskRecord): Promise<void> {
  const json = `${JSON.stringify(task, null, 2)}\n`;
  const path = taskPath(dir, task.id);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, json, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(tmp, { force: true });
      throw err;
    }
    await rm(path, { force: true });
    try {
      await rename(tmp, path);
    } catch (renameErr) {
      await rm(tmp, { force: true });
      throw renameErr;
    }
  }
}

async function readHighWaterMark(dir: string): Promise<number> {
  try {
    const raw = await readFile(join(dir, ".highwatermark"), "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return 0;
    throw err;
  }
}

async function writeHighWaterMark(dir: string, value: number): Promise<void> {
  await writeFile(join(dir, ".highwatermark"), `${value}\n`, "utf8");
}

async function withTaskLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (code !== "EEXIST") throw err;
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Task list lock timed out");
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // The holder released the lock between the failed create and this stat.
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
