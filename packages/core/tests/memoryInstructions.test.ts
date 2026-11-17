import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INSTRUCTION_CHAR_LIMIT, readInstructionFiles } from "../src/memory/instructions.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("instruction files", () => {
  let base: string;
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-instr-"));
    home = join(base, "home");
    workspace = join(base, "ws");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  it("reads the user file and the workspace AGENTS.md without the BOM", async () => {
    await writeFile(join(home, "AGENTS.md"), "\uFEFF回复用中文。\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "Use two spaces.\n", "utf8");
    const files = await readInstructionFiles({ home, workspacePath: workspace });
    expect(files.user).toMatchObject({ scope: "user", text: "回复用中文。", state: { kind: "loaded", chars: 6 } });
    expect(files.project).toMatchObject({ scope: "project", text: "Use two spaces.", state: { kind: "loaded", chars: 15 } });
  });

  it("reads only AGENTS.md in the workspace root", async () => {
    await writeFile(join(workspace, "RULES.md"), "other rules", "utf8");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "AGENTS.md"), "nested", "utf8");
    await writeFile(join(base, "AGENTS.md"), "parent", "utf8");
    const files = await readInstructionFiles({ home, workspacePath: workspace });
    expect(files.project).toMatchObject({ text: "", state: { kind: "missing" } });
    expect(files.user.state).toEqual({ kind: "missing" });
  });

  it("keeps the first 8000 characters and says how many are left", async () => {
    await writeFile(join(workspace, "AGENTS.md"), "a".repeat(INSTRUCTION_CHAR_LIMIT + 120), "utf8");
    await writeFile(join(home, "AGENTS.md"), "b".repeat(INSTRUCTION_CHAR_LIMIT + 5), "utf8");
    const files = await readInstructionFiles({ home, workspacePath: workspace });
    expect(files.project?.state).toEqual({ kind: "truncated", chars: INSTRUCTION_CHAR_LIMIT + 120 });
    expect(files.project?.text).toBe(
      `${"a".repeat(INSTRUCTION_CHAR_LIMIT)}\n\n正文在此截断。后面还有 120 字。需要后文时用 read_file 读 AGENTS.md。`,
    );
    expect(files.user.text.endsWith("正文在此截断。后面还有 5 字没有加载。")).toBe(true);
  });

  it("skips a file over 1 MiB", async () => {
    await writeFile(join(workspace, "AGENTS.md"), "x".repeat(1024 * 1024 + 1), "utf8");
    const files = await readInstructionFiles({ home, workspacePath: workspace });
    expect(files.project).toMatchObject({ text: "", state: { kind: "skipped", reason: "文件超过 1 MiB" } });
  });

  it("skips a project AGENTS.md that links outside the workspace", async (ctx) => {
    const outside = join(base, "private.md");
    await writeFile(outside, "private notes", "utf8");
    try {
      await symlink(outside, join(workspace, "AGENTS.md"), "file");
    } catch {
      ctx.skip();
      return;
    }
    const files = await readInstructionFiles({ home, workspacePath: workspace });
    expect(files.project).toMatchObject({ text: "", state: { kind: "skipped", reason: "文件指到了工作区外" } });
  });

  it("has no project file without a workspace", async () => {
    expect((await readInstructionFiles({ home, workspacePath: null })).project).toBeNull();
  });
});