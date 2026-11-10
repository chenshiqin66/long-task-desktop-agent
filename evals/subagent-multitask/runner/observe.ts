import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Message, RuntimeEvent, TaskRecord, ToolCall } from "@agent/core";
import type { RecordedExchange } from "./provider.js";
import type { RunMode } from "./policies.js";
import type { Layer } from "./types.js";

export interface ObservedResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
  parent_tool_call_id?: string;
  eventIndex: number;
}

export interface ObservedCall {
  call: ToolCall;
  args: Record<string, unknown>;
  /** 0-based parent response index; for subagents, the child response index. */
  batch: number;
  parentToolCallId?: string;
  result?: ObservedResult;
  eventIndex: number;
}

export interface InboxEntry {
  id: string;
  subagent_id: string;
  task_id?: string;
  content: string;
  ok: boolean;
}

export interface Observation {
  caseId: string;
  layer: Layer;
  mode: RunMode;
  workspace: string;
  sessionId: string;
  exchanges: RecordedExchange[];
  events: RuntimeEvent[];
  /** Calls made by the parent, in response order. */
  parentCalls: ObservedCall[];
  /** Calls made inside a subagent, in response order. */
  subagentCalls: ObservedCall[];
  toolResults: ObservedResult[];
  messages: Message[];
  tasksInitial: TaskRecord[];
  tasks: TaskRecord[];
  files: Record<string, string>;
  subagentDirs: string[];
  inbox: InboxEntry[];
  /** Text of the last parent response. */
  finalText: string;
  /** All parent response text, newest last. */
  parentText: string;
  errors: string[];
  timedOut: boolean;
}

export function argsOf(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

export function parentBatches(o: Observation): ToolCall[][] {
  return o.exchanges.filter((item) => item.kind === "parent" && item.toolCalls.length > 0).map((item) => item.toolCalls);
}

export function firstBatch(o: Observation): ToolCall[] {
  return o.exchanges.find((item) => item.kind === "parent")?.toolCalls ?? [];
}

export function callsNamed(o: Observation, name: string): ObservedCall[] {
  return o.parentCalls.filter((item) => item.call.function.name === name);
}

export function subagentCallsOf(o: Observation): ObservedCall[] {
  return o.parentCalls.filter((item) => item.call.function.name === "subagent");
}

export function subagentDirs(o: Observation): string[] {
  return o.subagentDirs;
}

export function taskById(o: Observation, id: string): TaskRecord | undefined {
  return o.tasks.find((task) => task.id === id);
}

export function hasFile(o: Observation, path: string): boolean {
  const wanted = path.replace(/\\/g, "/").toLowerCase();
  return Object.keys(o.files).some((key) => key.toLowerCase() === wanted);
}

export function fileContent(o: Observation, path: string): string {
  const wanted = path.replace(/\\/g, "/").toLowerCase();
  const key = Object.keys(o.files).find((item) => item.toLowerCase() === wanted);
  return key ? o.files[key]! : "";
}

export function eventIndexOf(o: Observation, toolCallId: string): number {
  const found = o.events.findIndex(
    (event) => event.type === "tool_call" && event.tool_call.id === toolCallId,
  );
  return found;
}

export function textMentionsAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function textMentionsAll(text: string, needles: readonly string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}

/** Compact evidence for a failing check, so a report does not need the transcript. */
export function callSummary(call: ObservedCall): string {
  const name = call.call.function.name;
  const args = call.args;
  const brief: Record<string, unknown> = {};
  for (const key of ["subagent_type", "delivery", "output_dir", "task_id", "path", "subject", "command"]) {
    if (args[key] !== undefined) brief[key] = args[key];
  }
  if (typeof args.task === "string") brief.task = args.task.length > 120 ? `${args.task.slice(0, 120)}…` : args.task;
  return `${name} ${JSON.stringify(brief)}`;
}

async function readFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".agent" || entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).replace(/\\/g, "/");
      try {
        const raw = await readFile(abs);
        if (raw.includes(0)) {
          files[rel] = `<binary ${raw.length} bytes>`;
          continue;
        }
        const text = raw.toString("utf8");
        files[rel] = text.length > 200_000 ? `${text.slice(0, 200_000)}\n…[truncated]` : text;
      } catch {
        files[rel] = "<unreadable>";
      }
    }
  }
  await walk(root);
  return files;
}

async function readSubagentDirs(root: string, sessionId: string): Promise<string[]> {
  try {
    const names = await readdir(join(root, ".agent", "sessions", sessionId, "subagents"), { withFileTypes: true });
    return names.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readInbox(root: string, sessionId: string): Promise<InboxEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, ".agent", "sessions", sessionId, "inbox.jsonl"), "utf8");
  } catch {
    return [];
  }
  const entries: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.op !== "enqueue" || typeof value.content !== "string") continue;
      entries.push({
        id: String(value.id ?? ""),
        subagent_id: String(value.subagent_id ?? ""),
        ...(typeof value.task_id === "string" && value.task_id ? { task_id: value.task_id } : {}),
        content: value.content,
        ok: value.ok !== false,
      });
    } catch {
      // ignore a torn line
    }
  }
  return entries;
}

export async function buildObservation(input: {
  caseId: string;
  layer: Layer;
  mode: RunMode;
  workspace: string;
  sessionId: string;
  exchanges: RecordedExchange[];
  events: RuntimeEvent[];
  messages: Message[];
  tasksInitial: TaskRecord[];
  tasks: TaskRecord[];
  timedOut: boolean;
}): Promise<Observation> {
  const results: ObservedResult[] = [];
  input.events.forEach((event, index) => {
    if (event.type !== "tool_result") return;
    results.push({
      tool_call_id: event.tool_call_id,
      content: event.content,
      is_error: event.is_error,
      ...(event.parent_tool_call_id ? { parent_tool_call_id: event.parent_tool_call_id } : {}),
      eventIndex: index,
    });
  });
  const resultById = new Map<string, ObservedResult>();
  for (const result of results) resultById.set(result.tool_call_id, result);

  const parentCalls: ObservedCall[] = [];
  let parentBatch = 0;
  for (const exchange of input.exchanges) {
    if (exchange.kind !== "parent" || exchange.toolCalls.length === 0) continue;
    for (const call of exchange.toolCalls) {
      parentCalls.push({
        call,
        args: argsOf(call),
        batch: parentBatch,
        result: resultById.get(call.id),
        eventIndex: input.events.findIndex(
          (event) => event.type === "tool_call" && event.tool_call.id === call.id,
        ),
      });
    }
    parentBatch += 1;
  }

  const subagentCalls: ObservedCall[] = [];
  let childBatch = 0;
  for (const exchange of input.exchanges) {
    if (exchange.kind !== "subagent" || exchange.toolCalls.length === 0) continue;
    const parentToolCallId = subagentParentCallId(input.events, exchange);
    for (const call of exchange.toolCalls) {
      subagentCalls.push({
        call,
        args: argsOf(call),
        batch: childBatch,
        parentToolCallId,
        result: resultById.get(call.id),
        eventIndex: input.events.findIndex(
          (event) => event.type === "tool_call" && event.tool_call.id === call.id,
        ),
      });
    }
    childBatch += 1;
  }

  const texts = input.exchanges.filter((item) => item.kind === "parent").map((item) => item.text);
  const errors = input.events
    .filter((event): event is Extract<RuntimeEvent, { type: "error" }> => event.type === "error")
    .map((event) => event.message);
  for (const exchange of input.exchanges) {
    if (exchange.error) errors.push(exchange.error);
  }

  return {
    caseId: input.caseId,
    layer: input.layer,
    mode: input.mode,
    workspace: input.workspace,
    sessionId: input.sessionId,
    exchanges: input.exchanges,
    events: input.events,
    parentCalls,
    subagentCalls,
    toolResults: results,
    messages: input.messages,
    tasksInitial: input.tasksInitial,
    tasks: input.tasks,
    files: await readFiles(input.workspace),
    subagentDirs: await readSubagentDirs(input.workspace, input.sessionId),
    inbox: await readInbox(input.workspace, input.sessionId),
    finalText: texts.length ? texts[texts.length - 1]! : "",
    parentText: texts.join("\n"),
    errors,
    timedOut: input.timedOut,
  };
}

/**
 * Find which parent tool call started this subagent. The subagent's own
 * messages do not carry it, but its tool events do.
 */
function subagentParentCallId(events: RuntimeEvent[], exchange: RecordedExchange): string | undefined {
  const ids = new Set(exchange.toolCalls.map((call) => call.id));
  for (const event of events) {
    if (event.type === "tool_result" && ids.has(event.tool_call_id)) return event.parent_tool_call_id;
    if (event.type === "tool_call" && ids.has(event.tool_call.id)) return event.parent_tool_call_id;
  }
  return undefined;
}
