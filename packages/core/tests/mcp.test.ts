import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { PermissionGate, PermissionDecision } from "../src/runtime/permission.js";
import { McpPool, type McpSnapshot } from "../src/mcp/pool.js";
import { redactUrl } from "../src/mcp/redact.js";
import { serverNameFromCommand, serverNameFromUrl } from "../src/mcp/names.js";
import type { OpenedMcp } from "../src/mcp/connect.js";
import type { McpServerConfig } from "../src/mcp/store.js";
import { classifyToolCall } from "../src/tools/policy.js";
import { ToolHost, createBuiltinTools } from "../src/tools/host.js";
import { toolsForSubagent } from "../src/tools/agentTool.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import type { Tool } from "../src/tools/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const dirs: string[] = [];
const pools: McpPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(dirs.splice(0).map((dir) => rmWorkspace(dir)));
  delete process.env.MCP_PARENT_SECRET;
});

describe("MCP names, redaction, and permission", () => {
  it("masks a key in a streamable HTTP URL", () => {
    const raw = "https://mcp.amap.com/mcp?key=supersecret";
    expect(redactUrl(raw)).toContain("key=***");
    expect(redactUrl(raw)).not.toContain("supersecret");
  });

  it("derives a connection id from the host or the command", () => {
    expect(serverNameFromUrl("https://mcp.amap.com/mcp?key=supersecret")).toBe("amap");
    expect(serverNameFromUrl("https://example.com/mcp")).toBe("example");
    expect(serverNameFromUrl("http://127.0.0.1:9/mcp")).toBe("127-0-0-1");
    expect(serverNameFromCommand("npx", ["-y", "@amap/amap-maps-mcp-server"])).toBe("amap-maps-mcp-server");
    expect(serverNameFromCommand("node", ["D:/svc/notes-mcp/dist/index.js"])).toBe("notes-mcp");
  });

  it("asks once for an MCP tool and skips the card when that server auto-allows", () => {
    const once = classifyToolCall("mcp__amap__maps_geo", "{}");
    expect(once).toMatchObject({ risk: "write", grant: "once" });
    expect(once.summary).toContain("amap / maps_geo");
    const auto = classifyToolCall("mcp__amap__maps_geo", "{}", {
      mcpAutoAllow: () => true,
    });
    expect(auto.risk).toBe("read");
    expect(auto.grant).toBeUndefined();
  });

  it("keeps MCP tools out of the subagent subset", () => {
    const extra: Tool = {
      definition: { name: "mcp__amap__maps_geo", description: "geo", parameters: { type: "object", properties: {} } },
      execute: async () => ({ content: "ok", is_error: false }),
    };
    const host = new ToolHost(createBuiltinTools()).merge([extra]);
    expect(host.listDefinitions().some((tool) => tool.name === "mcp__amap__maps_geo")).toBe(true);
    const sub = host.subset(toolsForSubagent("worker"));
    expect(sub.listDefinitions().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
  });
});

describe("MCP pool", () => {
  it("stores the key, shows a masked summary, and calls the opened tool", async () => {
    const pool = await makePool(fakeOpen);
    const view = await pool.add({
      name: "amap",
      transport: "http",
      url: "https://mcp.amap.com/mcp?key=supersecret",
      autoAllow: true,
    });
    expect(view.summary).not.toContain("supersecret");
    expect(view.summary).toContain("key=");
    const connected = await waitFor(pool, (snap) => snap.servers[0]?.state === "connected");
    expect(connected.servers[0]?.tools).toEqual([{ name: "ping", description: "pong" }]);
    expect(pool.autoAllows("mcp__amap__ping")).toBe(true);
    const [tool] = pool.currentTools();
    const result = await tool!.execute({}, toolCtx());
    expect(result).toEqual({ content: "amap:ping", is_error: false });
    const saved = await readFile(poolPath(pool), "utf8");
    expect(saved).toContain("supersecret");
  });

  it("leaves a corrupt file untouched", async () => {
    const dir = await scratch();
    const path = join(dir, "mcp-servers.json");
    await writeFile(path, "{", "utf8");
    const pool = new McpPool({ path, open: fakeOpen });
    pools.push(pool);
    await pool.start();
    expect(pool.snapshot().fileError).toMatch(/JSON/);
    expect(await readFile(path, "utf8")).toBe("{");
    await expect(pool.add({ name: "amap", transport: "http", url: "https://mcp.amap.com/mcp" })).rejects.toThrow(/先修好/);
  });

  it("does not pass the parent environment into a stdio server", async () => {
    process.env.MCP_PARENT_SECRET = "should-not-leak";
    const pool = await makePool();
    await pool.add({
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp-stdio.mjs", import.meta.url))],
      env: { AMAP_MAPS_API_KEY: "amap-key" },
    });
    await waitFor(pool, (snap) => snap.servers[0]?.state === "connected");
    const [tool] = pool.currentTools();
    const result = await tool!.execute({ text: "hi" }, toolCtx());
    expect(result.is_error).toBe(false);
    expect(result.content).toBe("hi|absent|***");
    expect(pool.snapshot().servers[0]?.summary).not.toContain("amap-key");
  });

  it("calls a streamable HTTP server and masks the key in errors", async () => {
    const started = await startHttp();
    const pool = await makePool();
    await pool.add({
      name: "remote",
      transport: "http",
      url: `${started.url}?key=supersecret`,
    });
    await waitFor(pool, (snap) => snap.servers[0]?.state === "connected");
    expect(pool.snapshot().servers[0]?.summary).not.toContain("supersecret");
    const [tool] = pool.currentTools();
    const result = await tool!.execute({ text: "hi" }, toolCtx());
    expect(result.content).toContain("hi");
    await started.close();
  });
});

describe("MCP permission does not arm the rest of the turn", () => {
  it("still asks for an MCP call after a write was allowed", async () => {
    const dir = await scratch();
    const gate = new CountingGate();
    let step = 0;
    const provider: LlmProvider = {
      chatStream() {
        step += 1;
        if (step === 1) return toolCall("write_file", {});
        if (step === 2) return toolCall("mcp__demo__ping", {});
        return text("done");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: dir,
      config: { ...DEFAULT_AGENT_CONFIG, baseUrl: "http://localhost", model: "test", apiKey: "k" },
      provider,
      permissions: gate,
      tools: new ToolHost([fakeTool("write_file"), fakeTool("mcp__demo__ping")]),
    });
    const events: string[] = [];
    rt.onEvent((event) => {
      if (event.type === "permission_request") events.push(event.grant ?? "turn");
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "go");
    expect(gate.count).toBe(2);
    expect(events).toEqual(["turn", "once"]);
  });

  it("does not ask when the server auto-allows", async () => {
    const dir = await scratch();
    const gate = new CountingGate();
    let step = 0;
    const provider: LlmProvider = {
      chatStream() {
        step += 1;
        if (step === 1) return toolCall("mcp__demo__ping", {});
        return text("done");
      },
    };
    const rt = new AgentRuntime({
      workspacePath: dir,
      config: { ...DEFAULT_AGENT_CONFIG, baseUrl: "http://localhost", model: "test", apiKey: "k" },
      provider,
      permissions: gate,
      tools: new ToolHost([fakeTool("mcp__demo__ping")]),
      mcp: { currentTools: () => [], autoAllows: () => true },
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "go");
    expect(gate.count).toBe(0);
  });
});

class CountingGate implements PermissionGate {
  count = 0;
  async request(): Promise<PermissionDecision> {
    this.count += 1;
    return "allow";
  }
}

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    execute: async () => ({ content: "ok", is_error: false }),
  };
}

async function* toolCall(name: string, args: Record<string, unknown>): AsyncIterable<LlmStreamChunk> {
  yield {
    type: "tool_call_delta",
    tool_call: { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  };
}

async function* text(value: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text: value };
  yield { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

function toolCtx() {
  return {
    workspacePath: dirOfPools(),
    bashTimeoutMs: 5_000,
    maxToolOutputChars: 4_000,
    maxReadChars: 4_000,
    maxSearchResults: 8,
  };
}

function dirOfPools(): string {
  return dirs[dirs.length - 1] ?? tmpdir();
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-"));
  dirs.push(dir);
  return dir;
}

async function makePool(open?: (config: McpServerConfig) => Promise<OpenedMcp>): Promise<McpPool> {
  const dir = await scratch();
  const pool = new McpPool({ path: join(dir, "mcp-servers.json"), ...(open ? { open } : {}) });
  pools.push(pool);
  return pool;
}

function poolPath(pool: McpPool): string {
  const dir = dirs[dirs.length - 1]!;
  void pool;
  return join(dir, "mcp-servers.json");
}

function fakeOpen(config: McpServerConfig): Promise<OpenedMcp> {
  return Promise.resolve({
    truncated: false,
    tools: [{ name: "ping", description: "pong", inputSchema: { type: "object", properties: {} } }],
    call: async (name) => ({ text: `${config.name}:${name}`, isError: false }),
    close: async () => undefined,
  });
}

function waitFor(pool: McpPool, ready: (snapshot: McpSnapshot) => boolean): Promise<McpSnapshot> {
  const current = pool.snapshot();
  if (ready(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`MCP 状态停留在 ${JSON.stringify(pool.snapshot())}`));
    }, 8_000);
    const stop = pool.onStatus((snapshot) => {
      if (!ready(snapshot)) return;
      clearTimeout(timer);
      stop();
      resolve(snapshot);
    });
  });
}

async function startHttp(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcp = new Server({ name: "http-fixture", version: "0.0.1" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "pong",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const text = typeof args.text === "string" ? args.text : "";
    return { content: [{ type: "text", text: `http:${text}` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const http = createServer((req, res) => {
    void transport.handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      } else res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
