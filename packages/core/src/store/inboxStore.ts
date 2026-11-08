import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import { sessionDir } from "./sessionStore.js";
import type { Message } from "../types.js";

/**
 * One append-only queue per session: `{session}/inbox.jsonl`.
 * A completion appends an enqueue line. The runtime later appends a claim,
 * writes one user message into messages.jsonl, then appends consumed.
 * Claim goes on disk before the message so a crash retries the same message
 * id instead of writing a second copy. Lines are never rewritten.
 */
export const TASK_NOTIFICATION_NAME = "task-notification";

const NOTE_CHARS = 6_000;
const NOTICE_CHARS = 24_000;

export type TaskNotificationInput = {
  /** Stable id. A second enqueue with the same id is ignored. */
  id?: string;
  subagentId: string;
  taskId?: string;
  content: string;
  ok: boolean;
};

type Note = {
  id: string;
  subagentId: string;
  taskId?: string;
  content: string;
  ok: boolean;
  createdAt: string;
};

type EnqueueLine = {
  op: "enqueue";
  id: string;
  subagent_id: string;
  task_id?: string;
  content: string;
  ok: boolean;
  created_at: string;
};

type ClaimLine = {
  op: "claim";
  message_id: string;
  turn_id: string;
  ids: string[];
  created_at: string;
};

type ConsumedLine = {
  op: "consumed";
  message_id: string;
};

export type InboxLine = EnqueueLine | ClaimLine | ConsumedLine;

export type DrainPlan =
  | { action: "idle" }
  | { action: "consume_only"; messageId: string; callModel: boolean }
  | { action: "write"; message: Message; appendClaim: ClaimLine | null };

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function taskNotificationContent(notes: readonly Note[]): string {
  const lines = notes.map((note) => {
    const task = note.taskId ? `任务 #${note.taskId}` : "未挂任务";
    const state = note.ok ? "已结束" : "失败";
    return `- ${note.subagentId}（${task}）${state}：${note.content}`;
  });
  return clip(["后台任务完成。这是完成回执，不是用户的新指令。", ...lines].join("\n"), NOTICE_CHARS);
}

function parseLine(raw: string): InboxLine | null {
  try {
    const value = JSON.parse(raw) as Partial<InboxLine>;
    if (!value || typeof value !== "object" || !("op" in value)) return null;
    if (value.op === "enqueue") {
      if (typeof value.id !== "string" || typeof value.subagent_id !== "string") return null;
      if (typeof value.content !== "string" || typeof value.created_at !== "string") return null;
      return {
        op: "enqueue",
        id: value.id,
        subagent_id: value.subagent_id,
        ...(typeof value.task_id === "string" && value.task_id ? { task_id: value.task_id } : {}),
        content: value.content,
        ok: value.ok !== false,
        created_at: value.created_at,
      };
    }
    if (value.op === "claim") {
      if (typeof value.message_id !== "string" || typeof value.turn_id !== "string") return null;
      if (typeof value.created_at !== "string" || !Array.isArray(value.ids)) return null;
      const ids = value.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (!ids.length) return null;
      return { op: "claim", message_id: value.message_id, turn_id: value.turn_id, ids, created_at: value.created_at };
    }
    if (value.op === "consumed" && typeof value.message_id === "string") {
      return { op: "consumed", message_id: value.message_id };
    }
    return null;
  } catch {
    return null;
  }
}

function noteFrom(line: EnqueueLine): Note {
  return {
    id: line.id,
    subagentId: line.subagent_id,
    ...(line.task_id ? { taskId: line.task_id } : {}),
    content: line.content,
    ok: line.ok,
    createdAt: line.created_at,
  };
}

function messageFor(sessionId: string, claim: ClaimLine, notes: Map<string, Note>): Message | null {
  const picked = claim.ids.map((id) => notes.get(id)).filter((note): note is Note => Boolean(note));
  if (!picked.length) return null;
  return {
    id: claim.message_id,
    session_id: sessionId,
    turn_id: claim.turn_id,
    role: "user",
    name: TASK_NOTIFICATION_NAME,
    content: taskNotificationContent(picked),
    created_at: claim.created_at,
  };
}

function assistantFollows(messages: readonly Message[], messageId: string): boolean {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  return messages.slice(index + 1).some((message) => message.role === "assistant");
}

export function planDrain(sessionId: string, lines: readonly InboxLine[], messages: readonly Message[], turnId: string): DrainPlan {
  const notes = new Map<string, Note>();
  const consumed = new Set<string>();
  const claims: ClaimLine[] = [];
  for (const line of lines) {
    if (line.op === "enqueue") {
      if (!notes.has(line.id)) notes.set(line.id, noteFrom(line));
    } else if (line.op === "claim") claims.push(line);
    else consumed.add(line.message_id);
  }
  const covered = new Set<string>();
  for (const claim of claims) {
    if (!consumed.has(claim.message_id)) continue;
    for (const id of claim.ids) covered.add(id);
  }
  const open = claims.find((claim) => !consumed.has(claim.message_id));
  if (open) {
    const message = messageFor(sessionId, open, notes);
    if (!message) return { action: "consume_only", messageId: open.message_id, callModel: false };
    if (!messages.some((item) => item.id === message.id)) return { action: "write", message, appendClaim: null };
    return {
      action: "consume_only",
      messageId: open.message_id,
      callModel: !assistantFollows(messages, open.message_id),
    };
  }
  const pending = [...notes.values()].filter((note) => !covered.has(note.id));
  if (!pending.length) return { action: "idle" };
  const claim: ClaimLine = {
    op: "claim",
    message_id: newId("msg"),
    turn_id: turnId,
    ids: pending.map((note) => note.id),
    created_at: nowIso(),
  };
  const message = messageFor(sessionId, claim, notes);
  if (!message) return { action: "idle" };
  return { action: "write", message, appendClaim: claim };
}

export function inboxHasPending(lines: readonly InboxLine[]): boolean {
  const consumed = new Set<string>();
  const claimed = new Set<string>();
  let enqueue = 0;
  let openClaim = false;
  for (const line of lines) {
    if (line.op === "consumed") consumed.add(line.message_id);
  }
  for (const line of lines) {
    if (line.op === "enqueue") enqueue += 1;
    if (line.op !== "claim") continue;
    if (consumed.has(line.message_id)) {
      for (const id of line.ids) claimed.add(id);
    } else {
      openClaim = true;
    }
  }
  if (openClaim) return true;
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.op === "enqueue") ids.add(line.id);
  }
  for (const id of ids) {
    if (!claimed.has(id)) return true;
  }
  return enqueue > 0 && ids.size > claimed.size;
}

function cleanNote(input: TaskNotificationInput): EnqueueLine | null {
  const subagentId = input.subagentId.trim();
  const content = input.content.trim();
  if (!subagentId || !content) return null;
  const taskId = input.taskId?.trim();
  const id = input.id?.trim() || newId("note");
  return {
    op: "enqueue",
    id,
    subagent_id: clip(subagentId, 120),
    ...(taskId ? { task_id: clip(taskId, 32) } : {}),
    content: clip(content, NOTE_CHARS),
    ok: input.ok,
    created_at: nowIso(),
  };
}

export class InboxStore {
  constructor(private readonly workspacePath: string) {}

  private file(sessionId: string): string {
    return join(sessionDir(this.workspacePath, sessionId), "inbox.jsonl");
  }

  async read(sessionId: string): Promise<InboxLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines: InboxLine[] = [];
    for (const row of raw.split("\n")) {
      if (!row.trim()) continue;
      const parsed = parseLine(row);
      if (parsed) lines.push(parsed);
    }
    return lines;
  }

  async append(sessionId: string, line: InboxLine): Promise<void> {
    await appendFile(this.file(sessionId), JSON.stringify(line) + "\n", "utf8");
  }

  /** Returns false when this id was already queued. */
  async enqueue(sessionId: string, input: TaskNotificationInput): Promise<boolean> {
    const line = cleanNote(input);
    if (!line) return false;
    const existing = await this.read(sessionId);
    if (existing.some((item) => item.op === "enqueue" && item.id === line.id)) return false;
    await this.append(sessionId, line);
    return true;
  }

  async hasPending(sessionId: string): Promise<boolean> {
    return inboxHasPending(await this.read(sessionId));
  }
}
