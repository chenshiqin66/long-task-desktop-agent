import { isDangerousBash } from "./dangerous.js";

export type ToolRisk = "blocked" | "read" | "write";

export interface PolicyVerdict {
  risk: ToolRisk;
  /** Short human-readable summary for UI / logs. */
  summary: string;
  /** Parsed bash command when tool is bash; otherwise undefined. */
  command?: string;
}

/** Builtins treated as read-only when used alone (no write redirections / destructive ops). */
const READ_COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "find",
  "echo",
  "printf",
  "test",
  "[",
  "which",
  "where",
  "type",
  "file",
  "stat",
  "wc",
  "sort",
  "uniq",
  "diff",
  "tree",
  "basename",
  "dirname",
  "realpath",
  "true",
  "false",
  "get-childitem",
  "gci",
  "dir",
  "get-content",
  "gc",
  "get-item",
  "gi",
  "get-location",
  "gl",
  "select-string",
  "sls",
  "measure-object",
  "resolve-path",
  "split-path",
  "test-path",
  "write-output",
  "write-host",
  "get-command",
  "gcm",
  "get-date",
  "select-object",
  "where-object",
  "sort-object",
  "group-object",
  "compare-object",
  "get-filehash",
  "format-table",
  "format-list",
  "out-string",
  "out-host",
]);

const WRITEISH =
  /\b(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|truncate|tee|sed|install|ln|unlink|shred|git)\b/i;

/** Shell write redirections (not `2>` / `&>` stderr-only alone — treat `>` / `>>` as write). */
const WRITE_REDIRECT = /(?:^|[^0-9])>{1,2}(?!>)/;

function stripSimpleQuotes(s: string): string {
  return s.replace(/\\'/g, "").replace(/'[^']*'/g, " ").replace(/\\"/g, "").replace(/"[^"]*"/g, " ");
}

function firstTokens(command: string): string[] {
  const cleaned = command.trim().replace(/^\s*(?:sudo\s+)+/i, "");
  // Split on shell separators; classify each segment — any write-ish segment => write.
  return cleaned
    .split(/(?:&&|\|\||;|\n)/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function segmentLooksReadOnly(segment: string): boolean {
  const forScan = stripSimpleQuotes(segment);
  if (WRITE_REDIRECT.test(forScan)) return false;
  // Pipeline: every stage must be a known read command (git special-cased below).
  const stages = forScan.split("|").map((s) => s.trim()).filter(Boolean);
  if (stages.length === 0) return false;
  for (const stage of stages) {
    if (!stageIsReadOnly(stage)) return false;
  }
  return true;
}

function stageIsReadOnly(stage: string): boolean {
  const m = stage.match(/^\s*([a-zA-Z0-9_./+-]+)/);
  if (!m) return false;
  const cmd = m[1]!.toLowerCase();
  if (cmd === "git") {
    const rest = stage.slice(m[0].length).trim();
    const sub = (rest.match(/^([a-zA-Z0-9_-]+)/)?.[1] ?? "").toLowerCase();
    return sub === "status" || sub === "diff" || sub === "log" || sub === "show" || sub === "branch";
  }
  if (WRITEISH.test(cmd) && cmd !== "git") return false;
  return READ_COMMANDS.has(cmd);
}

export function classifyBashCommand(command: string): PolicyVerdict {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: "write", summary: "Empty shell command", command: trimmed };
  }
  if (isDangerousBash(trimmed)) {
    return { risk: "blocked", summary: "Blocked dangerous command", command: trimmed };
  }
  const segments = firstTokens(trimmed);
  if (segments.length > 0 && segments.every(segmentLooksReadOnly)) {
    return { risk: "read", summary: `Read-only: ${trimmed.slice(0, 120)}`, command: trimmed };
  }
  return { risk: "write", summary: `Needs confirmation: ${trimmed.slice(0, 120)}`, command: trimmed };
}

export function classifyToolCall(
  toolName: string,
  argsJson: string,
): PolicyVerdict {
  if (toolName === "ask_user") {
    return { risk: "read", summary: "Ask the user" };
  }
  if (
    toolName === "read_file" ||
    toolName === "list_dir" ||
    toolName === "keyword_search" ||
    toolName === "web_search"
  ) {
    return { risk: "read", summary: `Auto-allow ${toolName}` };
  }
  if (toolName === "bash" || toolName === "powershell") {
    let command = "";
    try {
      const args = argsJson ? (JSON.parse(argsJson) as { command?: unknown }) : {};
      command = String(args.command ?? "");
    } catch {
      return { risk: "write", summary: `${toolName} with invalid JSON args`, command: argsJson };
    }
    return classifyBashCommand(command);
  }
  if (toolName === "write_file" || toolName === "str_replace" || toolName === "delete_file") {
    let path = "";
    try {
      const args = argsJson ? (JSON.parse(argsJson) as { path?: unknown }) : {};
      path = String(args.path ?? "");
    } catch {
      return { risk: "write", summary: `${toolName} with invalid JSON args` };
    }
    const label = path ? `${toolName}: ${path}` : toolName;
    return { risk: "write", summary: `Needs confirmation: ${label.slice(0, 160)}` };
  }
  // Unknown tools: conservative.
  return { risk: "write", summary: `Needs confirmation: ${toolName}` };
}
