import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSkillEnabled } from "../src/skills/installedSkills.js";
import {
  createBuiltinTools,
  ToolHost,
  isDangerousBash,
  SHELL_TOOL_NAME,
  truncateOutput,
} from "../src/tools/host.js";
import type { ToolContext } from "../src/tools/types.js";
import { toolsForSubagent } from "../src/tools/agentTool.js";
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

  it("refuses to run ask_user and subagent as local commands", async () => {
    await expect(
      host.execute("ask_user", JSON.stringify({ question: "继续？" }), ctx),
    ).rejects.toThrow(/not a local command/);
    await expect(
      host.execute("subagent", JSON.stringify({ description: "x", subagent_type: "explore", task: "y" }), ctx),
    ).rejects.toThrow(/not a local command/);
    expect(host.listDefinitions().some((d) => d.name === "ask_user")).toBe(true);
    expect(host.listDefinitions().some((d) => d.name === "subagent")).toBe(true);
  });

  it("returns an error when a subagent host is asked to ask or delegate", async () => {
    const sub = host.subset(toolsForSubagent("worker"));
    const ask = await sub.execute("ask_user", JSON.stringify({ question: "继续？" }), ctx);
    const delegated = await sub.execute(
      "subagent",
      JSON.stringify({ description: "x", subagent_type: "explore", task: "y" }),
      ctx,
    );
    expect(ask.is_error).toBe(true);
    expect(delegated.is_error).toBe(true);
    expect(ask.content).toMatch(/final reply/i);
    expect(delegated.content).toMatch(/final reply/i);
  });

  it("lists builtin tool definitions", () => {
    const names = host.listDefinitions().map((d) => d.name).sort();
    expect(names).toEqual([
      SHELL_TOOL_NAME,
      "subagent",
      "ask_user",
      "claim_task",
      "complete_task",
      "task_create",
      "task_delete",
      "task_get",
      "task_list",
      "task_update",
      "delete_file",
      "keyword_search",
      "list_dir",
      "memory_read",
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

  it("write_file without content is an error and writes nothing", async () => {
    const missing = await host.execute("write_file", JSON.stringify({ path: "keep.txt" }), ctx);
    expect(missing.is_error).toBe(true);
    expect(missing.content).toMatch(/Missing content/);
    const nullish = await host.execute("write_file", JSON.stringify({ path: "keep.txt", content: null }), ctx);
    expect(nullish.is_error).toBe(true);
    await expect(readFile(join(workspace, "keep.txt"), "utf8")).rejects.toThrow();
  });

  it("write_file with an empty string still creates an empty file", async () => {
    const r = await host.execute("write_file", JSON.stringify({ path: "empty.txt", content: "" }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toBe("Wrote 0 chars to empty.txt");
    expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("");
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

  it("keeps file tools out of .agent under any spelling of the path", async () => {
    const state = join(workspace, ".agent", "sessions", "s1");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "messages.jsonl"), "original\n", "utf8");
    await symlink(join(workspace, ".agent"), join(workspace, "state-link"), "junction");
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["write_file", { path: ".AGENT/sessions/s1/messages.jsonl", content: "forged" }],
      ["write_file", { path: "state-link/sessions/s1/messages.jsonl", content: "forged" }],
      ["str_replace", { path: ".Agent/sessions/s1/messages.jsonl", old_string: "original", new_string: "forged" }],
      ["delete_file", { path: ".AGENT/sessions/s1/messages.jsonl" }],
    ];
    for (const [tool, args] of attempts) {
      const result = await host.execute(tool, JSON.stringify(args), ctx);
      expect(result.is_error, `${tool} ${String(args.path)}`).toBe(true);
      expect(result.content, `${tool} ${String(args.path)}`).toMatch(/\.agent/);
    }
    expect(await readFile(join(state, "messages.jsonl"), "utf8")).toBe("original\n");
  });

  it("keeps a claimed output_dir locked under another letter case", async () => {
    const claimed = await host.execute(
      "write_file",
      JSON.stringify({ path: "DOCS/Notes/a.md", content: "x" }),
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

  it("str_replace writes $ sequences literally", async () => {
    await writeFile(join(workspace, "price.txt"), "cost\n", "utf8");
    const r = await host.execute(
      "str_replace",
      JSON.stringify({
        path: "price.txt",
        old_string: "cost",
        new_string: "cost $& $$ $' $`",
      }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    const read = await host.execute("read_file", JSON.stringify({ path: "price.txt" }), {
      ...ctx,
      maxReadChars: 1000,
    });
    expect(read.content).toContain("cost $& $$ $' $`");
  });

  it("str_replace explains a read_file line-number prefix copied into old_string", async () => {
    await writeFile(join(workspace, "numbered.txt"), "const a = 1;\nconst b = 2;\n", "utf8");
    const r = await host.execute(
      "str_replace",
      JSON.stringify({ path: "numbered.txt", old_string: "2\tconst b = 2;", new_string: "x" }),
      ctx,
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/^old_string not found in numbered\.txt\. .*line number/);
    const after = await host.execute("read_file", JSON.stringify({ path: "numbered.txt" }), ctx);
    expect(after.content).toContain("const b = 2;");
  });

  it("str_replace finds old_string that really contains a tab and digits", async () => {
    await writeFile(join(workspace, "tabbed.txt"), "12\tkeep\n", "utf8");
    const r = await host.execute(
      "str_replace",
      JSON.stringify({ path: "tabbed.txt", old_string: "12\tkeep", new_string: "12\tdone" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
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

  it("read_file with offset and limit returns numbered lines and the range, with no next-page hint", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile(join(workspace, "ten.txt"), lines.join("\n") + "\n", "utf8");
    const part = await host.execute(
      "read_file",
      JSON.stringify({ path: "ten.txt", offset: 3, limit: 2 }),
      { ...ctx, maxReadChars: 1000 },
    );
    expect(part.is_error).toBe(false);
    expect(part.content).toBe("3\tline3\n4\tline4\n[lines 3-4 of 10]");
    expect(part.content).not.toMatch(/offset=/);
    const tail = await host.execute("read_file", JSON.stringify({ path: "ten.txt", offset: 9 }), {
      ...ctx,
      maxReadChars: 1000,
    });
    expect(tail.content).toBe("9\tline9\n10\tline10\n[lines 9-10 of 10]");
  });

  it("read_file range rejects an offset past the end and a non-positive offset", async () => {
    await writeFile(join(workspace, "two.txt"), "a\nb\n", "utf8");
    const past = await host.execute("read_file", JSON.stringify({ path: "two.txt", offset: 5 }), ctx);
    expect(past.is_error).toBe(true);
    expect(past.content).toMatch(/past the end; the file has 2 lines/);
    const zero = await host.execute("read_file", JSON.stringify({ path: "two.txt", offset: 0 }), ctx);
    expect(zero.is_error).toBe(true);
    expect(zero.content).toMatch(/offset must be/);
  });

  it("read_file range cut by the size limit says so and asks for fewer lines", async () => {
    await writeFile(join(workspace, "wide.txt"), Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n"), "utf8");
    const r = await host.execute("read_file", JSON.stringify({ path: "wide.txt", offset: 1, limit: 30 }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/\[lines 1-\d+ of 30\. This range was cut at the read limit of 50 characters; ask for fewer lines\.\]$/);
  });

  it("read_file marks a first line that is longer than the limit", async () => {
    await writeFile(join(workspace, "oneline.txt"), "z".repeat(200), "utf8");
    const r = await host.execute("read_file", JSON.stringify({ path: "oneline.txt", offset: 1 }), ctx);
    expect(r.content).toContain("this line is longer than 50 characters and was cut");
  });

  it("read_file without a range drops the rest of a long file and points to keyword_search", async () => {
    await writeFile(join(workspace, "long.txt"), Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n"), "utf8");
    const r = await host.execute("read_file", JSON.stringify({ path: "long.txt" }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/\.\.\.\[cut after line \d+ of 30: one read returns at most 50 characters/);
    expect(r.content).toMatch(/keyword_search .*then call read_file with offset and limit/);
    expect(r.content).toMatch(/Do not page through the file from here\./);
    // The rest is dropped, and nothing tells the model to continue from the next line.
    expect(r.content).not.toMatch(/offset=\d+/);
    expect(r.content).not.toContain("row 30");
  });

  it("write_file refuses to follow an existing symlink", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "agent-write-out-"));
    const secret = join(outsideDir, "secret.txt");
    await writeFile(secret, "top-secret\n", "utf8");
    try {
      await symlink(secret, join(workspace, "leak.txt"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await rmWorkspace(outsideDir);
        return;
      }
      throw err;
    }
    try {
      const r = await host.execute(
        "write_file",
        JSON.stringify({ path: "leak.txt", content: "pwned" }),
        ctx,
      );
      expect(r.is_error).toBe(true);
      expect(r.content).toMatch(/symlink/i);
      expect(await readFile(secret, "utf8")).toBe("top-secret\n");
    } finally {
      await rmWorkspace(outsideDir);
    }
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
      expect(r.is_error).toBe(false);
      expect(r.content).toMatch(/x/);
      expect(r.content.endsWith("\n...[truncated]")).toBe(true);
      expect(r.content.length).toBeLessThanOrEqual(500 + "\n...[truncated]".length + 5);
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

  it("shell returns utf8 text from the command", async () => {
    const command = process.platform === "win32" ? "Write-Output '中文输出'" : "printf '中文输出'";
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content).toContain("中文输出");
  });

  it("bash timeout keeps output already captured", async () => {
    const command =
      process.platform === "win32"
        ? "Write-Output 'before-timeout'; Start-Sleep -Seconds 30"
        : "echo before-timeout; sleep 30";
    const r = await host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), {
      ...ctx,
      bashTimeoutMs: 800,
    });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("before-timeout");
    expect(r.content).toMatch(/timeout/i);
  });

  it("bash cancel keeps output already captured", async () => {
    const ac = new AbortController();
    const command =
      process.platform === "win32"
        ? "Write-Output 'before-cancel'; Start-Sleep -Seconds 30"
        : "echo before-cancel; sleep 30";
    const pending = host.execute(SHELL_TOOL_NAME, JSON.stringify({ command }), {
      ...ctx,
      signal: ac.signal,
      bashTimeoutMs: 8_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    ac.abort();
    const r = await pending;
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("before-cancel");
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
    expect(isDangerousBash("rm -rf ~")).toBe(true);
    expect(isDangerousBash("rm -rf $HOME")).toBe(true);
    expect(isDangerousBash('rm -rf "$HOME/*"')).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse $env:USERPROFILE")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse %USERPROFILE%")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse C:\\Windows")).toBe(true);
    expect(isDangerousBash("Remove-Item -Recurse 'C:\\Program Files\\*'")).toBe(true);
    expect(isDangerousBash("rm -rf /etc")).toBe(true);
    expect(isDangerousBash("rm -rf /usr/*")).toBe(true);
    expect(isDangerousBash('rm -rf "$DIR/"')).toBe(true);
    expect(isDangerousBash('rm -rf "$DIR/*"')).toBe(true);
    expect(isDangerousBash('rm -rf "$DIR/build"')).toBe(false);
    expect(isDangerousBash("rm -rf ~/code")).toBe(false);
    expect(isDangerousBash("rm -rf /usr/bin")).toBe(false);
    expect(isDangerousBash("cd /tmp; rm -rf *")).toBe(false);
  });

  it("isDangerousBash sees through other spellings of a root wipe", () => {
    for (const cmd of [
      "rm -r /*",
      "rm -rf //",
      "rm -rf '/'",
      "rm -rf /tmp/..",
      "rm -rf / --no-preserve-root",
      "/bin/rm -rf /",
      "bash -c 'rm -rf /'",
      "echo $(rm -rf /)",
      "ls / | xargs rm -rf",
      "Remove-Item -Recurse -Force C:/",
      "Remove-Item -Recurse C:\\*",
      "Remove-Item C:\\ -Recurse",
      "Remove-Item -Path:C:\\ -Recurse",
      "Remove-Item -Recurse ‘C:\\’",
      "ri -r -fo D:\\",
      "Remove-Item -Recurse $env:SystemDrive\\",
      "Get-ChildItem C:\\ | Remove-Item -Recurse -Force",
      "gci / | ri -r",
      "Get-ChildItem C:\\ | ForEach-Object { Remove-Item $_.FullName -Recurse }",
      "del /s /q C:\\*",
      "rd /s /q C:\\",
      "cmd /c rd /s /q C:\\",
      "format /q D:",
      "diskpart /s wipe.txt",
      "wipefs -a /dev/sda",
      "cat /dev/zero > /dev/sda",
    ]) {
      expect(isDangerousBash(cmd), cmd).toBe(true);
    }
    for (const cmd of [
      "rm -r /tmp/x",
      "rm -rf -- ./build",
      "git rm -r --cached .",
      "Remove-Item C:\\temp\\a.txt",
      "Remove-Item -Force C:\\temp\\a.txt",
      "Get-ChildItem C:\\ | Select-Object Name",
      "Get-ChildItem C:\\ -Recurse -Filter *.log",
      "ls -R /",
      "echo /",
      "ls 2>/dev/null",
      "Get-Date -Format yyyy-MM-dd",
      "Get-ChildItem | Format-List -Property *",
      "git log --format=%H",
    ]) {
      expect(isDangerousBash(cmd), cmd).toBe(false);
    }
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

  it("reads and searches one skill by name and relative path", async () => {
    const skillsRoot = await mkdtemp(join(tmpdir(), "agent-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-skill-out-"));
    ctx.skillsRoot = skillsRoot;
    ctx.maxReadChars = 500;
    ctx.maxToolOutputChars = 2000;
    await mkdir(join(skillsRoot, "demo", "scripts"), { recursive: true });
    await mkdir(join(skillsRoot, "other"), { recursive: true });
    await writeFile(
      join(skillsRoot, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill.\n---\n# Demo\n",
      "utf8",
    );
    await writeFile(join(skillsRoot, "demo", "scripts", "build.py"), "print('NEEDLE')\n", "utf8");
    await writeFile(join(skillsRoot, "other", "secret.txt"), "OTHER\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE\n", "utf8");
    try {
      const read = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: "scripts/build.py" }),
        ctx,
      );
      expect(read.is_error).toBe(false);
      expect(read.content).toContain("NEEDLE");

      const escaped = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: "../other/secret.txt" }),
        ctx,
      );
      expect(escaped.is_error).toBe(true);
      expect(escaped.content).toMatch(/超出技能目录/);

      const absolute = await host.execute(
        "read_file",
        JSON.stringify({ path: join(skillsRoot, "demo", "scripts", "build.py") }),
        ctx,
      );
      expect(absolute.is_error).toBe(false);
      expect(absolute.content).toContain("NEEDLE");

      const namedAbsolute = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: join(skillsRoot, "demo", "scripts", "build.py") }),
        ctx,
      );
      expect(namedAbsolute.is_error).toBe(false);
      expect(namedAbsolute.content).toContain("NEEDLE");

      const sibling = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: join(skillsRoot, "other", "secret.txt") }),
        ctx,
      );
      expect(sibling.is_error).toBe(true);
      expect(sibling.content).toMatch(/超出技能目录/);

      const outsideRead = await host.execute(
        "read_file",
        JSON.stringify({ path: join(outside, "secret.txt") }),
        ctx,
      );
      expect(outsideRead.is_error).toBe(true);
      expect(outsideRead.content).toMatch(/outside/i);

      const workspaceFile = await host.execute(
        "read_file",
        JSON.stringify({ path: join(workspace, "hello.txt") }),
        ctx,
      );
      expect(workspaceFile.is_error).toBe(false);
      expect(workspaceFile.content).toContain("hello");

      const bare = await host.execute(
        "keyword_search",
        JSON.stringify({ path: join(skillsRoot, "demo", "scripts", "build.py"), query: "NEEDLE" }),
        ctx,
      );
      expect(bare.is_error).toBe(false);
      expect(bare.content).toContain("NEEDLE");
      expect(bare.content).toContain("skill demo");
      expect(bare.content).not.toContain("OTHER");

      const listed = await host.execute(
        "list_dir",
        JSON.stringify({ path: join(skillsRoot, "demo") }),
        ctx,
      );
      expect(listed.is_error).toBe(false);
      expect(listed.content).toContain("skill demo");
      expect(listed.content).toContain("scripts");
      expect(listed.content).not.toContain("secret.txt");

      const scripts = await host.execute(
        "list_dir",
        JSON.stringify({ skill: "demo", path: "scripts" }),
        ctx,
      );
      expect(scripts.is_error).toBe(false);
      expect(scripts.content).toContain("scripts/build.py");
      expect(scripts.content).not.toContain("secret.txt");

      const found = await host.execute(
        "keyword_search",
        JSON.stringify({
          skill: "demo",
          path: "scripts",
          queries: ["NEEDLE", "OTHER", "OUTSIDE"],
        }),
        ctx,
      );
      expect(found.is_error).toBe(false);
      expect(found.content).toContain("scripts/build.py");
      expect(found.content).toContain("NEEDLE");
      expect(found.content).toContain("skill demo");
      expect(found.content).not.toContain("OTHER");
      expect(found.content).not.toContain("OUTSIDE");

      const whole = await host.execute(
        "keyword_search",
        JSON.stringify({ skill: "demo", query: "NEEDLE" }),
        ctx,
      );
      expect(whole.is_error).toBe(false);
      expect(whole.content).toContain("scripts/build.py");
      expect(whole.content).toMatch(/whole skill demo/);

      await setSkillEnabled("demo", false, skillsRoot);
      const disabled = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: "scripts/build.py" }),
        ctx,
      );
      expect(disabled.is_error).toBe(true);
      expect(disabled.content).toMatch(/已停用/);
    } finally {
      await rmWorkspace(skillsRoot);
      await rmWorkspace(outside);
    }
  });

  it("skips a skill symlink that leaves the skill directory", async () => {
    const skillsRoot = await mkdtemp(join(tmpdir(), "agent-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-skill-out-"));
    ctx.skillsRoot = skillsRoot;
    ctx.maxToolOutputChars = 2000;
    await mkdir(join(skillsRoot, "demo", "scripts"), { recursive: true });
    await writeFile(join(skillsRoot, "demo", "scripts", "build.py"), "print('NEEDLE')\n", "utf8");
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "OUTSIDE\n", "utf8");
    try {
      await symlink(secret, join(skillsRoot, "demo", "scripts", "leak.txt"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await rmWorkspace(skillsRoot);
        await rmWorkspace(outside);
        return;
      }
      throw err;
    }
    try {
      const leaked = await host.execute(
        "read_file",
        JSON.stringify({ skill: "demo", path: "scripts/leak.txt" }),
        ctx,
      );
      expect(leaked.is_error).toBe(true);
      expect(leaked.content).toMatch(/超出技能目录/);

      const searched = await host.execute(
        "keyword_search",
        JSON.stringify({ skill: "demo", path: "scripts", query: "OUTSIDE" }),
        ctx,
      );
      expect(searched.is_error).toBe(false);
      expect(searched.content).not.toContain("OUTSIDE");

      const absoluteLeak = await host.execute(
        "read_file",
        JSON.stringify({ path: join(skillsRoot, "demo", "scripts", "leak.txt") }),
        ctx,
      );
      expect(absoluteLeak.is_error).toBe(true);
      expect(absoluteLeak.content).toMatch(/超出技能目录/);

      const listed = await host.execute(
        "list_dir",
        JSON.stringify({ path: join(skillsRoot, "demo", "scripts") }),
        ctx,
      );
      expect(listed.is_error).toBe(false);
      expect(listed.content).toContain("build.py");
      expect(listed.content).not.toContain("leak.txt");
      expect(listed.content).not.toContain("OUTSIDE");
    } finally {
      await rmWorkspace(skillsRoot);
      await rmWorkspace(outside);
    }
  });
});
