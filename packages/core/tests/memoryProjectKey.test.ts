import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectRoot, projectKeyFor, writeProjectFile } from "../src/memory/projectKey.js";
import { normalizeWorkspacePath, sessionRunKey } from "../src/runtime/sessionRuntimePool.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("project key", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-projkey-"));
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  async function repo(name: string): Promise<string> {
    const root = join(base, name);
    await mkdir(join(root, ".git", "worktrees", "feat"), { recursive: true });
    return root;
  }

  it("uses the directory that holds .git, also from a subdirectory", async () => {
    const root = await repo("demo");
    await mkdir(join(root, "packages", "core"), { recursive: true });
    expect(await findProjectRoot(root, base)).toEqual({ root, isGit: true });
    expect(await findProjectRoot(join(root, "packages", "core"), base)).toEqual({ root, isGit: true });
  });

  it("maps a worktree inside or outside the repository to the main checkout", async () => {
    const root = await repo("demo");
    const gitDir = join(root, ".git", "worktrees", "feat");
    await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");
    for (const worktree of [join(root, ".worktrees", "feat"), join(base, "elsewhere", "feat")]) {
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
      expect(await findProjectRoot(worktree, base)).toEqual({ root, isGit: true });
    }
  });

  it("gives each submodule its own root", async () => {
    const root = await repo("parent");
    await mkdir(join(root, ".git", "modules", "lib"), { recursive: true });
    const sub = join(root, "lib");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, ".git"), "gitdir: ../.git/modules/lib\n", "utf8");
    expect(await findProjectRoot(sub, base)).toEqual({ root: sub, isGit: true });
  });

  it("treats a .git file that cannot be followed as no repository", async () => {
    const dir = join(base, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".git"), "gitdir: ./missing\n", "utf8");
    expect(await findProjectRoot(dir, base)).toEqual({ root: dir, isGit: false });
    await writeFile(join(dir, ".git"), "not a pointer", "utf8");
    expect(await findProjectRoot(dir, base)).toEqual({ root: dir, isGit: false });
  });

  it("uses the workspace itself outside git", async () => {
    const dir = join(base, "plain", "folder");
    await mkdir(dir, { recursive: true });
    expect(await findProjectRoot(dir, base)).toEqual({ root: dir, isGit: false });
  });

  it("gives one key per root regardless of slashes and case", () => {
    const key = projectKeyFor("D:\\Work\\Long Task Agent");
    expect(key).toMatch(/^long-task-agent-[0-9a-f]{12}$/);
    expect(projectKeyFor("d:/work/long task agent/")).toBe(key);
    expect(projectKeyFor("D:\\Work\\Other")).not.toBe(key);
    expect(projectKeyFor("D:\\工作\\项目")).toMatch(/^project-[0-9a-f]{12}$/);
  });

  it("shares the path normalization with the session run key", () => {
    expect(normalizeWorkspacePath("D:\\Work\\Demo\\")).toBe("d:/work/demo");
    expect(sessionRunKey("D:\\Work\\Demo\\", "s1")).toBe(sessionRunKey("d:/work/demo", "s1"));
  });

  it("writes project.json once", async () => {
    const dir = join(base, "projects", "demo-000000000000");
    await mkdir(dir, { recursive: true });
    await writeProjectFile(dir, { key: "demo-000000000000", root: "D:\\Work\\Demo", isGit: true });
    await writeProjectFile(dir, { key: "demo-000000000000", root: "D:\\Elsewhere", isGit: false });
    const saved = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
    expect(saved).toMatchObject({ root: "D:\\Work\\Demo", is_git: true });
  });
});