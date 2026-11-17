/** Parts of the memory page and the 已记住 line that do not touch the DOM. */

export type MemoryScope = "user" | "project";
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryOrigin = "extracted" | "edited" | "manual";
export type JournalOp = "create" | "update" | "delete" | "restore";

export interface MemoryEntryView {
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  created: string;
  modified: string;
  origin: MemoryOrigin;
  source?: { workspace: string; session: string; message: string };
  body: string;
}

export type InstructionStateView =
  | { kind: "missing" }
  | { kind: "loaded"; chars: number }
  | { kind: "truncated"; chars: number }
  | { kind: "skipped"; reason: string };

export interface InstructionFileView {
  scope: MemoryScope;
  path: string;
  state: InstructionStateView;
}

export interface MemoryJournalRow {
  id: string;
  at: string;
  scope: MemoryScope;
  name: string;
  op: JournalOp;
  actor: "extractor" | "user";
  undone: boolean;
}

export interface MemoryPageData {
  autoMemory: boolean;
  workspace: string | null;
  projectRoot: string | null;
  dirs: { user: string; project: string | null };
  instructions: { user: InstructionFileView; project: InstructionFileView | null };
  entries: MemoryEntryView[];
  unreadable: Array<{ scope: MemoryScope; file: string; reason: string }>;
  journal: MemoryJournalRow[];
}

export interface MemorySavedItem {
  scope: MemoryScope;
  name: string;
  op: JournalOp;
  journal_id: string;
}

export interface MemorySavedEvent {
  type: "memory_saved";
  workspace: string;
  session_id: string;
  items: MemorySavedItem[];
}

export type MemoryActionResult = { ok: true } | { ok: false; error: string };

const TYPE_ORDER: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
const TYPE_LABEL: Record<MemoryType, string> = { user: "用户", feedback: "反馈", project: "项目", reference: "参考" };
/** Same limit as instruction files in core. */
const INSTRUCTION_SHOWN = 8_000;

export function scopeTitle(scope: MemoryScope): string {
  return scope === "project" ? "本项目" : "所有项目";
}

export function groupByType(
  entries: readonly MemoryEntryView[],
  scope: MemoryScope,
): Array<{ type: MemoryType; label: string; entries: MemoryEntryView[] }> {
  return TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABEL[type],
    entries: entries
      .filter((entry) => entry.scope === scope && entry.type === type)
      .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0)),
  })).filter((group) => group.entries.length > 0);
}

export function originText(origin: MemoryOrigin): string {
  return origin === "extracted" ? "自动提取" : origin === "edited" ? "手改" : "手写";
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** By local calendar date, like the age the model sees. */
export function ageText(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "日期不明";
  const days = Math.round((startOfDay(now) - startOfDay(new Date(time))) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

/** Local time as YYYY-MM-DD HH:MM. */
export function stampText(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function instructionStateText(state: InstructionStateView): string {
  switch (state.kind) {
    case "missing":
      return "未创建";
    case "loaded":
      return state.chars ? `已加载 ${state.chars} 字` : "空文件";
    case "truncated":
      return `已截断：共 ${state.chars} 字，只加载前 ${INSTRUCTION_SHOWN} 字`;
    case "skipped":
      return `未加载：${state.reason}`;
  }
}

const OP_TEXT: Record<Exclude<JournalOp, "restore">, string> = { create: "新建了", update: "改了", delete: "删除了" };

export function journalText(row: MemoryJournalRow): string {
  const who = row.actor === "extractor" ? "后台" : "你";
  return row.op === "restore" ? `${who}撤销了 ${row.name} 的一次变更` : `${who}${OP_TEXT[row.op]} ${row.name}`;
}

/** An undo cannot be undone, and a change can be undone once. */
export function canUndo(row: MemoryJournalRow): boolean {
  return row.op !== "restore" && !row.undone;
}

export function savedLineGroups(items: readonly MemorySavedItem[]): Array<{ label: string; items: MemorySavedItem[] }> {
  const saved = items.filter((item) => item.op !== "delete");
  const deleted = items.filter((item) => item.op === "delete");
  return [
    ...(saved.length ? [{ label: "已记住", items: saved }] : []),
    ...(deleted.length ? [{ label: "已删除", items: deleted }] : []),
  ];
}

function samePath(a: string, b: string): boolean {
  const fold = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return fold(a) === fold(b);
}

/** The sidebar's spelling of the source workspace, or null when it is no longer in the sidebar. */
export function sourceWorkspace(source: { workspace: string } | undefined, known: readonly string[]): string | null {
  if (!source) return null;
  return known.find((path) => samePath(path, source.workspace)) ?? null;
}

/** Electron wraps a thrown Error as `Error invoking remote method 'channel': Error: …`. */
export function plainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
