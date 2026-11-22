import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  migrateMemoryLayout,
  projectMemoryDir,
  userMemoryDir,
} from "../src/memory/paths.js";
import { MemoryStore } from "../src/memory/store.js";

describe("memory paths", () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mem-paths-"));
    workspace = join(home, "ws");
    await mkdir(workspace);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("keeps user and project memory in sibling folders under memory/", async () => {
    const s = new MemoryStore({ workspacePath: workspace, home });
    const projectDir = (await s.ensureDir("project"))!;
    const userDir = (await s.ensureDir("user"))!;
    expect(projectDir).toBe(join(home, "memory", "projects", (await s.projectInfo())!.key));
    expect(userDir).toBe(join(home, "memory", "user"));
    expect(userMemoryDir(home)).toBe(join(home, "memory", "user"));
    expect(projectMemoryDir(home, "demo-abc")).toBe(join(home, "memory", "projects", "demo-abc"));
  });

  it("flattens the old projects/<key>/memory layout into memory/projects/<key>", async () => {
    const key = "demo-111111111111";
    const legacyMem = join(home, "projects", key, "memory");
    await mkdir(legacyMem, { recursive: true });
    await writeFile(join(home, "projects", key, "project.json"), '{"root":"D:\\\\Demo"}\n', "utf8");
    await writeFile(
      join(legacyMem, "note.md"),
      ["---", "type: fact", "description: old", "---", "", "body"].join("\n"),
      "utf8",
    );
    await writeFile(join(legacyMem, "journal.jsonl"), "{}\n", "utf8");

    migrateMemoryLayout(home);

    const dest = projectMemoryDir(home, key);
    expect(await readFile(join(dest, "note.md"), "utf8")).toContain("old");
    expect(await readFile(join(dest, "project.json"), "utf8")).toContain("Demo");
    expect(await readFile(join(dest, "journal.jsonl"), "utf8")).toContain("{}");
    await expect(access(join(dest, "memory"))).rejects.toThrow();
    await expect(access(join(home, "projects"))).rejects.toThrow();
  });

  it("moves loose user memory files from memory/ into memory/user/", async () => {
    await mkdir(join(home, "memory", "projects", "keep-key"), { recursive: true });
    await writeFile(join(home, "memory", "projects", "keep-key", "project.json"), "{}\n", "utf8");
    await writeFile(
      join(home, "memory", "lang.md"),
      ["---", "type: user", "description: zh", "---", "", "中文"].join("\n"),
      "utf8",
    );
    await writeFile(join(home, "memory", "journal.jsonl"), "{}\n", "utf8");

    migrateMemoryLayout(home);

    expect(await readFile(join(home, "memory", "user", "lang.md"), "utf8")).toContain("中文");
    expect(await readFile(join(home, "memory", "user", "journal.jsonl"), "utf8")).toContain("{}");
    await expect(access(join(home, "memory", "lang.md"))).rejects.toThrow();
    await expect(access(join(home, "memory", "projects", "keep-key", "project.json"))).resolves.toBeUndefined();
  });
});
