import { isDangerousBash } from "./dangerous.js";
import { AGENT_TOOL_NAME } from "./agentTool.js";
import { isTaskTool } from "./taskTools.js";

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

/** A redirect with its stream prefix (`2>`, `*>`, `&>`, `>|`) and its target. */
const REDIRECT = /(?:\d+|[&*])?>{1,2}\|?\s*([^\s|]*)/g;

/** Redirect targets that do not create a file. */
const DISCARD_TARGETS = new Set(["/dev/null", "$null", "&1", "&2"]);

/** `;`, `&&`, `||`, a newline, or a lone `&`. `2>&1` and `&>` are redirects, not separators. */
const SEPARATOR = /&&|\|\||;|\r?\n|\r|(?<![>&<])&(?![>&])/g;

/** Control characters that bash and PowerShell do not split the same way. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Every quote character either shell honors, plus bash's escape. Removed when reading a word. */
const QUOTE_CHARS = /["'\\\u2018-\u201e]/g;

type Shell = "bash" | "powershell";

/** PowerShell also closes strings with typographic quotes. bash treats them as text. */
const SINGLE_QUOTES: Record<Shell, string> = { bash: "'", powershell: "'\u2018\u2019\u201a\u201b" };
const DOUBLE_QUOTES: Record<Shell, string> = { bash: '"', powershell: '"\u201c\u201d\u201e' };

interface ScannedCommand {
  /** Same length as the command. Quoted, escaped, and commented text is blanked, leaving live operators only. */
  bare: string;
  /** The command with comments blanked, for reading words. */
  code: string;
  /** Command substitution, a subexpression or script block, or syntax the scan does not model. */
  nested: boolean;
}

/**
 * One shell's view of which characters are live syntax. A quote or comment that ends
 * in a different place than the shell ends it would hide a redirect or a whole command,
 * so each shell is scanned by its own rules and unmodeled syntax counts as nested.
 */
function scanCommand(command: string, shell: Shell): ScannedCommand {
  const ps = shell === "powershell";
  const singles = SINGLE_QUOTES[shell];
  const doubles = DOUBLE_QUOTES[shell];
  let bare = "";
  let code = "";
  let nested = false;
  let state: "plain" | "single" | "ansi" | "double" | "brace" | "comment" = "plain";
  let wordStart = true;
  const live = (text: string) => {
    bare += text;
    code += text;
  };
  const hidden = (text: string) => {
    bare += " ".repeat(text.length);
    code += text;
  };
  const dropped = (text: string) => {
    bare += " ".repeat(text.length);
    code += " ".repeat(text.length);
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1] ?? "";
    if (state === "comment") {
      if (ch === "\n" || ch === "\r") {
        state = "plain";
        wordStart = true;
        live(ch);
      } else {
        dropped(ch);
      }
      continue;
    }
    if (state === "single") {
      if (singles.includes(ch)) state = "plain";
      hidden(ch);
      continue;
    }
    if (state === "ansi" || state === "double") {
      // bash escapes any character inside $'...', and only these inside "...".
      if (!ps && ch === "\\" && next && (state === "ansi" || '"\\$`\n'.includes(next))) {
        hidden(ch + next);
        i += 1;
        continue;
      }
      if (state === "ansi" ? ch === "'" : doubles.includes(ch)) state = "plain";
      else if (state === "double" && (ch === "`" || (ch === "$" && next === "("))) nested = true;
      hidden(ch);
      continue;
    }
    if (state === "brace") {
      if (ch === "}") state = "plain";
      else if (ch === "`") nested = true;
      hidden(ch);
      continue;
    }
    if (!ps && ch === "\\") {
      // A line continuation disappears; any other escaped character joins the current word.
      if (next !== "\n") wordStart = false;
      hidden(ch + next);
      i += 1;
      continue;
    }
    // bash ANSI-C quoting, and PowerShell's ${...}, whose name may hold any character.
    const opener = !ps && ch === "$" && next === "'" ? "ansi" : ps && ch === "$" && next === "{" ? "brace" : null;
    if (opener) {
      state = opener;
      wordStart = false;
      hidden(ch + next);
      i += 1;
      continue;
    }
    if (singles.includes(ch) || doubles.includes(ch)) {
      state = singles.includes(ch) ? "single" : "double";
      wordStart = false;
      hidden(ch);
      continue;
    }
    if (ch === "#" && wordStart) {
      state = "comment";
      dropped(ch);
      continue;
    }
    if (
      ch === "`" ||
      ch === "(" ||
      (ch === "{" && command[i - 1] !== "$") ||
      (!ps && command.startsWith("<<", i)) ||
      (ps && ch === "#") ||
      (ps && ch === "@" && (singles + doubles).includes(next)) ||
      (ps && ch === "<" && next === "#") ||
      (ps && command.startsWith("--%", i))
    ) {
      nested = true;
    }
    wordStart = (ps ? /[\s;&|]/ : /[\s;&|<>()]/).test(ch);
    live(ch);
  }
  return { bare, code, nested };
}

/** Cuts `code` and `bare` at the same places: wherever `separator` matches in `bare`. */
function cutAt(code: string, bare: string, separator: RegExp): Array<[string, string]> {
  const parts: Array<[string, string]> = [];
  let start = 0;
  for (const match of bare.matchAll(separator)) {
    parts.push([code.slice(start, match.index), bare.slice(start, match.index)]);
    start = match.index! + match[0].length;
  }
  parts.push([code.slice(start), bare.slice(start)]);
  return parts;
}

function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

function looksReadOnly(command: string, shell: Shell): boolean {
  const { bare, code, nested } = scanCommand(command, shell);
  if (nested) return false;
  // Classify each segment; any write-ish segment => write.
  const segments = cutAt(code, bare, SEPARATOR).filter(([text]) => text.trim());
  return segments.length > 0 && segments.every(segmentLooksReadOnly);
}

function segmentLooksReadOnly([code, bare]: [string, string]): boolean {
  let text = code;
  let live = bare;
  for (const match of bare.matchAll(REDIRECT)) {
    if (!DISCARD_TARGETS.has(match[1]!.toLowerCase())) return false;
    text = blank(text, match.index!, match[0].length);
    live = blank(live, match.index!, match[0].length);
  }
  // Pipeline: every stage must be a known read command (git special-cased below).
  const stages = cutAt(text, live, /\|/g)
    .map(([stage]) => stage)
    .filter((stage) => stage.trim());
  return stages.length > 0 && stages.every(stageIsReadOnly);
}

/** Fetch commands that print to stdout. GNU wget is omitted: it saves a file by default. */
const WEB_GET_CMDS = new Set([
  "curl",
  "curl.exe",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
]);

const DIR_ONLY = new Set([
  "cd",
  "set-location",
  "sl",
  "push-location",
  "pop-location",
  "pushd",
  "popd",
]);

/** curl long options that save a file, read options from a file, upload, or send data. curl takes unambiguous prefixes. */
const CURL_WRITE_LONG = [
  "output",
  "output-dir",
  "remote-name",
  "remote-name-all",
  "upload-file",
  "dump-header",
  "cookie-jar",
  "config",
  "trace",
  "trace-ascii",
  "stderr",
  "libcurl",
  "etag-save",
  "hsts",
  "alt-svc",
  "data",
  "data-raw",
  "data-binary",
  "data-urlencode",
  "data-ascii",
  "form",
  "form-string",
  "json",
];

/** curl short options with the same effects. They count inside a cluster such as `-sSo` too. */
const CURL_WRITE_SHORT = /[oOTdFDcK]/;

/** Invoke-WebRequest / Invoke-RestMethod parameters, common parameters included. */
const PS_WEB_PARAMS = [
  "uri",
  "usebasicparsing",
  "websession",
  "sessionvariable",
  "credential",
  "usedefaultcredentials",
  "certificate",
  "certificatethumbprint",
  "useragent",
  "disablekeepalive",
  "timeoutsec",
  "headers",
  "maximumredirection",
  "method",
  "proxy",
  "proxycredential",
  "proxyusedefaultcredentials",
  "body",
  "contenttype",
  "transferencoding",
  "infile",
  "outfile",
  "passthru",
  "form",
  "custommethod",
  "cm",
  "resume",
  "skipcertificatecheck",
  "skiphttperrorcheck",
  "skipheadervalidation",
  "authentication",
  "token",
  "maximumretrycount",
  "retryintervalsec",
  "verbose",
  "debug",
  "erroraction",
  "errorvariable",
  "warningaction",
  "warningvariable",
  "informationaction",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
];

/** Parameters above that save a file, upload one, send a body, or pick an arbitrary method (`-cm` is an alias). */
const PS_WEB_WRITES = new Set(["outfile", "infile", "body", "form", "custommethod", "cm", "resume"]);

/** GNU sort flags that take no value, so `-bo out.txt` reads as `-b -o out.txt`. */
const SORT_FLAGS = new Set("bdfgiMhnRrVcCmsuz");

/** find actions that delete, run a program, or write a file. */
const FIND_WRITE_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch"]);

/** git branch flags that only list. Any other flag, or a bare name, creates, renames, copies, or deletes a branch. */
const GIT_BRANCH_LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-l",
  "--list",
  "-v",
  "--verbose",
  "-i",
  "--ignore-case",
  "--show-current",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
  "--abbrev",
  "--no-abbrev",
  "--sort",
  "--format",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
]);

/** List flags whose value may be the next word. */
const GIT_BRANCH_VALUE_FLAGS = new Set([
  "--sort",
  "--format",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
]);

/** Flags that make an otherwise read-only command write a file, run another program, or evaluate code. */
const WRITES_WITH = new Map<string, (args: string[]) => boolean>([
  ["find", (args) => args.some((arg) => FIND_WRITE_ACTIONS.has(arg))],
  ["sort", sortWrites],
  ["tree", (args) => args.some((arg) => arg.startsWith("--o") || /^-[a-zA-Z]*[oR]/.test(arg))],
  ["uniq", (args) => args.filter((arg) => !arg.startsWith("-")).length > 1],
  ["rg", (args) => args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))],
  ["file", (args) => args.some((arg) => arg === "--compile" || /^-[a-zA-Z]*C/.test(arg))],
  // bash evaluates an array subscript in the variable name, $(...) included.
  ["test", (args) => args.includes("-v") || args.includes("-R")],
  ["printf", printfAssigns],
  // Windows PowerShell 5.1 makes `curl` an alias of Invoke-WebRequest.
  ["curl", (args) => curlWrites(args) || psWebWrites(args)],
  ["curl.exe", curlWrites],
  ["invoke-webrequest", psWebWrites],
  ["iwr", psWebWrites],
  ["invoke-restmethod", psWebWrites],
  ["irm", psWebWrites],
]);

/** bash's printf reads options until the format: `-v NAME` and `-vNAME` both assign. */
function printfAssigns(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (arg.includes("v")) return true;
  }
  return false;
}

function sortWrites(args: string[]): boolean {
  return args.some((arg) => {
    if (arg.startsWith("--")) return arg.startsWith("--o") || arg.startsWith("--com");
    if (!arg.startsWith("-")) return false;
    for (const flag of arg.slice(1)) {
      if (flag === "o") return true;
      // A value flag takes the rest of the word; an unknown letter makes sort exit.
      if (!SORT_FLAGS.has(flag)) return false;
    }
    return false;
  });
}

function sendsData(method: string): boolean {
  return !/^(get|head)$/i.test(method.trim());
}

/** True when curl would write a file or send a mutating method. */
function curlWrites(args: string[]): boolean {
  return args.some((arg, i) => {
    const next = args[i + 1] ?? "";
    if (arg.toLowerCase().includes("%output{")) return true;
    if (arg.startsWith("--")) {
      const [name = "", value] = arg.slice(2).toLowerCase().split("=", 2);
      if (!name) return false;
      if (CURL_WRITE_LONG.some((option) => option.startsWith(name))) return true;
      return "request".startsWith(name) && sendsData(value ?? next);
    }
    if (!arg.startsWith("-")) return false;
    const letters = /^-([a-zA-Z]*)/.exec(arg)![1]!;
    if (CURL_WRITE_SHORT.test(letters)) return true;
    const method = letters.indexOf("X");
    return method >= 0 && sendsData(letters.slice(method + 1) || next);
  });
}

/** The parameter a single-dash word names, if PowerShell accepts it. PowerShell takes unambiguous prefixes. */
function psParameter(arg: string, names: readonly string[]): string | undefined {
  const name = arg.slice(1).split(":")[0]!.toLowerCase();
  if (!name) return undefined;
  if (names.includes(name)) return name;
  const matches = names.filter((param) => param.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** True when Invoke-WebRequest / Invoke-RestMethod would write a file or send data. */
function psWebWrites(args: string[]): boolean {
  return args.some((arg, i) => {
    // An unknown or ambiguous parameter stops PowerShell before the request.
    const param = arg.startsWith("-") ? psParameter(arg, PS_WEB_PARAMS) : undefined;
    if (!param) return false;
    if (PS_WEB_WRITES.has(param)) return true;
    const colon = arg.indexOf(":");
    return param === "method" && sendsData((colon >= 0 && arg.slice(colon + 1)) || args[i + 1] || "");
  });
}

/** `git branch` with listing flags only. `-av` counts as `-a -v`. */
function gitBranchListsOnly(args: string[]): boolean {
  const listing = args.includes("-l") || args.includes("--list");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (!listing) return false;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(arg)) {
      if (![...arg.slice(1)].every((flag) => GIT_BRANCH_LIST_FLAGS.has(`-${flag}`))) return false;
      continue;
    }
    const name = arg.split("=")[0]!;
    if (!GIT_BRANCH_LIST_FLAGS.has(name)) return false;
    const following = args[i + 1];
    if (GIT_BRANCH_VALUE_FLAGS.has(name) && !arg.includes("=") && following && !following.startsWith("-")) i += 1;
  }
  return true;
}

function gitIsReadOnly(args: string[]): boolean {
  const [sub = "", ...rest] = args;
  if (!GIT_READ_SUBCOMMANDS.has(sub.toLowerCase())) return false;
  if (rest.some((arg) => arg.startsWith("--output"))) return false;
  return sub.toLowerCase() === "branch" ? gitBranchListsOnly(rest) : true;
}

function stageIsReadOnly(stage: string): boolean {
  // The shell joins quoted and escaped pieces into one word, so `gi"t"` runs git and `find . '-delete'` deletes.
  const words = stage.replace(QUOTE_CHARS, "").trim().split(/\s+/);
  const cmd = words[0]!.toLowerCase();
  if (!/^[a-z0-9_./+-]+$/.test(cmd)) return false;
  const args = words.slice(1);
  if (cmd === "git") return gitIsReadOnly(args);
  if (WRITEISH.test(cmd)) return false;
  if (WRITES_WITH.get(cmd)?.(args)) return false;
  return READ_COMMANDS.has(cmd) || DIR_ONLY.has(cmd) || WEB_GET_CMDS.has(cmd);
}

export function classifyBashCommand(command: string): PolicyVerdict {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: "write", summary: "Empty shell command", command: trimmed };
  }
  // PowerShell reads an en dash, em dash, or horizontal bar as a parameter dash.
  const scan = trimmed.replace(/[\u2013\u2014\u2015]/g, "-");
  if (isDangerousBash(scan)) {
    return { risk: "blocked", summary: "Blocked dangerous command", command: trimmed };
  }
  // Judged under both shells' rules, so the verdict does not depend on which one this OS runs.
  if (!CONTROL_CHARS.test(scan) && looksReadOnly(scan, "bash") && looksReadOnly(scan, "powershell")) {
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
  if (isTaskTool(toolName)) {
    return { risk: "read", summary: `Auto-allow ${toolName}` };
  }
  if (toolName === AGENT_TOOL_NAME) {
    let subagentType = "";
    let outputDir = "";
    try {
      const args = argsJson
        ? (JSON.parse(argsJson) as { subagent_type?: unknown; output_dir?: unknown })
        : {};
      subagentType = typeof args.subagent_type === "string" ? args.subagent_type : "";
      outputDir = typeof args.output_dir === "string" ? args.output_dir : "";
    } catch {
      return { risk: "write", summary: "subagent with invalid JSON args" };
    }
    if (subagentType === "explore") return { risk: "read", summary: "Auto-allow explore subagent" };
    const label = outputDir ? `worker writes under ${outputDir}` : "worker subagent";
    return { risk: "write", summary: `Needs confirmation: ${label.slice(0, 160)}` };
  }
  if (
    toolName === "read_file" ||
    toolName === "list_dir" ||
    toolName === "keyword_search" ||
    toolName === "web_search" ||
    toolName === "read_skill"
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
  if (toolName === "run_skill_script") {
    let label = toolName;
    try {
      const args = argsJson ? (JSON.parse(argsJson) as { name?: unknown; path?: unknown }) : {};
      const name = typeof args.name === "string" ? args.name : "";
      const path = typeof args.path === "string" ? args.path : "";
      label = [toolName, name, path].filter(Boolean).join(" ");
    } catch {
      return { risk: "write", summary: "run_skill_script with invalid JSON args" };
    }
    return { risk: "write", summary: `Needs confirmation: ${label.slice(0, 160)}` };
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
