import { describe, it, expect } from "vitest";
import {
  checkMemoryFields,
  findSecret,
  parseMemoryFile,
  serializeMemory,
  typeFitsScope,
  type MemoryEntry,
} from "../src/memory/entry.js";
import { parseSkillMarkdown, splitFrontmatter } from "../src/skills/frontmatter.js";

const MTIME = new Date("2026-11-05T08:00:00.000Z");

function read(raw: string, fileName = "note.md", scope: "user" | "project" = "user") {
  return parseMemoryFile(raw, { scope, fileName, mtime: MTIME });
}

describe("memory files", () => {
  it("reads the minimal hand-written form", () => {
    expect(read("---\ndescription: 回复用中文\ntype: user\n---\n回复用中文。\n", "reply-language.md")).toEqual({
      ok: true,
      entry: {
        scope: "user",
        name: "reply-language",
        description: "回复用中文",
        type: "user",
        created: MTIME.toISOString(),
        modified: MTIME.toISOString(),
        origin: "manual",
        body: "回复用中文。",
      },
    });
  });

  it("round-trips every field the app writes", () => {
    const entry: MemoryEntry = {
      scope: "project",
      name: "run-root-start",
      description: "改了 core 之后用根目录的 npm start",
      type: "feedback",
      created: "2026-11-17T10:03:00.000Z",
      modified: "2026-11-17T10:05:00.000Z",
      origin: "extracted",
      source: { workspace: "D:\\myAIrepo\\demo", session: "sess_1", message: "msg_1" },
      body: "第一行\n\n原因：旧代码。\n适用：动过 core 时。",
    };
    expect(read(serializeMemory(entry), "run-root-start.md", "project")).toEqual({ ok: true, entry });
  });

  it("explains why a file cannot be read", () => {
    expect(read("no fence")).toEqual({ ok: false, reason: "缺少 frontmatter" });
    expect(read("---\nname: other\ndescription: d\ntype: user\n---\nb")).toMatchObject({ ok: false });
    expect(read("---\ndescription: d\ntype: user\n---\nb", "Bad Name.md")).toMatchObject({ ok: false });
    expect(read("---\ndescription: d\ntype: secret\n---\nb")).toMatchObject({ ok: false });
    expect(read("---\ndescription: d\ntype: project\n---\nb")).toMatchObject({ ok: false });
    expect(read("---\ndescription: d\ntype: user\n---\n   ")).toMatchObject({ ok: false });
    expect(read(`---\ndescription: d\ntype: user\n---\n${"x".repeat(2001)}`)).toMatchObject({ ok: false });
    expect(read("---\ndescription: |\n  two\n  lines\ntype: user\n---\nb")).toMatchObject({ ok: false });
    expect(read("---\ntype: user\n---\nb")).toMatchObject({ ok: false });
  });

  it("falls back to the file time and manual origin for bad optional fields", () => {
    expect(read("---\ndescription: d\ntype: reference\ncreated: yesterday\norigin: robot\n---\nb", "board.md", "project")).toMatchObject({
      ok: true,
      entry: { created: MTIME.toISOString(), origin: "manual" },
    });
  });

  it("applies the scope rule for each type", () => {
    expect(typeFitsScope("user", "user")).toBe(true);
    expect(typeFitsScope("user", "project")).toBe(false);
    expect(typeFitsScope("project", "user")).toBe(false);
    expect(typeFitsScope("feedback", "user")).toBe(true);
    expect(typeFitsScope("reference", "project")).toBe(true);
  });

  it("checks description length and quoting", () => {
    const base = { scope: "user" as const, name: "n", type: "user", body: "b" };
    expect(checkMemoryFields({ ...base, description: "x".repeat(151) })).toMatch(/150/);
    expect(checkMemoryFields({ ...base, description: '"quoted"' })).not.toBeNull();
    expect(checkMemoryFields({ ...base, description: ">" })).not.toBeNull();
    expect(checkMemoryFields({ ...base, description: "fine" })).toBeNull();
  });

  it("finds configured secrets, URL key parameters and token-shaped strings", () => {
    expect(findSecret("uses abcdef-123456 here", ["abcdef-123456"])).toBe("配置里的密钥");
    expect(findSecret("short abc here", ["abc"])).toBeNull();
    const url = "https://x.example.com/a?api_key=zzz999";
    expect(findSecret(url, [])).toBe("URL 里的密钥参数");
    expect(findSecret(url, [])).toBe("URL 里的密钥参数");
    expect(findSecret(`sk-${"A".repeat(24)}`, [])).toBe("形似 API 令牌的字符串");
    expect(findSecret(`github_pat_${"1".repeat(22)}`, [])).toBe("形似 API 令牌的字符串");
    expect(findSecret("task-abcdefghijklmnopqrstuvwxyz", [])).toBeNull();
    expect(findSecret("use pnpm, not npm", [])).toBeNull();
  });

  it("keeps the skill messages now that skills share the field parser", () => {
    expect(() => parseSkillMarkdown("no fence")).toThrow("技能说明无效：缺少 frontmatter");
    expect(() => parseSkillMarkdown("---\nname: x\n")).toThrow("技能说明无效：frontmatter 没有结束");
    expect(() => parseSkillMarkdown("---\n: broken\n---\n")).toThrow("技能说明无效：无法解析 frontmatter");
    expect(splitFrontmatter("---\na: 1\n---\nbody")).toEqual({ fields: { a: "1" }, body: "body" });
  });
});
