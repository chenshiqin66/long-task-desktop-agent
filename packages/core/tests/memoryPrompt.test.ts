import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryEntry } from "../src/memory/entry.js";
import {
  AUTO_MEMORY_OFF_LINE,
  INDEX_LINE_MAX,
  MEMORY_SECTION_MAX,
  ageLabel,
  renderInstructionFiles,
  renderMemorySection,
} from "../src/memory/prompt.js";
import { MemoryStore } from "../src/memory/store.js";
import { snapshotTurnMemory } from "../src/memory/turn.js";
import { rmWorkspace } from "./rmWorkspace.js";

const NOW = new Date(2026, 10, 17, 12, 0, 0);
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).toISOString();

function note(over: Partial<MemoryEntry> & Pick<MemoryEntry, "name">): MemoryEntry {
  return {
    scope: "project",
    type: "feedback",
    description: `about ${over.name}`,
    body: `body of ${over.name}`,
    created: at(1),
    modified: at(17),
    origin: "extracted",
    ...over,
  };
}

describe("memory rendering", () => {
  it("labels age by local date", () => {
    expect(ageLabel(at(17, 0), NOW)).toBe("今天");
    expect(ageLabel(at(16, 23), NOW)).toBe("昨天");
    expect(ageLabel(at(5), NOW)).toBe("12 天前");
    expect(ageLabel("not a date", NOW)).toBe("日期不明");
  });

  it("puts user bodies first, then feedback with this project before all projects, then index lines", () => {
    const text = renderMemorySection(
      [
        note({ name: "board", type: "reference", modified: at(10) }),
        note({ name: "global-rule", scope: "user", modified: at(17) }),
        note({ name: "lang", scope: "user", type: "user", modified: at(5) }),
        note({ name: "local-rule", modified: at(16) }),
        note({ name: "deadline", type: "project", modified: at(14) }),
      ],
      { autoMemory: true, now: NOW },
    );
    expect(text).toBe(
      [
        "# Memory",
        "## user",
        "### lang（所有项目，12 天前）",
        "body of lang",
        "## feedback",
        "### local-rule（本项目，昨天）",
        "body of local-rule",
        "### global-rule（所有项目，今天）",
        "body of global-rule",
        "## Index",
        "- [project] deadline（本项目，3 天前）：about deadline",
        "- [reference] board（本项目，7 天前）：about board",
      ].join("\n"),
    );
  });

  it("turns bodies that do not fit into index lines and stays under 6000 characters", () => {
    const notes = Array.from({ length: 6 }, (_, i) => note({ name: `rule-${i}`, body: "x".repeat(1900), modified: at(17 - i) }));
    const text = renderMemorySection(notes, { autoMemory: true, now: NOW });
    expect(text.length).toBeLessThanOrEqual(MEMORY_SECTION_MAX);
    expect(text).toContain("### rule-0（本项目，今天）");
    expect(text).not.toContain("### rule-3");
    expect(text).toContain("- [feedback] rule-5（本项目，5 天前）：about rule-5");
  });

  it("stops at the budget and says how many notes were left out", () => {
    const notes = Array.from({ length: 200 }, (_, i) =>
      note({ name: `item-${String(i).padStart(3, "0")}`, type: "project", description: "d".repeat(120) }),
    );
    const text = renderMemorySection(notes, { autoMemory: true, now: NOW });
    expect(text.length).toBeLessThanOrEqual(MEMORY_SECTION_MAX);
    expect(text).toMatch(/\n还有 \d+ 条记忆没有列出。调用 memory_read 不带 name 可以列出全部。$/);
  });

  it("cuts an index line at 200 characters", () => {
    const text = renderMemorySection(
      [note({ name: "very-long-name-".repeat(4), type: "reference", description: "长".repeat(150) })],
      { autoMemory: true, now: NOW },
    );
    const line = text.split("\n").find((row) => row.startsWith("- [reference]"))!;
    expect(line).toHaveLength(INDEX_LINE_MAX);
    expect(line.endsWith("…")).toBe(true);
  });

  it("says automatic memory is off even with no notes, and renders nothing when there is nothing to say", () => {
    expect(renderMemorySection([], { autoMemory: false, now: NOW })).toBe(`# Memory\n${AUTO_MEMORY_OFF_LINE}`);
    expect(renderMemorySection([], { autoMemory: true, now: NOW })).toBe("");
  });

  it("renders the instruction files in order with their sources", () => {
    expect(
      renderInstructionFiles({
        user: { scope: "user", path: "u", text: "回复用中文。", state: { kind: "loaded", chars: 6 } },
        project: { scope: "project", path: "p", text: "Use two spaces.", state: { kind: "loaded", chars: 15 } },
      }),
    ).toBe("# User instructions\nSource: ~/.long-task-agent/AGENTS.md\n回复用中文。\n\n# Project instructions\nSource: AGENTS.md\nUse two spaces.");
  });
});

describe("turn memory snapshot", () => {
  let base: string;
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-memturn-"));
    home = join(base, "home");
    workspace = join(base, "ws");
    await mkdir(home, { recursive: true });
    await mkdir(join(workspace, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rmWorkspace(base);
  });

  it("gives the parent instructions and notes, and workers only the instructions", async () => {
    await writeFile(join(workspace, "AGENTS.md"), "Use two spaces.", "utf8");
    const store = new MemoryStore({ workspacePath: workspace, home });
    await store.upsert(
      { scope: "user", name: "lang", type: "user", description: "中文", body: "回复用中文。" },
      { actor: "user", origin: "manual", secrets: [] },
    );
    const turn = await snapshotTurnMemory({ store, autoMemory: async () => true }, NOW);
    expect(turn.block).toContain("# Project instructions\nSource: AGENTS.md\nUse two spaces.\n\n# Memory\n## user\n### lang（所有项目，");
    expect(turn.workerInstructions).toBe("# Project instructions\nSource: AGENTS.md\nUse two spaces.");
  });

  it("runs the turn without notes when the memory folder cannot be read", async () => {
    await writeFile(join(home, "memory"), "not a directory", "utf8");
    const store = new MemoryStore({ workspacePath: workspace, home });
    const turn = await snapshotTurnMemory({ store, autoMemory: async () => false }, NOW);
    expect(turn.block).toBe(`# Memory\n${AUTO_MEMORY_OFF_LINE}`);
  });
});
