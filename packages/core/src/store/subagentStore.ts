import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../ids.js";
import type { Message, TraceEvent } from "../types.js";
import { assertValidSessionId, sessionDir } from "./sessionStore.js";
import type { SubagentType } from "../tools/agentTool.js";

/** New records use subagent_. agent_ stays valid so sessions written before the rename still load. */
const SUBAGENT_ID_RE = /^(?:sub)?agent_[A-Za-z0-9]+$/;

export function assertValidAgentId(agentId: string): void {
  if (!SUBAGENT_ID_RE.test(agentId)) throw new Error(`Invalid subagent id: ${JSON.stringify(agentId)}`);
}

export function isSubagentId(id: string): boolean {
  return SUBAGENT_ID_RE.test(id);
}

export function subagentDir(workspacePath: string, sessionId: string, agentId: string): string {
  assertValidSessionId(sessionId);
  assertValidAgentId(agentId);
  return join(sessionDir(workspacePath, sessionId), "subagents", agentId);
}

export interface SubagentMeta {
  agent_id: string;
  session_id: string;
  turn_id: string;
  parent_turn_id: string;
  parent_tool_call_id: string;
  subagent_type: SubagentType;
  description: string;
  output_dir?: string;
  status: "running" | "completed" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
}

export class SubagentStore {
  private readonly knownTools = new Set<string>();

  constructor(private readonly dir: string) {}

  static async create(dir: string, meta: SubagentMeta): Promise<SubagentStore> {
    await mkdir(dir, { recursive: true });
    const store = new SubagentStore(dir);
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeFile(join(dir, "messages.jsonl"), "", "utf8");
    await writeFile(join(dir, "trace.jsonl"), "", "utf8");
    await writeFile(join(dir, "context.jsonl"), "", "utf8");
    return store;
  }

  async updateMeta(patch: Partial<SubagentMeta> & Pick<SubagentMeta, "status">): Promise<void> {
    const current = JSON.parse(await readFile(join(this.dir, "meta.json"), "utf8")) as SubagentMeta;
    const next: SubagentMeta = { ...current, ...patch, updated_at: nowIso() };
    await writeFile(join(this.dir, "meta.json"), JSON.stringify(next, null, 2), "utf8");
  }

  async appendMessage(message: Message): Promise<void> {
    await appendFile(join(this.dir, "messages.jsonl"), JSON.stringify(message) + "\n", "utf8");
  }

  async appendTrace(event: TraceEvent): Promise<void> {
    await appendFile(join(this.dir, "trace.jsonl"), JSON.stringify(event) + "\n", "utf8");
  }

  /** Same shape as the session context.jsonl: one tools row per schema, then request rows. */
  async appendContext(toolsSha: string, tools: unknown, request: unknown): Promise<void> {
    const path = join(this.dir, "context.jsonl");
    if (!this.knownTools.has(toolsSha)) {
      await appendFile(path, JSON.stringify({ type: "tools", sha256: toolsSha, tools }) + "\n", "utf8");
      this.knownTools.add(toolsSha);
    }
    await appendFile(path, JSON.stringify(request) + "\n", "utf8");
  }
}

export interface SubagentToolRow {
  parent_tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
  arguments?: string;
}

/** Tool rows from every subagent under a session, for the transcript. Not a file-page view. */
export async function listSubagentToolRows(
  workspacePath: string,
  sessionId: string,
): Promise<SubagentToolRow[]> {
  assertValidSessionId(sessionId);
  const root = join(sessionDir(workspacePath, sessionId), "subagents");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows: SubagentToolRow[] = [];
  for (const name of names) {
    if (!SUBAGENT_ID_RE.test(name)) continue;
    let meta: SubagentMeta;
    try {
      meta = JSON.parse(await readFile(join(root, name, "meta.json"), "utf8")) as SubagentMeta;
    } catch {
      continue;
    }
    let raw = "";
    try {
      raw = await readFile(join(root, name, "messages.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      if (message.role !== "tool") continue;
      rows.push({
        parent_tool_call_id: meta.parent_tool_call_id,
        name: message.name ?? "",
        content: message.content,
        is_error: message.is_error === true,
        ...(message.tool_call_arguments ? { arguments: message.tool_call_arguments } : {}),
      });
    }
  }
  return rows;
}

const SUBAGENT_STATUSES = new Set<SubagentMeta["status"]>(["running", "completed", "error", "cancelled"]);

/** agent id → status. Missing ids are not running. Unreadable meta files are skipped. */
export async function listSubagentStatuses(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, SubagentMeta["status"]>> {
  assertValidSessionId(sessionId);
  const root = join(sessionDir(workspacePath, sessionId), "subagents");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const statuses: Record<string, SubagentMeta["status"]> = {};
  for (const name of names) {
    if (!SUBAGENT_ID_RE.test(name)) continue;
    try {
      const meta = JSON.parse(await readFile(join(root, name, "meta.json"), "utf8")) as Partial<SubagentMeta>;
      if (meta.status && SUBAGENT_STATUSES.has(meta.status)) statuses[name] = meta.status;
    } catch {
      continue;
    }
  }
  return statuses;
}
