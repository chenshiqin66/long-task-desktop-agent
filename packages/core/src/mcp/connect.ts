import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redactSecrets } from "./redact.js";
import type { McpServerConfig } from "./store.js";
import { secretsOf } from "./store.js";

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenedMcp {
  tools: McpRemoteTool[];
  /** True when the server offered more than the cap and the rest were not registered. */
  truncated: boolean;
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

const LIST_CAP = 64;
const CONNECT_TIMEOUT_MS = 20_000;
const WIN_SHIMS = new Set(["npx", "npm", "pnpm", "yarn"]);

export async function openMcpSession(config: McpServerConfig, signal?: AbortSignal): Promise<OpenedMcp> {
  const client = new Client({ name: "long-task-agent", version: "0.1.0" });
  const secrets = secretsOf(config);
  if (config.transport === "http") {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      redirectPolicy: "same-origin",
    });
    await connectClient(client, transport, signal, secrets);
    const listed = await listRemoteTools(client, signal, secrets);
    return {
      tools: listed.tools,
      truncated: listed.truncated,
      call: (name, args, callSignal, timeoutMs) => callRemote(client, name, args, callSignal, timeoutMs, secrets),
      close: async () => {
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  }

  const transport = new StdioClientTransport({
    command: spawnCommand(config.command),
    args: config.args,
    env: spawnEnv(config.env),
    stderr: "pipe",
    ...(config.cwd ? { cwd: config.cwd } : {}),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  try {
    await connectClient(client, transport, signal, secrets, () => stderr);
  } catch (err) {
    await client.close().catch(() => undefined);
    killProcessTree(transport.pid);
    throw err;
  }
  const listed = await listRemoteTools(client, signal, secrets);
  return {
    tools: listed.tools,
    truncated: listed.truncated,
    call: (name, args, callSignal, timeoutMs) => callRemote(client, name, args, callSignal, timeoutMs, secrets),
    close: async () => {
      const pid = transport.pid;
      await client.close().catch(() => undefined);
      killProcessTree(pid);
    },
  };
}

/** `npx` is `npx.cmd` on Windows. Spawn stays `shell: false` inside the SDK. */
function spawnCommand(command: string): string {
  if (process.platform !== "win32") return command;
  const base = basename(command).toLowerCase();
  if (WIN_SHIMS.has(base)) return `${command}.cmd`;
  return command;
}

/** The SDK already keeps a safe parent environment. Add the Windows bits `.cmd` shims need. */
function spawnEnv(user: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.platform === "win32") {
    for (const key of ["PATHEXT", "COMSPEC"]) {
      const value = process.env[key];
      if (value && !(key in user)) env[key] = value;
    }
  }
  return { ...env, ...user };
}

async function connectClient(
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
  stderr?: () => string,
): Promise<void> {
  try {
    await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    const extra = stderr?.().trim();
    const message = extra ? `${String(err)}\n${extra}` : String(err);
    throw new Error(redactSecrets(message, secrets));
  }
}

async function listRemoteTools(
  client: Client,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<{ tools: McpRemoteTool[]; truncated: boolean }> {
  const tools: McpRemoteTool[] = [];
  let cursor: string | undefined;
  let truncated = false;
  try {
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: CONNECT_TIMEOUT_MS,
      });
      for (const tool of page.tools) {
        if (tools.length >= LIST_CAP) {
          truncated = true;
          break;
        }
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        });
      }
      cursor = truncated ? undefined : page.nextCursor;
    } while (cursor);
  } catch (err) {
    throw new Error(redactSecrets(String(err), secrets));
  }
  return { tools, truncated };
}

async function callRemote(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  secrets: readonly string[],
): Promise<{ text: string; isError: boolean }> {
  try {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: Math.max(1, timeoutMs) },
    );
    return flattenResult(result);
  } catch (err) {
    return { text: redactSecrets(String(err), secrets), isError: true };
  }
}

function flattenResult(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== "object") return { text: "MCP 工具没有返回文本", isError: true };
  const row = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  if (!Array.isArray(row.content)) {
    if (row.structuredContent && typeof row.structuredContent === "object") {
      return { text: JSON.stringify(row.structuredContent), isError: row.isError === true };
    }
    return { text: "MCP 工具没有返回文本", isError: true };
  }
  const lines: string[] = [];
  for (const part of row.content) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: string; text?: string; mimeType?: string; uri?: string; resource?: { uri?: string; text?: string } };
    if (item.type === "text" && typeof item.text === "string") lines.push(item.text);
    else if (item.type === "image") lines.push(`[image ${item.mimeType ?? ""}]`.trim());
    else if (item.type === "audio") lines.push(`[audio ${item.mimeType ?? ""}]`.trim());
    else if (item.type === "resource" && item.resource?.text) lines.push(item.resource.text);
    else if (item.type === "resource") lines.push(`[resource ${item.resource?.uri ?? ""}]`.trim());
    else if (item.type) lines.push(`[${item.type}]`);
  }
  const text = lines.join("\n").trim();
  return { text: text || "(empty)", isError: row.isError === true };
}

function killProcessTree(pid: number | null): void {
  if (!pid || process.platform !== "win32") return;
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
