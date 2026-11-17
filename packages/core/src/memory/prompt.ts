import type { MemoryEntry, MemoryScope, MemoryType } from "./entry.js";
import type { InstructionFile, InstructionFiles } from "./instructions.js";

export const MEMORY_SECTION_MAX = 6_000;
export const INDEX_LINE_MAX = 200;
export const AUTO_MEMORY_OFF_LINE = "Automatic memory is off. Nothing from this conversation will be saved.";
/** Room kept for the "还有 N 条" footer. */
const FOOTER_RESERVE = 60;
const TYPE_ORDER: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export const MEMORY_RULES = `
Memory:
- Notes in the Memory section were written in earlier sessions and may be out of date; each one shows its age. Before you act on a note that names a file, function, flag, or command, confirm that it still exists.
- When a note disagrees with what you see now, trust what you see, and tell the user which note looks outdated.
- User and project instructions outrank memory notes. When they disagree, follow the instructions.
- Only user and feedback notes show their body. For a project or reference note, call memory_read with its name when the topic comes up.
- If the user says not to use memory, ignore the Memory section for the rest of this conversation.
- You cannot save notes. After a turn ends, notes are saved automatically from what the user said, unless the Memory section says automatic memory is off. When the user asks you to remember something, say it will be saved after this turn ends; do not say it is already saved. When automatic memory is off, say so and suggest adding it to AGENTS.md.`;

export function scopeLabel(scope: MemoryScope): string {
  return scope === "user" ? "所有项目" : "本项目";
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** By local calendar date, not by elapsed hours. */
export function ageLabel(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "日期不明";
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(new Date(time))) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

/** user, feedback, project, reference; this project's feedback before every project's; then newest first. */
export function orderForContext(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    const byType = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    if (byType !== 0) return byType;
    if (a.type === "feedback" && a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.modified !== b.modified) return a.modified < b.modified ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function indexLine(entry: MemoryEntry, now: Date): string {
  const line = `- [${entry.type}] ${entry.name}（${scopeLabel(entry.scope)}，${ageLabel(entry.modified, now)}）：${entry.description}`;
  return line.length > INDEX_LINE_MAX ? `${line.slice(0, INDEX_LINE_MAX - 1)}…` : line;
}

/**
 * At most MEMORY_SECTION_MAX characters. Bodies of user and feedback notes
 * come first; a body that does not fit becomes an index line. Index lines
 * stop at the first that does not fit, and a footer counts what was left out.
 */
export function renderMemorySection(entries: readonly MemoryEntry[], opts: { autoMemory: boolean; now: Date }): string {
  if (!entries.length && opts.autoMemory) return "";
  const lines = ["# Memory"];
  if (!opts.autoMemory) lines.push(AUTO_MEMORY_OFF_LINE);
  let used = lines.join("\n").length;
  const fits = (text: string) => used + 1 + text.length + FOOTER_RESERVE <= MEMORY_SECTION_MAX;
  const push = (text: string) => {
    lines.push(text);
    used += 1 + text.length;
  };

  const ordered = orderForContext(entries);
  const demoted: MemoryEntry[] = [];
  let heading: MemoryType | null = null;
  for (const entry of ordered) {
    if (entry.type !== "user" && entry.type !== "feedback") continue;
    const block = `### ${entry.name}（${scopeLabel(entry.scope)}，${ageLabel(entry.modified, opts.now)}）\n${entry.body}`;
    const head = heading === entry.type ? "" : `## ${entry.type}\n`;
    if (!fits(head + block)) {
      demoted.push(entry);
      continue;
    }
    if (head) {
      push(`## ${entry.type}`);
      heading = entry.type;
    }
    push(block);
  }

  const indexed = orderForContext([
    ...demoted,
    ...ordered.filter((entry) => entry.type === "project" || entry.type === "reference"),
  ]);
  let shown = 0;
  if (indexed.length && fits("## Index")) {
    push("## Index");
    for (const entry of indexed) {
      const line = indexLine(entry, opts.now);
      if (!fits(line)) break;
      push(line);
      shown += 1;
    }
  }
  const left = indexed.length - shown;
  if (left > 0) lines.push(`还有 ${left} 条记忆没有列出。调用 memory_read 不带 name 可以列出全部。`);
  return lines.join("\n");
}

function instructionBlock(file: InstructionFile | null, title: string, source: string): string {
  return file?.text ? `# ${title}\nSource: ${source}\n${file.text}` : "";
}

export function renderInstructionFiles(files: InstructionFiles): string {
  return [
    instructionBlock(files.user, "User instructions", "~/.long-task-agent/AGENTS.md"),
    instructionBlock(files.project, "Project instructions", "AGENTS.md"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderMemoryContext(
  files: InstructionFiles,
  entries: readonly MemoryEntry[],
  opts: { autoMemory: boolean; now: Date },
): string {
  return [renderInstructionFiles(files), renderMemorySection(entries, opts)].filter(Boolean).join("\n\n");
}
