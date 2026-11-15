import { truncateOutput } from "../tools/bash.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { exposeToolName } from "./names.js";
import { openMcpSession, type OpenedMcp } from "./connect.js";
import { redactSecrets, redactUrl } from "./redact.js";
import type { McpToolSource } from "./source.js";
import {
  defaultMcpConfigPath,
  loadMcpServers,
  normalizeMcpServer,
  saveMcpServers,
  secretsOf,
  type McpServerConfig,
  type McpServerInput,
} from "./store.js";

export type { McpServerInput } from "./store.js";
export type { McpToolSource } from "./source.js";

export type McpOpener = (config: McpServerConfig, signal?: AbortSignal) => Promise<OpenedMcp>;

export interface McpServerView {
  name: string;
  enabled: boolean;
  autoAllow: boolean;
  transport: "stdio" | "http";
  summary: string;
  state: "disabled" | "connecting" | "connected" | "error";
  tools: string[];
  error?: string;
  note?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  cwd?: string;
}

export interface McpSnapshot {
  servers: McpServerView[];
  fileError?: string;
}

type Slot = {
  state: McpServerView["state"];
  error?: string;
  note?: string;
  /** Exposed name → remote tool name. */
  exposed: Map<string, string>;
  opened?: OpenedMcp;
};

const CONNECT_TIMEOUT_MS = 20_000;
const DESC_MAX = 800;

/**
 * One process-wide set of MCP sessions. Every runtime snapshots `currentTools()`
 * at the start of a turn; calls go through the live session.
 */
export class McpPool implements McpToolSource {
  private configs: McpServerConfig[] = [];
  private readonly slots = new Map<string, Slot>();
  private readonly generation = new Map<string, number>();
  private fileError?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: McpSnapshot) => void>();
  private readonly open: McpOpener;
  private readonly path: string;

  constructor(opts?: { path?: string; open?: McpOpener }) {
    this.path = opts?.path ?? defaultMcpConfigPath();
    this.open = opts?.open ?? openMcpSession;
  }

  onStatus(listener: (snapshot: McpSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): McpSnapshot {
    return {
      servers: this.configs.map((config) => this.view(config)),
      ...(this.fileError ? { fileError: this.fileError } : {}),
    };
  }

  currentTools(): Tool[] {
    const tools: Tool[] = [];
    for (const config of this.configs) {
      const slot = this.slots.get(config.name);
      if (!config.enabled || slot?.state !== "connected") continue;
      for (const [exposed, remote] of slot.exposed) {
        const remoteTool = slot.opened?.tools.find((tool) => tool.name === remote);
        tools.push(this.asTool(config.name, exposed, remote, remoteTool?.description, remoteTool?.inputSchema));
      }
    }
    return tools;
  }

  autoAllows(toolName: string): boolean {
    for (const config of this.configs) {
      if (!config.enabled || !config.autoAllow) continue;
      const slot = this.slots.get(config.name);
      if (slot?.state === "connected" && slot.exposed.has(toolName)) return true;
    }
    return false;
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      const loaded = await loadMcpServers(this.path);
      this.configs = loaded.servers;
      this.fileError = loaded.error;
      for (const config of this.configs) {
        if (!config.enabled) this.slots.set(config.name, emptySlot("disabled"));
      }
      this.emit();
    });
    for (const config of this.configs) {
      if (config.enabled) this.kick(config);
    }
  }

  async add(input: McpServerInput): Promise<McpServerView> {
    const config = await this.enqueue(async () => {
      this.assertWritable();
      const next = normalizeMcpServer(input);
      if (this.configs.some((server) => server.name === next.name)) throw new Error(`已有 MCP server ${next.name}`);
      const configs = [...this.configs, next];
      await saveMcpServers(this.path, configs);
      this.configs = configs;
      this.fileError = undefined;
      if (!next.enabled) this.slots.set(next.name, emptySlot("disabled"));
      this.emit();
      return next;
    });
    if (config.enabled) this.kick(config);
    return this.view(config);
  }

  async update(name: string, input: McpServerInput): Promise<McpServerView> {
    const { previous, next } = await this.enqueue(async () => {
      this.assertWritable();
      const current = this.require(name);
      const updated = normalizeMcpServer({ ...input, name }, current);
      await this.replaceConfig(updated);
      return { previous: current, next: updated };
    });
    if (transportChanged(previous, next)) {
      if (next.enabled) this.kick(next);
      else this.stop(name, "disabled");
    } else if (!next.enabled) this.stop(name, "disabled");
    return this.view(next);
  }

  async remove(name: string): Promise<void> {
    this.bump(name);
    const opened = await this.enqueue(async () => {
      this.assertWritable();
      this.require(name);
      const configs = this.configs.filter((server) => server.name !== name);
      await saveMcpServers(this.path, configs);
      this.configs = configs;
      const slot = this.slots.get(name);
      this.slots.delete(name);
      this.emit();
      return slot?.opened;
    });
    await opened?.close();
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpServerView> {
    const config = await this.enqueue(async () => {
      this.assertWritable();
      const previous = this.require(name);
      const next = { ...previous, enabled };
      await this.replaceConfig(next);
      return next;
    });
    if (config.enabled) this.kick(config);
    else this.stop(name, "disabled");
    return this.view(config);
  }

  async setAutoAllow(name: string, autoAllow: boolean): Promise<McpServerView> {
    const config = await this.enqueue(async () => {
      this.assertWritable();
      const previous = this.require(name);
      const next = { ...previous, autoAllow };
      await this.replaceConfig(next);
      return next;
    });
    this.emit();
    return this.view(config);
  }

  async reconnect(name: string): Promise<McpServerView> {
    const config = this.require(name);
    if (!config.enabled) throw new Error(`${name} 已停用`);
    this.kick(config);
    return this.view(config);
  }

  async close(): Promise<void> {
    const genBump = this.configs.map((config) => config.name);
    for (const name of genBump) this.bump(name);
    const opened = await this.enqueue(async () => {
      const all = [...this.slots.values()].map((slot) => slot.opened);
      this.slots.clear();
      return all;
    });
    await Promise.all(opened.map((session) => session?.close()));
  }

  private kick(config: McpServerConfig): void {
    const gen = this.bump(config.name);
    void this.enqueue(async () => {
      if (this.generation.get(config.name) !== gen) return false;
      const previous = this.slots.get(config.name)?.opened;
      this.slots.set(config.name, emptySlot("connecting"));
      this.emit();
      await previous?.close();
      return this.generation.get(config.name) === gen;
    }).then((keep) => {
      if (keep) return this.finishKick(config, gen);
    });
  }

  private async finishKick(config: McpServerConfig, gen: number): Promise<void> {
    if (this.generation.get(config.name) !== gen) return;
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    try {
      const opened = await this.open(config, signal);
      await this.enqueue(async () => {
        if (this.generation.get(config.name) !== gen) {
          await opened.close();
          return;
        }
        const exposed = new Map<string, string>();
        let dropped = 0;
        for (const tool of opened.tools) {
          const name = exposeToolName(config.name, tool.name);
          if (!name || exposed.has(name)) {
            dropped += 1;
            continue;
          }
          exposed.set(name, tool.name);
        }
        const notes: string[] = [];
        if (opened.truncated) notes.push(`只注册了前 ${opened.tools.length} 个工具`);
        if (dropped) notes.push(`${dropped} 个工具名无法注册`);
        this.slots.set(config.name, {
          state: "connected",
          exposed,
          opened,
          ...(notes.length ? { note: notes.join("；") } : {}),
        });
        this.emit();
      });
    } catch (err) {
      await this.enqueue(async () => {
        if (this.generation.get(config.name) !== gen) return;
        this.slots.set(config.name, {
          state: "error",
          exposed: new Map(),
          error: redactSecrets(err instanceof Error ? err.message : String(err), secretsOf(config)),
        });
        this.emit();
      });
    }
  }

  private stop(name: string, state: "disabled"): void {
    this.bump(name);
    void this.enqueue(async () => {
      const opened = this.slots.get(name)?.opened;
      this.slots.set(name, emptySlot(state));
      this.emit();
      await opened?.close();
    });
  }

  private bump(name: string): number {
    const gen = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, gen);
    return gen;
  }

  private async replaceConfig(next: McpServerConfig): Promise<void> {
    const configs = this.configs.map((server) => (server.name === next.name ? next : server));
    await saveMcpServers(this.path, configs);
    this.configs = configs;
    this.emit();
  }

  private require(name: string): McpServerConfig {
    const config = this.configs.find((server) => server.name === name);
    if (!config) throw new Error(`未找到 MCP server ${name}`);
    return config;
  }

  private assertWritable(): void {
    if (this.fileError) throw new Error(`先修好 MCP 配置：${this.fileError}`);
  }

  private view(config: McpServerConfig): McpServerView {
    const slot = this.slots.get(config.name);
    const state = slot?.state ?? (config.enabled ? "connecting" : "disabled");
    const view: McpServerView = {
      name: config.name,
      enabled: config.enabled,
      autoAllow: config.autoAllow,
      transport: config.transport,
      summary: summaryOf(config),
      state,
      tools: slot ? [...slot.exposed.values()] : [],
    };
    if (slot?.error) view.error = slot.error;
    if (slot?.note) view.note = slot.note;
    if (config.transport === "stdio") {
      view.command = config.command;
      view.args = config.args;
      view.envKeys = Object.keys(config.env);
      if (config.cwd) view.cwd = config.cwd;
    }
    return view;
  }

  private asTool(
    server: string,
    exposed: string,
    remote: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
  ): Tool {
    const text = (description ?? remote).replace(/\s+/g, " ").trim().slice(0, DESC_MAX);
    const parameters =
      inputSchema && inputSchema.type === "object"
        ? inputSchema
        : { type: "object", properties: {}, additionalProperties: true };
    return {
      definition: {
        name: exposed,
        description: `[MCP ${server}] ${text}`,
        parameters,
      },
      execute: (args, ctx) => this.execute(server, remote, args, ctx),
    };
  }

  private async execute(
    server: string,
    remote: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const slot = this.slots.get(server);
    const config = this.configs.find((item) => item.name === server);
    if (!config?.enabled || slot?.state !== "connected" || !slot.opened) {
      return { content: `MCP server ${server} 未连接`, is_error: true };
    }
    const result = await slot.opened.call(remote, args, ctx.signal, ctx.bashTimeoutMs);
    return {
      content: truncateOutput(redactSecrets(result.text, secretsOf(config)), ctx.maxToolOutputChars),
      is_error: result.isError,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function emptySlot(state: "disabled" | "connecting"): Slot {
  return { state, exposed: new Map() };
}

function summaryOf(config: McpServerConfig): string {
  if (config.transport === "http") return redactUrl(config.url);
  const args = config.args.join(" ");
  const env = Object.keys(config.env)
    .map((key) => `${key}=***`)
    .join(" ");
  return redactSecrets([config.command, args, env].filter(Boolean).join(" "), Object.values(config.env));
}

function transportChanged(before: McpServerConfig, after: McpServerConfig): boolean {
  return JSON.stringify(publicTransport(before)) !== JSON.stringify(publicTransport(after));
}

function publicTransport(config: McpServerConfig): unknown {
  if (config.transport === "http") return { transport: "http", url: config.url, enabled: config.enabled };
  return {
    transport: "stdio",
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd ?? "",
    enabled: config.enabled,
  };
}
