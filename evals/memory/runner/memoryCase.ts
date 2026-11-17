import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, OpenAICompatibleProvider, SessionStore, extractOnce, sessionDir } from "@agent/core";
import type { ExtractOutcome, MemoryEntry, MemoryScope, MemoryType, Message } from "@agent/core";

export type Layer = "remember" | "skip" | "revise";

export interface CaseMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_arguments?: string;
}

export interface ExistingNote {
  scope: MemoryScope;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
}

/** What one written note must look like. upsert matches a create or an update. */
export interface Hold {
  op: "upsert" | "delete";
  scope?: MemoryScope;
  type?: MemoryType;
  name?: string;
  /** Every one of these is found in the description plus the body. */
  includes?: string[];
  /** At least one is found, compared case-insensitively. */
  includesAny?: string[];
}

export interface MemoryCase {
  id: string;
  layer: Layer;
  title: string;
  messages: CaseMessage[];
  /** Index of the last message already extracted. The range starts after it. */
  cursorAt?: number;
  /** Written to {workspace}/AGENTS.md before the pass. */
  projectAgents?: string;
  existing?: ExistingNote[];
  required: Hold[];
  forbidden: Hold[];
}

export interface Applied {
  op: "create" | "update" | "delete" | "restore";
  scope: MemoryScope;
  name: string;
  type?: MemoryType;
  description?: string;
  body?: string;
}

export interface CaseRun {
  id: string;
  layer: Layer;
  title: string;
  outcome: ExtractOutcome;
  output?: string;
  applied: Applied[];
  missing: Hold[];
  hit: Hold[];
  pass: boolean;
  workspace: string;
  home: string;
}

const LAYERS = new Set<Layer>(["remember", "skip", "revise"]);
const SCOPES = new Set<MemoryScope>(["user", "project"]);
const TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const ROLES = new Set(["user", "assistant", "tool"]);

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 不是对象`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} 为空`);
  return value;
}

function holds(value: unknown, what: string): Hold[] {
  if (!Array.isArray(value)) throw new Error(`${what} 不是数组`);
  return value.map((item, index) => {
    const row = asObject(item, `${what}[${index}]`);
    if (row.op !== "upsert" && row.op !== "delete") throw new Error(`${what}[${index}] 的 op 无效`);
    const hold: Hold = { op: row.op };
    if (row.scope !== undefined) {
      if (!SCOPES.has(row.scope as MemoryScope)) throw new Error(`${what}[${index}] 的 scope 无效`);
      hold.scope = row.scope as MemoryScope;
    }
    if (row.type !== undefined) {
      if (!TYPES.has(row.type as MemoryType)) throw new Error(`${what}[${index}] 的 type 无效`);
      hold.type = row.type as MemoryType;
    }
    if (row.name !== undefined) hold.name = asString(row.name, `${what}[${index}].name`);
    for (const key of ["includes", "includesAny"] as const) {
      const list = row[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length === 0 || list.some((part) => typeof part !== "string" || !part)) {
        throw new Error(`${what}[${index}].${key} 无效`);
      }
      hold[key] = list as string[];
    }
    return hold;
  });
}

export function loadCases(text: string): { today: string; cases: MemoryCase[] } {
  const parsed = asObject(JSON.parse(text), "用例文件");
  const today = asString(parsed.today, "today");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today 不是日期：${today}`);
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) throw new Error("没有用例");
  const seen = new Set<string>();
  const cases = parsed.cases.map((item, index) => {
    const row = asObject(item, `cases[${index}]`);
    const id = asString(row.id, `cases[${index}].id`);
    if (seen.has(id)) throw new Error(`重复的用例 id：${id}`);
    seen.add(id);
    if (!LAYERS.has(row.layer as Layer)) throw new Error(`${id} 的 layer 无效`);
    if (!Array.isArray(row.messages) || row.messages.length === 0) throw new Error(`${id} 没有消息`);
    const messages = row.messages.map((message, at) => {
      const one = asObject(message, `${id}.messages[${at}]`);
      if (!ROLES.has(String(one.role))) throw new Error(`${id} 的第 ${at} 条消息角色无效`);
      const built: CaseMessage = {
        role: one.role as CaseMessage["role"],
        content: asString(one.content, `${id}.messages[${at}].content`),
      };
      if (one.name !== undefined) built.name = asString(one.name, `${id}.messages[${at}].name`);
      if (one.tool_call_arguments !== undefined) {
        built.tool_call_arguments = asString(one.tool_call_arguments, `${id}.messages[${at}].tool_call_arguments`);
      }
      if (built.role === "tool" && !built.name) throw new Error(`${id} 的工具消息没有 name`);
      return built;
    });
    let cursorAt: number | undefined;
    if (row.cursorAt !== undefined) {
      if (typeof row.cursorAt !== "number" || !Number.isInteger(row.cursorAt) || row.cursorAt < 0 || row.cursorAt >= messages.length) {
        throw new Error(`${id} 的 cursorAt 超出消息范围`);
      }
      cursorAt = row.cursorAt;
    }
    const existing = Array.isArray(row.existing)
      ? row.existing.map((note, at) => {
          const one = asObject(note, `${id}.existing[${at}]`);
          if (!SCOPES.has(one.scope as MemoryScope) || !TYPES.has(one.type as MemoryType)) {
            throw new Error(`${id}.existing[${at}] 的作用域或类型无效`);
          }
          return {
            scope: one.scope as MemoryScope,
            type: one.type as MemoryType,
            name: asString(one.name, `${id}.existing[${at}].name`),
            description: asString(one.description, `${id}.existing[${at}].description`),
            body: asString(one.body, `${id}.existing[${at}].body`),
          };
        })
      : [];
    return {
      id,
      layer: row.layer as Layer,
      title: asString(row.title, `${id}.title`),
      messages,
      ...(cursorAt !== undefined ? { cursorAt } : {}),
      ...(typeof row.projectAgents === "string" ? { projectAgents: row.projectAgents } : {}),
      existing,
      required: holds(row.required, `${id}.required`),
      forbidden: holds(row.forbidden, `${id}.forbidden`),
    };
  });
  return { today, cases };
}

function noteText(item: Applied): string {
  return `${item.description ?? ""}\n${item.body ?? ""}`;
}

export function matches(hold: Hold, item: Applied): boolean {
  const wrote = item.op === "create" || item.op === "update";
  if (hold.op === "upsert" && !wrote) return false;
  if (hold.op === "delete" && item.op !== "delete") return false;
  if (hold.scope && item.scope !== hold.scope) return false;
  if (hold.type && item.type !== hold.type) return false;
  if (hold.name && item.name !== hold.name) return false;
  const text = noteText(item);
  if (hold.includes && !hold.includes.every((part) => text.includes(part))) return false;
  if (hold.includesAny && !hold.includesAny.some((part) => text.toLowerCase().includes(part.toLowerCase()))) return false;
  return true;
}

export function holdText(hold: Hold): string {
  const parts: string[] = [hold.op];
  if (hold.scope) parts.push(hold.scope);
  if (hold.type) parts.push(hold.type);
  if (hold.name) parts.push(hold.name);
  if (hold.includes?.length) parts.push(`含 ${hold.includes.join("、")}`);
  if (hold.includesAny?.length) parts.push(`含其一 ${hold.includesAny.join("、")}`);
  return parts.join(" ");
}

function messageOf(sessionId: string, index: number, raw: CaseMessage, now: Date): Message {
  return {
    id: `msg_eval_${index}`,
    session_id: sessionId,
    turn_id: "turn_eval",
    role: raw.role,
    content: raw.content,
    created_at: new Date(now.getTime() + index * 1000).toISOString(),
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.tool_call_arguments ? { tool_call_arguments: raw.tool_call_arguments, is_error: false } : {}),
  };
}

function appliedOf(saved: { op: Applied["op"]; scope: MemoryScope; name: string }, entries: readonly MemoryEntry[]): Applied {
  const entry = entries.find((item) => item.scope === saved.scope && item.name === saved.name);
  return {
    op: saved.op,
    scope: saved.scope,
    name: saved.name,
    ...(entry ? { type: entry.type, description: entry.description, body: entry.body } : {}),
  };
}

/**
 * One case in its own temp workspace and home directory. The date is built
 * from parts, so the local calendar day stays on `today` in any timezone.
 */
export async function runMemoryCase(
  item: MemoryCase,
  opts: { today: string; baseUrl: string; model: string; apiKey: string; keep: boolean },
): Promise<CaseRun> {
  const [year, month, day] = opts.today.split("-").map(Number);
  const now = new Date(year!, (month ?? 1) - 1, day, 10, 0, 0);
  const workspace = await mkdtemp(join(tmpdir(), `lst-mem-${item.id}-`));
  let home = "";
  try {
    home = await mkdtemp(join(tmpdir(), `lst-mem-home-${item.id}-`));
    await mkdir(join(workspace, ".git"));
    if (item.projectAgents !== undefined) await writeFile(join(workspace, "AGENTS.md"), item.projectAgents, "utf8");
    const sessions = new SessionStore(workspace);
    const meta = await sessions.createSession(`eval ${item.id}`);
    const messages = item.messages.map((raw, index) => messageOf(meta.session_id, index, raw, now));
    for (const message of messages) await sessions.appendMessage(message);
    if (item.cursorAt !== undefined) {
      await writeFile(
        join(sessionDir(workspace, meta.session_id), "memory-cursor.json"),
        `${JSON.stringify({ last_message_id: messages[item.cursorAt]!.id, updated_at: now.toISOString() })}\n`,
        "utf8",
      );
    }
    const store = new MemoryStore({ workspacePath: workspace, home });
    for (const note of item.existing ?? []) {
      const seeded = await store.upsert(note, { actor: "user", origin: "manual", secrets: [] });
      if (!seeded.ok) throw new Error(`${item.id} 的已有记忆 ${note.name} 写不进去：${seeded.error}`);
    }
    const signal = AbortSignal.timeout(120_000);
    const report = await extractOnce({
      workspace,
      sessionId: meta.session_id,
      home,
      now,
      signal,
      settings: {
        autoMemory: true,
        provider: new OpenAICompatibleProvider({ baseUrl: opts.baseUrl, apiKey: opts.apiKey }),
        model: opts.model,
        secrets: [],
      },
    });
    const listing = await store.list();
    const applied = report.saved.map((saved) => appliedOf(saved, listing.entries));
    const missing = item.required.filter((hold) => !applied.some((saved) => matches(hold, saved)));
    const hit = item.forbidden.filter((hold) => applied.some((saved) => matches(hold, saved)));
    return {
      id: item.id,
      layer: item.layer,
      title: item.title,
      outcome: report.outcome,
      ...(report.output !== undefined ? { output: report.output } : {}),
      applied,
      missing,
      hit,
      pass: !signal.aborted && missing.length === 0 && hit.length === 0 && report.outcome === "model_replied",
      workspace,
      home,
    };
  } finally {
    if (!opts.keep) {
      await rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
    }
  }
}
