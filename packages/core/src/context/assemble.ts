import type { ImageAttachment, Message, ToolCall } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  readSkillHistoryStub,
  renderInstalledSkills,
  renderSkillBodies,
  type SkillBodyAttachment,
  type SkillCatalogEntry,
} from "../skills/prompt.js";
import { compressMessages } from "./compress.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL,
  repairToolCallPairs,
  type MissingToolResult,
} from "./repairToolCalls.js";
import { newId, nowIso } from "../ids.js";

/** Arguments longer than this are replaced on the outbound copy after a successful write. */
const TOOL_ARG_OMIT_THRESHOLD = 500;

export type OutboundContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface AssembledMessage {
  role: string;
  content: OutboundContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Present only before image bytes are inlined for the API call. */
  images?: ImageAttachment[];
}

export interface AssembledContext {
  messages: AssembledMessage[];
}

export function assembleContext(opts: {
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  history: Message[];
  currentUser: Message;
  contextCharLimit: number;
  installedSkills?: SkillCatalogEntry[];
  skillBodies?: SkillBodyAttachment[];
  /** Attached for this request only. Not written into the session transcript. */
  extraSystem?: string;
}): AssembledContext {
  const toolsBlock = opts.toolDefinitions
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`,
    )
    .join("\n");
  const preface = [
    opts.systemPrompt,
    renderInstalledSkills(opts.installedSkills ?? []),
    renderSkillBodies(opts.skillBodies ?? []),
    opts.extraSystem ?? "",
  ].filter((part) => part.length > 0);
  const systemContent = `${preface.join("\n\n")}\n\n# Tools\n${toolsBlock}`;
  const budget = Math.max(
    1000,
    opts.contextCharLimit - systemContent.length - opts.currentUser.content.length - 100,
  );
  // Shrink settled write payloads on a copy. Disk jsonl stays complete; compression
  // only sees message content, so this must happen even when that pass is a no-op.
  const viewed = elidePriorReadSkills(elideSettledWrites([...opts.history, opts.currentUser]));
  const history = viewed.slice(0, -1);
  const currentUser = viewed[viewed.length - 1]!;
  const compressed = compressMessages(history, { contextCharLimit: budget });
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

function shrinkSettledCall(tc: ToolCall, settled: boolean): ToolCall {
  if (!settled) return tc;
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
  const stub =
    tc.function.name === "write_file"
      ? {
          path,
          content_chars: typeof args.content === "string" ? args.content.length : 0,
          omitted: true,
        }
      : {
          path,
          old_chars: typeof args.old_string === "string" ? args.old_string.length : 0,
          new_chars: typeof args.new_string === "string" ? args.new_string.length : 0,
          ...(args.replace_all === true ? { replace_all: true } : {}),
          omitted: true,
        };
  return {
    ...tc,
    function: { ...tc.function, arguments: JSON.stringify(stub) },
  };
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
      const next = shrinkSettledCall(tc, succeeded.has(tc.id));
      if (next !== tc) changed = true;
      return next;
    });
    return changed ? { ...m, tool_calls } : m;
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
  };
}
