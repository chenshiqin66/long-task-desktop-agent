import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBuiltinTools,
  ToolHost,
  isDangerousBash,
  SHELL_TOOL_NAME,
  truncateOutput,
} from "../src/tools/host.js";
import type { ToolContext } from "../src/tools/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("tools", () => {
  let workspace: string;
  let ctx: ToolContext;
  let host: ToolHost;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    await writeFile(join(workspace, "hello.txt"), "hello world\nline2\n", "utf8");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "a.ts"), " const foo = 1;\n", "utf8");
    ctx = {
      workspacePath: workspace,
      bashTimeoutMs: 5_000,
      maxToolOutputChars: 100,
      maxReadChars: 50,
      maxSearchResults: 10,
    };
    host = new ToolHost(createBuiltinTools());
  });

  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("refuses to run ask_user and agent as local commands", async () => {
    await expect(
      host.execute("ask_user", JSON.stringify({ question: "继续？" }), ctx),
    ).rejects.toThrow(/not a local command/);
    await expect(
      host.execute("agent", JSON.stringify({ description: "x", subagent_type: "explore", task: "y" }), ctx),
    ).rejects.toThrow(/not a local command/);
    expect(host.listDefinitions().some((d) => d.name === "ask_user")).toBe(true);
    expect(host.listDefinitions().some((d) => d.name === "agent")).toBe(true);
  });

  it("lists builtin tool definitions", () => {
    const names = host.listDefinitions().map((d) => d.name).sort();
    expect(names).toEqual([
      SHELL_TOOL_NAME,
      "agent",
      "ask_user",
      "delete_file",
      "keyword_search",
      "list_dir",
      "read_file",
      "read_skill",
      "run_skill_script",
      "str_replace",
      "web_search",
      "write_file",
    ].sort());
  });

  it("write_file creates nested file and read_file round-trips", async () => {
    const r = await host.execute(
      "write_file",
      JSON.stringify({ path: "nested/out.txt", content: "hello-write" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    const read = await host.execute(
      "read_file",
      JSON.stringify({ path: "nested/out.txt" }),
      { ...ctx, maxReadChars: 1000 },
    );
    expect(read.is_error).toBe(false);
    expect(read.content).toContain("hello-write");
  });

  it("write_file rejects path outside workspace", async () => {
    const r = await host.execute(
      "write_file",
      JSON.stringify({ path: "../escape.txt", content: "x" }),
      ctx,
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/outside/i);
  });

  it("write_file stays inside a subagent output_dir and out of a claimed one", async () => {
    const outside = await host.execute(
      "write_file",
      JSON.stringify({ path: "src/a.ts", content: "nope" }),
      { ...ctx, writeRoot: "docs/notes" },
    );
    expect(outside.is_error).toBe(true);
    expect(outside.content).toMatch(/output_dir/);
    const claimed = await host.execute(
      "write_file",
      JSON.stringify({ path: "docs/notes/a.md", content: "x" }),
      { ...ctx, blockedOutputDirs: ["docs/notes"] },
    );
    expect(claimed.is_error).toBe(true);
    expect(claimed.content).toMatch(/docs\/notes/);
  });

  it("str_replace updates unique substring", async () => {
    const r = await host.execute(
      "str_replace",
      JSON.stringify({
        path: "hello.txt",
        old_string: "hello world",
        new_string: "hello agent",
      }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    const read = await host.execute(
      "read_file",
      JSON.stringify({ path: "hello.txt" }),
      { ...ctx, maxReadChars: 1000 },
    );
    expect(read.content).toContain("hello agent");
  });

  it("str_replace errors when old_string is missing or ambiguous", async () => {
    const missing = await host.execute(
      "str_replace",
      JSON.stringify({ path: "hello.txt", old_string: "nope", new_string: "x" }),
      ctx,
    );
    expect(missing.is_error).toBe(true);
    await writeFile(join(workspace, "dup.txt"), "aa aa\n", "utf8");
    const amb = await host.execute(
      "str_replace",
      JSON.stringify({ path: "dup.txt", old_string: "aa", new_string: "b" }),
      ctx,
    );
    expect(amb.is_error).toBe(true);
    expect(amb.content).toMatch(/2 times|replace_all/i);
  });

  it("list_dir lists workspace entries", async () => {
    const r = await host.execute("list_dir", JSON.stringify({ path: "." }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/hello\.txt/);
    expect(r.content).toMatch(/src/);
  });

  it("delete_file removes a file", async () => {
    await writeFile(join(workspace, "gone.txt"), "x\n", "utf8");
    const r = await host.execute(
      "delete_file",
      JSON.stringify({ path: "gone.txt" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    const read = await host.execute(
      "read_file",
      JSON.stringify({ path: "gone.txt" }),
      ctx,
    );
    expect(read.is_error).toBe(true);
  });

  it("bash rejects oversized commands that should use write_file", async () => {
    const command = `cat > big.html <<'EOF'\n${"x".repeat(9000)}\nEOF`;
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), ctx);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/write_file|too long/i);
  });

  it("read_file returns content and truncates", async () => {
    const r = await host.execute(
      "read_file",
      JSON.stringify({ path: "hello.txt" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    expect(r.content.includes("truncated") || r.content.length <= 50).toBe(true);
  });

  it("read_file rejects path outside workspace", async () => {
    const r = await host.execute(
      "read_file",
      JSON.stringify({ path: "../outside.txt" }),
      ctx,
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/outside/i);
  });

  it("read_file rejects symlink escape via realpath", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "agent-out-"));
    const secret = join(outsideDir, "secret.txt");
    await writeFile(secret, "top-secret\n", "utf8");
    try {
      await symlink(secret, join(workspace, "leak.txt"));
    } catch (err) {
      // Windows needs Developer Mode / admin for file symlinks.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await rmWorkspace(outsideDir);
        return;
      }
      throw err;
    }
    try {
      const r = await host.execute(
        "read_file",
        JSON.stringify({ path: "leak.txt" }),
        ctx,
      );
      expect(r.is_error).toBe(true);
      expect(r.content).toMatch(/outside/i);
    } finally {
      await rmWorkspace(outsideDir);
    }
  });

  it("shell runs in workspace cwd", async () => {
    const command =
      process.platform === "win32"
        ? "if (Test-Path -LiteralPath 'hello.txt') { Write-Output 'IN_WS'; Write-Output (Get-Location).Path }"
        : "test -f hello.txt && echo IN_WS";
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toContain("IN_WS");
    if (process.platform === "win32") {
      expect(r.content.toLowerCase()).toContain(workspace.toLowerCase());
      expect(r.content).not.toMatch(/\/mnt\//);
    }
  });

  it(
    "bash timeout returns error tool result",
    async () => {
      const r = await host.execute(
        SHELL_TOOL_NAME,
        JSON.stringify({
          command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 5",
        }),
        { ...ctx, bashTimeoutMs: 200 },
      );
      expect(r.is_error).toBe(true);
      expect(r.content).toMatch(/timeout/i);
    },
    15_000,
  );

  it("bash rejects destructive root delete patterns", async () => {
    const blocked = ["rm", "-rf", "/"].join(" ");
    expect(isDangerousBash(blocked)).toBe(true);
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command: blocked }), ctx);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/blocked|dangerous/i);
  });

  it("keyword_search finds matches with limits", async () => {
    const r = await host.execute(
      "keyword_search",
      JSON.stringify({ query: "foo" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/a\.ts/);
    expect(r.content).toMatch(/Pass path next time/);
  });

  it("keyword_search stays inside path and matches every term in one call", async () => {
    const scoped = await host.execute(
      "keyword_search",
      JSON.stringify({ path: "src", queries: ["foo", "line2"] }),
      ctx,
    );
    expect(scoped.is_error).toBe(false);
    expect(scoped.content).toMatch(/a\.ts/);
    expect(scoped.content).toMatch(/foo/);
    expect(scoped.content).not.toMatch(/hello\.txt/);
    expect(scoped.content).not.toMatch(/Pass path next time/);

    const fileOnly = await host.execute(
      "keyword_search",
      JSON.stringify({ path: "hello.txt", query: "foo" }),
      ctx,
    );
    expect(fileOnly.is_error).toBe(false);
    expect(fileOnly.content).toMatch(/No matches/i);
  });

  it("keyword_search returns immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await host.execute(
      "keyword_search",
      JSON.stringify({ path: ".", query: "foo" }),
      { ...ctx, signal: ac.signal },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/cancel/i);
  });

  it("unknown tool returns error result not throw", async () => {
    const r = await host.execute("nope", "{}", ctx);
    expect(r.is_error).toBe(true);
  });

  it("truncateOutput caps length", () => {
    expect(truncateOutput("abcdefghij", 5)).toContain("truncated");
  });

  it(
    "bash kills and returns truncated output once stream exceeds maxToolOutputChars",
    async () => {
      const started = Date.now();
      const r = await host.execute(
        SHELL_TOOL_NAME,
        JSON.stringify({
          command:
            process.platform === "win32" ? "while ($true) { Write-Output x }" : "yes x",
        }),
        { ...ctx, maxToolOutputChars: 500, bashTimeoutMs: 8_000 },
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(5_000);
      expect(r.content.length).toBeLessThanOrEqual(500 + "\n...[truncated]".length + 5);
      expect(r.content).toMatch(/x/);
    },
    15_000,
  );

  it("bash respects pre-aborted AbortSignal without spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await host.execute(
      SHELL_TOOL_NAME,
      JSON.stringify({
        command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 5",
      }),
      { ...ctx, signal: ac.signal, bashTimeoutMs: 5_000 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/cancel/i);
  });

  it("keyword_search skips file symlink that escapes workspace", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "agent-search-out-"));
    const secret = join(outsideDir, "secret.txt");
    await writeFile(secret, "secret-keyword-outside\n", "utf8");
    try {
      await symlink(secret, join(workspace, "leak-search.txt"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await rmWorkspace(outsideDir);
        return;
      }
      throw err;
    }
    try {
      const r = await host.execute(
        "keyword_search",
        JSON.stringify({ query: "secret-keyword-outside" }),
        ctx,
      );
      expect(r.is_error).toBe(false);
      expect(r.content).not.toMatch(/secret-keyword-outside/);
      expect(r.content).toMatch(/No matches/i);
    } finally {
      await rmWorkspace(outsideDir);
    }
  });

  it("isDangerousBash blocks root wipe variants without blocking /tmp", () => {
    expect(isDangerousBash("rm -rf /")).toBe(true);
    expect(isDangerousBash("rm -rf /*")).toBe(true);
    expect(isDangerousBash("rm -fr /")).toBe(true);
    expect(isDangerousBash("rm -rf / && echo x")).toBe(true);
    expect(isDangerousBash("RM -RF /")).toBe(true);
    expect(isDangerousBash("rm -rf /tmp")).toBe(false);
    expect(isDangerousBash("rm -rf ./build")).toBe(false);
    expect(isDangerousBash("Remove-Item -Recurse -Force C:\\")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse -Force 'C:\\'")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse -Force C:\\*")).toBe(true);
    expect(isDangerousBash("Format-Volume -DriveLetter C")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse -Force .\\build")).toBe(false);
    expect(isDangerousBash("Remove-Item -Recurse -Force C:\\Users\\x")).toBe(false);
    expect(isDangerousBash("Get-ChildItem C:\\")).toBe(false);
  });

  it("reports a native command failure instead of the pipeline tail", async () => {
    const command = process.platform === "win32" ? "cmd /c exit 3" : "bash -c 'exit 3'";
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), ctx);
    expect(r.is_error).toBe(true);
  });

  it("rejects a bash tool call on Windows", async () => {
    if (process.platform !== "win32") return;
    const r = await host.execute("bash", JSON.stringify({ command: "echo hi" }), ctx);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/powershell/i);
  });
});
