import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleContext, elidePriorReadSkills } from "../src/context/assemble.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";
import {
  installSkill,
  listInstalledSkills,
  readInstalledSkillFile,
  replaceSkill,
  setSkillEnabled,
  uninstallSkill,
} from "../src/skills/installedSkills.js";
import { extractSkillTokens } from "../src/skills/tokens.js";
import { readSkillTool } from "../src/tools/readSkill.js";
import type { ToolContext } from "../src/tools/types.js";
import type { Message } from "../src/types.js";
import { classifyToolCall } from "../src/tools/policy.js";

const skillMd = `---
name: demo
description: >
  Make slides.
  Use for decks.
---
# Title

Do the thing.
`;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function toolCtx(root: string, attached?: string[]): ToolContext {
  return {
    workspacePath: root,
    bashTimeoutMs: 1000,
    maxToolOutputChars: 1000,
    maxReadChars: 100,
    maxSearchResults: 5,
    skillsRoot: root,
    attachedSkillNames: attached ? new Set(attached) : undefined,
  };
}

describe("skill frontmatter and tokens", () => {
  it("reads folded and literal descriptions and rejects a bad name", () => {
    const parsed = parseSkillMarkdown(skillMd);
    expect(parsed.name).toBe("demo");
    expect(parsed.description).toBe("Make slides. Use for decks.");
    expect(parsed.body).toContain("Do the thing.");
    const literal = parseSkillMarkdown("---\nname: demo\ndescription: |\n  line1\n  line2\n---\n");
    expect(literal.description).toBe("line1\nline2");
    expect(() => parseSkillMarkdown("# no fence\n")).toThrow(/frontmatter/);
    expect(() => parseSkillMarkdown("---\nname: Demo\ndescription: x\n---\n")).toThrow(/不合法/);
  });

  it("extracts slash tokens without matching paths or urls", () => {
    expect(extractSkillTokens("use /demo and /skill-creator")).toEqual(["demo", "skill-creator"]);
    expect(extractSkillTokens("C:/Windows https://example.com /demo")).toEqual(["demo"]);
    expect(extractSkillTokens("/demo /demo")).toEqual(["demo"]);
  });
});

describe("installed skills", () => {
  it("installs a snapshot, skips node_modules, and refuses a duplicate", async () => {
    const root = await tempDir("skills-root-");
    const source = await tempDir("skills-src-");
    try {
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await mkdir(join(source, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(source, "node_modules", "pkg", "index.js"), "nope", "utf8");
      await mkdir(join(source, "scripts", "node_modules"), { recursive: true });
      await writeFile(join(source, "scripts", "run.py"), "print(1)\n", "utf8");
      await writeFile(join(source, "scripts", "node_modules", "x.js"), "nope", "utf8");
      const installed = await installSkill(source, root);
      expect(installed).toEqual({ name: "demo", description: "Make slides. Use for decks.", enabled: true });
      expect(await readFile(join(root, "demo", "scripts", "run.py"), "utf8")).toBe("print(1)\n");
      await expect(readFile(join(root, "demo", "node_modules", "pkg", "index.js"))).rejects.toThrow();
      await expect(readFile(join(root, "demo", "scripts", "node_modules", "x.js"))).rejects.toThrow();
      await writeFile(join(source, "SKILL.md"), skillMd.replace("Do the thing.", "changed"), "utf8");
      expect(await readFile(join(root, "demo", "SKILL.md"), "utf8")).toContain("Do the thing.");
      await expect(installSkill(source, root)).rejects.toThrow(/已安装 demo/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it("replaces only when the frontmatter name matches", async () => {
    const root = await tempDir("skills-root-");
    const source = await tempDir("skills-src-");
    const other = await tempDir("skills-other-");
    try {
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await installSkill(source, root);
      await writeFile(join(root, "demo", "marker.txt"), "keep", "utf8");
      await writeFile(join(other, "SKILL.md"), "---\nname: other\ndescription: nope\n---\n", "utf8");
      await expect(replaceSkill("demo", other, root)).rejects.toThrow(/other/);
      expect(await readFile(join(root, "demo", "marker.txt"), "utf8")).toBe("keep");
      const next = skillMd.replace("Do the thing.", "replaced").replace("Make slides.", "Updated.");
      await writeFile(join(source, "SKILL.md"), next, "utf8");
      await replaceSkill("demo", source, root);
      expect(await readFile(join(root, "demo", "SKILL.md"), "utf8")).toContain("replaced");
      await expect(readFile(join(root, "demo", "marker.txt"))).rejects.toThrow();
      await uninstallSkill("demo", root);
      expect(await listInstalledSkills(root)).toEqual([]);
      await expect(uninstallSkill("demo", root)).rejects.toThrow(/未找到/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("lists a copied folder and hides a disabled skill without deleting it", async () => {
    const root = await tempDir("skills-root-");
    try {
      await mkdir(join(root, "demo"), { recursive: true });
      await writeFile(join(root, "demo", "SKILL.md"), skillMd, "utf8");
      expect(await listInstalledSkills(root)).toEqual([
        { name: "demo", description: "Make slides. Use for decks.", enabled: true },
      ]);
      await setSkillEnabled("demo", false, root);
      expect((await listInstalledSkills(root))[0]?.enabled).toBe(false);
      expect(await readFile(join(root, "demo", "SKILL.md"), "utf8")).toContain("name: demo");
      const hidden = await readInstalledSkillFile("demo", undefined, 50_000, root);
      expect(hidden.is_error).toBe(true);
      expect(hidden.content).toContain("已停用");
      await setSkillEnabled("demo", true, root);
      expect((await readInstalledSkillFile("demo", undefined, 50_000, root)).is_error).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails install when a symlink points outside the source", async () => {
    const root = await tempDir("skills-root-");
    const source = await tempDir("skills-src-");
    const outside = await tempDir("skills-out-");
    try {
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      try {
        await symlink(join(outside, "secret.txt"), join(source, "leak.txt"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      await expect(installSkill(source, root)).rejects.toThrow(/符号链接/);
      await expect(readFile(join(root, "demo", "SKILL.md"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads body and files inside the skill and rejects escape", async () => {
    const root = await tempDir("skills-root-");
    const source = await tempDir("skills-src-");
    const outside = await tempDir("skills-out-");
    try {
      await mkdir(join(source, "references"), { recursive: true });
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await writeFile(join(source, "references", "notes.md"), "note", "utf8");
      await writeFile(join(source, "icon.bin"), Buffer.from([0, 1, 2, 3]));
      await installSkill(source, root);
      const body = await readInstalledSkillFile("demo", undefined, 50_000, root);
      expect(body.is_error).toBe(false);
      expect(body.content).toContain("Do the thing.");
      expect(body.content).not.toContain("description:");
      const notes = await readInstalledSkillFile("demo", "references/notes.md", 50_000, root);
      expect(notes.content).toBe("note");
      const bin = await readInstalledSkillFile("demo", "icon.bin", 50_000, root);
      expect(bin.content).toMatch(/二进制文件，4 字节/);
      const escaped = await readInstalledSkillFile("demo", "../secret.txt", 50_000, root);
      expect(escaped.is_error).toBe(true);
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      try {
        await symlink(join(outside, "secret.txt"), join(root, "demo", "leak.txt"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      const leak = await readInstalledSkillFile("demo", "leak.txt", 50_000, root);
      expect(leak.is_error).toBe(true);
      expect(leak.content).toMatch(/超出技能目录/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("read_skill tool and assemble", () => {
  it("auto-allows read_skill and skips a body already attached to this submit", async () => {
    expect(classifyToolCall("read_skill", '{"name":"demo"}').risk).toBe("read");
    const root = await tempDir("skills-root-");
    const source = await tempDir("skills-src-");
    try {
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await installSkill(source, root);
      const fresh = await readSkillTool.execute({ name: "demo" }, toolCtx(root));
      expect(fresh.is_error).toBe(false);
      expect(fresh.content).toContain("Skill directory:");
      expect(fresh.content).toContain("Do the thing.");
      const again = await readSkillTool.execute({ name: "demo" }, toolCtx(root, ["demo"]));
      expect(again.content).toBe("已在上下文中");
      const missing = await readSkillTool.execute({ name: "missing" }, toolCtx(root));
      expect(missing.is_error).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it("puts the catalog and this submit's body in system, and stubs older read_skill results", () => {
    const older: Message = {
      id: "t",
      session_id: "s",
      turn_id: "old",
      role: "tool",
      name: "read_skill",
      tool_call_id: "c1",
      tool_call_arguments: JSON.stringify({ name: "demo", path: "references/notes.md" }),
      content: "a very long note",
      is_error: false,
      created_at: "2026-11-05T00:00:00.000Z",
    };
    const currentTool: Message = {
      ...older,
      id: "t2",
      turn_id: "now",
      tool_call_id: "c2",
      tool_call_arguments: JSON.stringify({ name: "demo" }),
      content: "full body",
    };
    const history: Message[] = [
      {
        id: "u0",
        session_id: "s",
        turn_id: "old",
        role: "user",
        content: "earlier",
        created_at: "2026-11-05T00:00:00.000Z",
      },
      older,
    ];
    const current: Message = {
      id: "u1",
      session_id: "s",
      turn_id: "now",
      role: "user",
      content: "use /demo",
      created_at: "2026-11-05T00:00:01.000Z",
    };
    const assembled = assembleContext({
      systemPrompt: "sys",
      toolDefinitions: [],
      history: [...history, currentTool],
      currentUser: current,
      contextCharLimit: 100_000,
      installedSkills: [{ name: "demo", description: "Make slides." }],
      skillBodies: [{ name: "demo", directory: "C:\\skills\\demo", body: "Do the thing." }],
    });
    const system = String(assembled.messages[0]?.content);
    expect(system).toContain("# Installed skills");
    expect(system.indexOf("# Installed skills")).toBeLessThan(system.indexOf("# Tools"));
    expect(system).toContain("# Skill body: demo");
    expect(system).toContain("Skill directory: C:\\skills\\demo");
    expect(system).toContain("Do the thing.");
    const stubbed = assembled.messages.find((message) => message.tool_call_id === "c1");
    expect(stubbed?.content).toBe("此前读过技能 demo 的references/notes.md。需要时再调用 read_skill。");
    const kept = assembled.messages.find((message) => message.tool_call_id === "c2");
    expect(kept?.content).toBe("full body");
    expect(older.content).toBe("a very long note");
    expect(elidePriorReadSkills([older, current])[0]?.content).toMatch(/此前读过/);
  });
});
