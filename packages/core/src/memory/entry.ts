import { SECRET_IN_TEXT } from "../mcp/redact.js";
import { isSkillName, splitFrontmatter } from "../skills/frontmatter.js";

export const MEMORY_SCOPES = ["user", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
/** extracted: written by the background pass; edited: changed on the memory page; manual: written by hand. */
export type MemoryOrigin = "extracted" | "edited" | "manual";

export const DESCRIPTION_MAX = 150;
export const BODY_MAX = 2_000;
/** Larger files are listed as unreadable without being parsed. */
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;

export interface MemorySource {
  workspace: string;
  session: string;
  /** The user message that was the evidence. */
  message: string;
}

export interface MemoryEntry {
  scope: MemoryScope;
  /** File name without `.md`. */
  name: string;
  description: string;
  type: MemoryType;
  created: string;
  modified: string;
  origin: MemoryOrigin;
  source?: MemorySource;
  body: string;
}

export interface UnreadableMemory {
  scope: MemoryScope;
  file: string;
  reason: string;
}

export type ParsedMemory = { ok: true; entry: MemoryEntry } | { ok: false; reason: string };

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "user" || value === "project";
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** `user` notes hold for every project; `project` notes belong to one repository. */
export function typeFitsScope(type: MemoryType, scope: MemoryScope): boolean {
  if (type === "user") return scope === "user";
  if (type === "project") return scope === "project";
  return true;
}

/**
 * Null when the fields can be written. A description that is wholly quoted,
 * or is only `>` or `|`, would read back differently from the frontmatter.
 */
export function checkMemoryFields(input: {
  scope: MemoryScope;
  name: string;
  type: string;
  description: string;
  body: string;
}): string | null {
  if (!isSkillName(input.name)) return `名字不合法：${input.name}。只能用小写字母、数字和连字符，最长 64 个字符`;
  if (!isMemoryType(input.type)) return `类型不认识：${input.type}`;
  if (!typeFitsScope(input.type, input.scope)) {
    return input.type === "user" ? "user 类型只能放在所有项目" : "project 类型只能放在本项目";
  }
  const description = input.description.trim();
  if (!description) return "缺少描述";
  if (/[\r\n]/.test(description)) return "描述只能有一行";
  if (description.length > DESCRIPTION_MAX) return `描述超过 ${DESCRIPTION_MAX} 字`;
  if (/^(["']).*\1$/.test(description) || /^[>|]-?$/.test(description)) {
    return "描述不能整个加引号，也不能只有 > 或 |";
  }
  const body = input.body.trim();
  if (!body) return "正文为空";
  if (body.length > BODY_MAX) return `正文超过 ${BODY_MAX} 字`;
  return null;
}

const QUERY_SECRET = new RegExp(SECRET_IN_TEXT.source, "i");
const TOKEN_SHAPE = /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/;
/** Shorter configured values match ordinary words too often. */
const SECRET_MIN_CHARS = 6;

/** What kind of secret the text holds, or null. */
export function findSecret(text: string, secrets: readonly string[]): string | null {
  if (secrets.some((secret) => secret.length >= SECRET_MIN_CHARS && text.includes(secret))) return "配置里的密钥";
  if (QUERY_SECRET.test(text)) return "URL 里的密钥参数";
  if (TOKEN_SHAPE.test(text)) return "形似 API 令牌的字符串";
  return null;
}

function isoOr(value: string | undefined, fallback: Date): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback.toISOString();
}

/**
 * A hand-written file needs only `description`, `type` and a body. The name
 * comes from the file name, times from the file's mtime, and origin is manual.
 */
export function parseMemoryFile(
  raw: string,
  at: { scope: MemoryScope; fileName: string; mtime: Date },
): ParsedMemory {
  const stem = at.fileName.replace(/\.md$/i, "");
  let parts: { fields: Record<string, string>; body: string };
  try {
    parts = splitFrontmatter(raw);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const { fields } = parts;
  const name = (fields.name ?? "").trim() || stem;
  if (name !== stem) return { ok: false, reason: `name 是 ${name}，和文件名 ${stem} 不一致` };
  const type = (fields.type ?? "").trim();
  const description = fields.description ?? "";
  const problem = checkMemoryFields({ scope: at.scope, name, type, description, body: parts.body });
  if (problem) return { ok: false, reason: problem };
  const origin: MemoryOrigin =
    fields.origin === "extracted" ? "extracted" : fields.origin === "edited" ? "edited" : "manual";
  const entry: MemoryEntry = {
    scope: at.scope,
    name,
    description: description.trim(),
    type: type as MemoryType,
    created: isoOr(fields.created, at.mtime),
    modified: isoOr(fields.modified, at.mtime),
    origin,
    body: parts.body.trim(),
  };
  const workspace = fields.source_workspace?.trim();
  const session = fields.source_session?.trim();
  const message = fields.source_message?.trim();
  if (workspace && session && message) entry.source = { workspace, session, message };
  return { ok: true, entry };
}

export function serializeMemory(entry: MemoryEntry): string {
  const lines = [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description.trim()}`,
    `type: ${entry.type}`,
    `created: ${entry.created}`,
    `modified: ${entry.modified}`,
    `origin: ${entry.origin}`,
  ];
  if (entry.source) {
    lines.push(
      `source_workspace: ${entry.source.workspace}`,
      `source_session: ${entry.source.session}`,
      `source_message: ${entry.source.message}`,
    );
  }
  lines.push("---", entry.body.trim(), "");
  return lines.join("\n");
}
