import type { AudioAttachment, ImageAttachment, Message, ToolCall, VideoAttachment } from "../types.js";
import {
  readSkillHistoryStub,
  renderInstalledSkills,
  renderSkillBodies,
  type SkillBodyAttachment,
  type SkillCatalogEntry,
} from "../skills/prompt.js";
import { compressMessages, messageWireChars } from "./compress.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL,
  repairToolCallPairs,
  type MissingToolResult,
} from "./repairToolCalls.js";
import { newId, nowIso } from "../ids.js";

/** Arguments longer than this are replaced on the outbound copy after a successful write. */
const TOOL_ARG_OMIT_THRESHOLD = 500;
/** Share of contextCharLimit that the current turn's tool results may fill before the oldest are shortened. */
const TURN_RESULT_SHARE = 0.5;

export type OutboundContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "video_url"; video_url: { url: string } }
    >;

export interface AssembledMessage {
  role: string;
  content: OutboundContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Present only before image bytes are inlined for the API call. */
  images?: ImageAttachment[];
  /** Present only before video bytes are inlined for the API call. */
  videos?: VideoAttachment[];
  /** Present only before path notes replace audio for the API call. Never inlined for chat. */
  audios?: AudioAttachment[];
}

export interface AssembledContext {
  messages: AssembledMessage[];
}

export function assembleContext(opts: {
  systemPrompt: string;
  /** Instruction files and memory for this turn. Between the system prompt and the skill catalog. */
  memory?: string;
  history: Message[];
  currentUser: Message;
  contextCharLimit: number;
  installedSkills?: SkillCatalogEntry[];
  skillBodies?: SkillBodyAttachment[];
  /** Attached for this request only. Not written into the session transcript. */
  extraSystem?: string;
}): AssembledContext {
  const preface = [
    opts.systemPrompt,
    opts.memory ?? "",
    renderInstalledSkills(opts.installedSkills ?? []),
    renderSkillBodies(opts.skillBodies ?? []),
    opts.extraSystem ?? "",
  ].filter((part) => part.length > 0);
  const systemContent = preface.join("\n\n");
  // Outbound copy only. Disk jsonl stays complete.
  const prepared = elidePriorReadSkills(elideStaleFailedWrites(elideSettledWrites([...opts.history, opts.currentUser])));
  const keepCalls = currentTurnKeepIds(prepared, Math.floor(opts.contextCharLimit * TURN_RESULT_SHARE));
  const viewed = elideStaleToolResults(prepared, keepCalls);
  const history = viewed.slice(0, -1);
  const currentUser = viewed[viewed.length - 1]!;
  const budget = Math.max(
    1000,
    opts.contextCharLimit - systemContent.length - messageWireChars(currentUser) - 100,
  );
  const compressed = compressMessages(history, {
    contextCharLimit: budget,
    protectIds: protectIdsForCalls(viewed, keepCalls),
  });
  // Repair after joining: orphans may sit at end of history with currentUser after them.
  const repaired = repairToolCallPairs([...compressed, currentUser], (info: MissingToolResult) => ({
    id: newId("msg"),
    session_id: info.session_id,
    turn_id: info.turn_id,
    role: "tool",
    name: info.name,
    tool_call_id: info.tool_call_id,
    content: SYNTHETIC_INTERRUPTED_TOOL,
    is_error: true,
    created_at: nowIso(),
  }));
  const messages: AssembledMessage[] = [
    { role: "system", content: systemContent },
    ...repaired.map(toAssembled),
  ];
  return { messages };
}

function toolWriteSucceeded(m: Message): boolean {
  if (m.role !== "tool" || !m.tool_call_id) return false;
  if (m.is_error === true) return false;
  if (m.is_error === false) return true;
  // Older rows did not store is_error. Only the success sentences this runtime writes count.
  return /^Wrote \d+ chars to /.test(m.content) || /^Updated /.test(m.content);
}

function shrinkWriteCall(tc: ToolCall, outcome: "succeeded" | "failed"): ToolCall {
  if (tc.function.name !== "write_file" && tc.function.name !== "str_replace") return tc;
  if (tc.function.arguments.length <= TOOL_ARG_OMIT_THRESHOLD) return tc;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    return tc;
  }
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return tc;
  const failed = outcome === "failed";
  const note = writeStubNote(tc.function.name, path, args, failed);
  // The wire format needs a JSON string here. Its one field is prose, not a parameter,
  // so the model is not shown an argument shape it could copy.
  return {
    ...tc,
    function: { ...tc.function, arguments: JSON.stringify({ note }) },
  };
}

/**
 * The text a stubbed write leaves in the model's own call. It says what was cut and that it
 * is a note, not a parameter. The file on disk is untouched.
 */
function writeStubNote(name: string, path: string, args: Record<string, unknown>, failed: boolean): string {
  const tail = failed ? "这次调用失败，没有写入成功。" : "";
  if (name === "write_file") {
    const chars = typeof args.content === "string" ? args.content.length : 0;
    return `此处原为 write_file 写入 ${path} 的内容，共 ${chars} 字，已从发给模型的副本中省略。这是系统说明，不是你发出的参数，不要照这个格式调用工具。需要内容时用 read_file 读取磁盘上的文件。${tail}`;
  }
  const oldChars = typeof args.old_string === "string" ? args.old_string.length : 0;
  const newChars = typeof args.new_string === "string" ? args.new_string.length : 0;
  const all = args.replace_all === true ? "（全部替换）" : "";
  return `此处原为 str_replace 修改 ${path} 的参数：旧文本 ${oldChars} 字，新文本 ${newChars} 字${all}，已从发给模型的副本中省略。这是系统说明，不是你发出的参数，不要照这个格式调用工具。${tail}`;
}

/** Outbound copy only. read_skill results from earlier user turns become a one-line stub. */
export function elidePriorReadSkills(messages: Message[]): Message[] {
  let currentTurn = "";
  for (const message of messages) {
    if (message.role === "user") currentTurn = message.turn_id;
  }
  return messages.map((message) => {
    if (message.role !== "tool" || message.name !== "read_skill" || message.is_error) return message;
    if (message.turn_id === currentTurn) return message;
    return { ...message, content: stubFromToolMessage(message) };
  });
}

function stubFromToolMessage(message: Message): string {
  let name = "未知";
  let relative = "";
  if (message.tool_call_arguments) {
    try {
      const args = JSON.parse(message.tool_call_arguments) as { name?: unknown; path?: unknown };
      if (typeof args.name === "string" && args.name.trim()) name = args.name.trim();
      if (typeof args.path === "string" && args.path.trim()) relative = args.path.trim();
    } catch {
      /* keep defaults */
    }
  }
  return readSkillHistoryStub(name, relative);
}

/** Outbound copy only. Successful write_file / str_replace payloads become path + sizes. */
export function elideSettledWrites(messages: Message[]): Message[] {
  const succeeded = new Set<string>();
  for (const m of messages) {
    if (m.tool_call_id && toolWriteSucceeded(m)) succeeded.add(m.tool_call_id);
  }
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    let changed = false;
    const tool_calls = m.tool_calls.map((tc) => {
      const next = succeeded.has(tc.id) ? shrinkWriteCall(tc, "succeeded") : tc;
      if (next !== tc) changed = true;
      return next;
    });
    return changed ? { ...m, tool_calls } : m;
  });
}

/** The model has already seen this failure and replied. Later requests do not resend the body. */
export function elideStaleFailedWrites(messages: Message[]): Message[] {
  const stale = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role !== "tool" || message.is_error !== true || !message.tool_call_id) return;
    if (messages.slice(index + 1).some((later) => later.role === "assistant")) stale.add(message.tool_call_id);
  });
  if (stale.size === 0) return messages;
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message;
    let changed = false;
    const tool_calls = message.tool_calls.map((call) => {
      if (!stale.has(call.id)) return call;
      const next = shrinkWriteCall(call, "failed");
      if (next !== call) changed = true;
      return next;
    });
    return changed ? { ...message, tool_calls } : message;
  });
}

/**
 * Call ids whose results stay in full:
 * - the latest batch of tool calls, always, even over budget (the model just got these);
 * - the other tool results of the current user turn, newest first, until their total
 *   would pass keepChars. Older results in the turn are shortened like any other
 *   stale result. Without the cap, a long turn would keep every read and push the
 *   request past the context budget.
 */
export function currentTurnKeepIds(messages: Message[], keepChars: number): Set<string> {
  let currentTurn = "";
  for (const message of messages) {
    if (message.role === "user") currentTurn = message.turn_id;
  }
  const ids = new Set<string>();
  let used = 0;
  let latest: Message | undefined;
  for (const message of messages) {
    if (message.turn_id !== currentTurn || message.role !== "assistant" || !message.tool_calls?.length) continue;
    latest = message;
  }
  const latestIds = new Set(latest?.tool_calls?.map((call) => call.id) ?? []);
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id || !latestIds.has(message.tool_call_id)) continue;
    ids.add(message.tool_call_id);
    used += message.content.length;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.turn_id !== currentTurn || message.role !== "tool" || !message.tool_call_id) continue;
    if (ids.has(message.tool_call_id)) continue;
    used += message.content.length;
    if (used > keepChars) break;
    ids.add(message.tool_call_id);
  }
  return ids;
}

function protectIdsForCalls(messages: Message[], callIds: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  if (callIds.size === 0) return ids;
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.some((call) => callIds.has(call.id))) ids.add(message.id);
    if (message.role === "tool" && message.tool_call_id && callIds.has(message.tool_call_id)) ids.add(message.id);
  }
  return ids;
}

function isBulkResult(name: string): boolean {
  return (
    name === "read_file" ||
    name === "list_dir" ||
    name === "keyword_search" ||
    name === "web_search" ||
    name === "powershell" ||
    name === "bash" ||
    name === "read_skill" ||
    name === "memory_read" ||
    name.startsWith("mcp__")
  );
}

function toolArgs(message: Message): Record<string, unknown> {
  if (!message.tool_call_arguments) return {};
  try {
    const parsed = JSON.parse(message.tool_call_arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function preview(text: string): string {
  if (text.length <= 120) return text;
  return text.slice(0, 119) + "…";
}

function successfulWritePaths(messages: Message[]): Array<{ index: number; path: string }> {
  const callPath = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.function.name !== "write_file" && call.function.name !== "str_replace") continue;
      try {
        const args = JSON.parse(call.function.arguments) as { path?: unknown };
        if (typeof args.path === "string" && args.path.trim()) callPath.set(call.id, normPath(args.path));
      } catch {
        /* path stays unknown */
      }
    }
  }
  const writes: Array<{ index: number; path: string }> = [];
  messages.forEach((message, index) => {
    if (!message.tool_call_id || !toolWriteSucceeded(message)) return;
    const path = callPath.get(message.tool_call_id);
    if (path) writes.push({ index, path });
  });
  return writes;
}

function resultNote(name: string, overwritten: boolean, isError: boolean): string {
  if (name === "powershell" || name === "bash") {
    return isError ? "这次调用失败。不要为了看旧输出而重跑。" : "不要为了看旧输出而重跑。";
  }
  if (name === "web_search" || name === "keyword_search") {
    if (isError) return "这次调用失败。需要时再搜索。";
    if (name === "keyword_search" && overwritten) return "该路径之后被改过，要新内容再搜索。";
    if (name === "keyword_search") return "原文仍在磁盘上，需要时再搜索。";
    return "需要时再搜索。";
  }
  if (name === "memory_read") return isError ? "这次调用失败。需要时再调用。" : "需要时再调用。";
  if (name.startsWith("mcp__")) return isError ? "这次调用失败。需要时再调用。" : "需要时再调用。";
  if (isError) return "这次调用失败。需要时再读。";
  return overwritten ? "该路径之后被改过，要新内容再读。" : "原文仍在磁盘上，需要时再读。";
}

function omittedResult(name: string, detail: string, chars: number, note: string): string {
  const inside = detail ? `${detail}，${chars} 字` : `${chars} 字`;
  return `此前 ${name} 的结果已省略（${inside}）。${note}`;
}

/** Outbound copy only. Tool bodies the model has already used become one stable line. */
export function elideStaleToolResults(messages: Message[], keepCalls: ReadonlySet<string>): Message[] {
  const writes = successfulWritePaths(messages);
  return messages.map((message, index) => {
    if (message.role !== "tool" || !message.name || !isBulkResult(message.name)) return message;
    if (message.tool_call_id && keepCalls.has(message.tool_call_id)) return message;
    if (message.content.length <= TOOL_ARG_OMIT_THRESHOLD) return message;
    if (message.name === "read_skill" && message.is_error !== true) {
      return { ...message, content: stubFromToolMessage(message) };
    }
    const args = toolArgs(message);
    const path = normPath(argString(args, "path"));
    const overwritten = path.length > 0 && writes.some((write) => write.index > index && write.path === path);
    const detail =
      message.name === "web_search"
        ? preview(argString(args, "query"))
        : message.name === "powershell" || message.name === "bash"
          ? preview(argString(args, "command"))
          : message.name === "memory_read"
            ? preview(argString(args, "name"))
            : message.name.startsWith("mcp__") || message.name === "read_skill"
              ? ""
              : path;
    return {
      ...message,
      content: omittedResult(
        message.name,
        detail,
        message.content.length,
        resultNote(message.name, overwritten, message.is_error === true),
      ),
    };
  });
}

function toAssembled(m: Message): AssembledMessage {
  return {
    role: m.role,
    content: m.content,
    name: m.name,
    tool_call_id: m.tool_call_id,
    tool_calls: m.tool_calls,
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.videos?.length ? { videos: m.videos } : {}),
    ...(m.audios?.length ? { audios: m.audios } : {}),
  };
}
