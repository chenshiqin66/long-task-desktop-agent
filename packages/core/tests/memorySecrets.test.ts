import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialsOf, type McpHttpServer, type McpStdioServer } from "../src/mcp/store.js";
import { MemoryStore } from "../src/memory/store.js";
import { rmWorkspace } from "./rmWorkspace.js";

const STDIO: McpStdioServer = {
  name: "github",
  label: "GitHub",
  enabled: true,
  autoAllow: false,
  transport: "stdio",
  command: "npx",
  args: [
    "-y",
    "@example/github-mcp",
    "--token",
    "ghs_stdioflagvalue1",
    "--api-key=flagkeyvalue2",
    "--verbose",
    "https://user:urlpass3@mirror.example.com/feed?apikey=queryvalue4&page=2",
  ],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "envtokenvalue5", ApiKey: "camelkeyvalue6", NODE_ENV: "production", LOG_LEVEL: "debug" },
};

const HTTP: McpHttpServer = {
  name: "docs",
  label: "Docs",
  enabled: true,
  autoAllow: false,
  transport: "http",
  url: "https://mcp.example.com/sse?token=httptoken7&region=eu",
};

describe("MCP credentials for memory", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-memsecret-"));
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  it("takes values that look like credentials and leaves ordinary settings alone", () => {
    expect(credentialsOf(STDIO).sort()).toEqual(
      ["camelkeyvalue6", "envtokenvalue5", "flagkeyvalue2", "ghs_stdioflagvalue1", "queryvalue4", "urlpass3"].sort(),
    );
  });

  it("takes only the secret parts of an http server address", () => {
    expect(credentialsOf(HTTP)).toEqual(["httptoken7"]);
  });

  it("lets a note mention the server address and NODE_ENV, and rejects one that holds a token", async () => {
    const store = new MemoryStore({ workspacePath: null, home: join(base, "home") });
    const secrets = [...credentialsOf(STDIO), ...credentialsOf(HTTP)];
    const ok = await store.upsert(
      {
        scope: "user",
        name: "github-mcp",
        type: "reference",
        description: "GitHub MCP 用 production 配置",
        body: "github 这个 MCP server 跑在 NODE_ENV=production，镜像在 https://mirror.example.com/feed，文档服务在 https://mcp.example.com/sse。",
      },
      { actor: "user", origin: "manual", secrets },
    );
    expect(ok.ok).toBe(true);
    const bad = await store.upsert(
      { scope: "user", name: "github-token", type: "reference", description: "token", body: "token 是 envtokenvalue5" },
      { actor: "user", origin: "manual", secrets },
    );
    expect(bad).toEqual({ ok: false, error: "含有配置里的密钥，不能写进记忆" });
  });
});
