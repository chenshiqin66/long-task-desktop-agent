import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { isMcpServerName } from "./names.js";

export interface McpServerInput {
  name: string;
  /** Human title. Not part of the tool name. */
  label?: string;
  enabled?: boolean;
  autoAllow?: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export interface McpStdioServer {
  name: string;
  label: string;
  enabled: boolean;
  autoAllow: boolean;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServer {
  name: string;
  label: string;
  enabled: boolean;
  autoAllow: boolean;
  transport: "http";
  url: string;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

const LABEL_MAX = 40;
const ARG_MAX = 32;
const ARG_LEN = 2000;
const ENV_MAX = 32;
const ENV_VAL_LEN = 8000;
const COMMAND_LEN = 500;
const URL_LEN = 2000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultMcpConfigPath(): string {
  return join(homedir(), ".long-task-agent", "mcp-servers.json");
}

export function secretsOf(config: McpServerConfig): string[] {
  if (config.transport === "http") return [config.url];
  return Object.values(config.env);
}

export function normalizeMcpServer(input: McpServerInput, previous?: McpServerConfig): McpServerConfig {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!isMcpServerName(name)) {
    throw new Error("名称须是 1–32 位小写字母、数字和单个连字符");
  }
  if (previous && previous.name !== name) throw new Error("不能改服务器名称");
  const label = displayLabel(input, name, previous);
  const enabled = typeof input.enabled === "boolean" ? input.enabled : (previous?.enabled ?? true);
  const autoAllow = typeof input.autoAllow === "boolean" ? input.autoAllow : (previous?.autoAllow ?? false);
  if (input.transport === "http") return { name, label, enabled, autoAllow, transport: "http", url: httpUrl(input, previous) };
  if (input.transport === "stdio") {
    return { name, label, enabled, autoAllow, transport: "stdio", ...stdioFields(input, previous) };
  }
  throw new Error("传输只能是本机命令或远程地址");
}

function displayLabel(input: McpServerInput, name: string, previous?: McpServerConfig): string {
  if (typeof input.label !== "string") return previous?.label ?? name;
  const label = input.label.trim();
  if (!label) return name;
  if (label.length > LABEL_MAX || label.includes("\0") || /[\r\n]/.test(label)) {
    throw new Error("显示名最长 40 字，不能换行");
  }
  return label;
}

function httpUrl(input: McpServerInput, previous?: McpServerConfig): string {
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) {
    if (previous?.transport === "http") return previous.url;
    throw new Error("填写 Streamable HTTP 地址");
  }
  if (raw.length > URL_LEN) throw new Error("地址过长");
  if (raw.includes("***")) throw new Error("地址里不能带打码占位。留空则保持原地址");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("地址无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("地址只能是 http 或 https");
  url.hash = "";
  return url.toString();
}

function stdioFields(
  input: McpServerInput,
  previous?: McpServerConfig,
): Pick<McpStdioServer, "command" | "args" | "env" | "cwd"> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("填写要启动的命令");
  if (command.length > COMMAND_LEN || command.includes("\0") || /[\r\n]/.test(command)) {
    throw new Error("命令无效");
  }
  if (input.args != null && !Array.isArray(input.args)) throw new Error("参数须是字符串列表");
  const args = (input.args ?? []).map((arg) => {
    if (typeof arg !== "string" || !arg || arg.length > ARG_LEN || arg.includes("\0")) {
      throw new Error("每个参数须是不含空字符的非空字符串，最长 2000");
    }
    return arg;
  });
  if (args.length > ARG_MAX) throw new Error(`参数最多 ${ARG_MAX} 个`);
  const env = mergeEnv(input.env, previous?.transport === "stdio" ? previous.env : {});
  const cwdRaw = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwdRaw) return { command, args, env };
  if (cwdRaw.length > COMMAND_LEN || cwdRaw.includes("\0")) throw new Error("工作目录无效");
  return { command, args, env, cwd: cwdRaw };
}

function mergeEnv(input: Record<string, string> | undefined, previous: Record<string, string>): Record<string, string> {
  if (input == null) return { ...previous };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("环境变量无效");
  const entries = Object.entries(input);
  if (entries.length > ENV_MAX) throw new Error(`环境变量最多 ${ENV_MAX} 个`);
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw new Error(`环境变量名无效：${key}`);
    if (typeof value !== "string" || value.length > ENV_VAL_LEN || value.includes("\0")) {
      throw new Error(`环境变量 ${key} 的值无效`);
    }
    if ((value === "***" || value === "") && key in previous) env[key] = previous[key]!;
    else if (value !== "***") env[key] = value;
  }
  return env;
}

export async function loadMcpServers(
  path: string,
): Promise<{ servers: McpServerConfig[]; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: [] };
    return { servers: [], error: "MCP 配置读不出来" };
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { servers: [], error: "MCP 配置不是合法 JSON，没有改这个文件" };
  }
  const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers)
    ? (parsed as { servers: unknown[] }).servers
    : null;
  if (!rows) return { servers: [], error: "MCP 配置缺少 servers 数组，没有改这个文件" };
  const servers: McpServerConfig[] = [];
  const bad: string[] = [];
  for (const row of rows) {
    try {
      servers.push(normalizeMcpServer(row as McpServerInput));
    } catch (err) {
      bad.push(err instanceof Error ? err.message : String(err));
    }
  }
  const names = new Set<string>();
  const unique = servers.filter((server) => {
    if (names.has(server.name)) {
      bad.push(`重复的名称 ${server.name}`);
      return false;
    }
    names.add(server.name);
    return true;
  });
  return { servers: unique, ...(bad.length ? { error: bad.join("；") } : {}) };
}

export async function saveMcpServers(path: string, servers: readonly McpServerConfig[]): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => undefined);
  const body = JSON.stringify({ servers }, null, 2);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") {
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
  await chmod(path, 0o600).catch(() => undefined);
}
