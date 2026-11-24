import { isSubagentId } from "./subagentStore.js";
import { openBlockedBy, type TaskListSnapshot, type TaskRecord } from "./taskStore.js";

export type TaskPanelGroup = "in_progress" | "blocked" | "pending" | "completed";

export interface TaskPanelBlocker {
  id: string;
  /** The blocker id is not in the list. */
  missing: boolean;
}

export interface TaskPanelRow {
  id: string;
  subject: string;
  description: string;
  group: TaskPanelGroup;
  owner: string | null;
  /** in_progress, and the owner is a subagent that is not still running. */
  ownerStopped: boolean;
  blockers: TaskPanelBlocker[];
}

export interface TaskPanelBatch {
  /** 1-based order in the session, by first task id. */
  index: number;
  /** Completed/total, or "11 √" when this batch is all done. */
  progressLabel: string;
  /** Progress text, with a leading index only when the session has more than one batch. */
  tabLabel: string;
  /** in_progress plus blocked in this batch. */
  attention: number;
  allComplete: boolean;
  rowIds: string[];
}

export interface TaskPanelView {
  rows: TaskPanelRow[];
  unreadable: string[];
  /** in_progress plus blocked across every batch. The button uses this to change color. */
  attention: number;
  /** Composer button suffix for the focus batch: completed/total, or "11 √" when that batch is done. */
  progressLabel: string;
  batches: TaskPanelBatch[];
  /** Index into batches for the composer button and the default tab. 0 when empty. */
  focusBatchIndex: number;
}

const GROUP_ORDER: Record<TaskPanelGroup, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  completed: 3,
};

/** Two dependency-disconnected groups join one batch if their created_at ranges are this close. */
export const BATCH_GAP_MS = 30 * 60 * 1000;

/**
 * Composer / tab count: completed over total, e.g. "4/11" means 4 done, 7 still open.
 * When every row is completed, show "11 √" instead of "11/11".
 */
export function taskProgressLabel(rows: readonly Pick<TaskPanelRow, "group">[]): string {
  const total = rows.length;
  if (!total) return "";
  const done = rows.filter((row) => row.group === "completed").length;
  if (done === total) return `${total} √`;
  return `${done}/${total}`;
}

interface BatchSeed {
  id: string;
  blockedBy: readonly string[];
  blocks: readonly string[];
  created_at: string;
}

/**
 * Split session tasks into batches: union by dependency, then merge groups
 * whose created_at ranges overlap or sit within BATCH_GAP_MS.
 * Batches are ordered by the lowest task id.
 */
export function groupTaskBatches(tasks: readonly BatchSeed[]): string[][] {
  if (!tasks.length) return [];
  const ids = tasks.map((task) => task.id);
  const present = new Set(ids);
  const parent = new Map<string, string>(ids.map((id) => [id, id]));

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    if (!present.has(a) || !present.has(b)) return;
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  };

  for (const task of tasks) {
    for (const id of task.blockedBy) union(task.id, id);
    for (const id of task.blocks) union(task.id, id);
  }

  const groups = new Map<string, BatchSeed[]>();
  for (const task of tasks) {
    const root = find(task.id);
    const list = groups.get(root);
    if (list) list.push(task);
    else groups.set(root, [task]);
  }

  const comps = [...groups.values()].map((members) => {
    const times = members.map((item) => Date.parse(item.created_at) || 0);
    return {
      members,
      minId: Math.min(...members.map((item) => Number(item.id))),
      minT: Math.min(...times),
      maxT: Math.max(...times),
    };
  });
  comps.sort((a, b) => a.minT - b.minT || a.minId - b.minId);

  const merged: typeof comps = [];
  for (const comp of comps) {
    const last = merged[merged.length - 1];
    if (last && comp.minT - last.maxT <= BATCH_GAP_MS) {
      last.members.push(...comp.members);
      last.minId = Math.min(last.minId, comp.minId);
      last.minT = Math.min(last.minT, comp.minT);
      last.maxT = Math.max(last.maxT, comp.maxT);
    } else {
      merged.push({
        members: [...comp.members],
        minId: comp.minId,
        minT: comp.minT,
        maxT: comp.maxT,
      });
    }
  }

  return merged
    .map((item) => item.members.map((member) => member.id).sort((a, b) => Number(a) - Number(b)))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
}

function groupOf(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): TaskPanelGroup {
  if (task.status === "completed") return "completed";
  if (task.status === "in_progress") return "in_progress";
  if (openBlockedBy(task, byId).length) return "blocked";
  return "pending";
}

function focusBatchIndex(batches: readonly TaskPanelBatch[], rowsById: ReadonlyMap<string, TaskPanelRow>): number {
  if (!batches.length) return 0;
  const hasGroup = (group: TaskPanelGroup) =>
    batches.findIndex((batch) => batch.rowIds.some((id) => rowsById.get(id)?.group === group));
  const inProgress = hasGroup("in_progress");
  if (inProgress >= 0) return inProgress;
  const blocked = hasGroup("blocked");
  if (blocked >= 0) return blocked;
  const open = batches.findIndex((batch) => !batch.allComplete);
  if (open >= 0) return open;
  return batches.length - 1;
}

export function buildTaskPanel(
  snapshot: TaskListSnapshot,
  subagentStatus: Readonly<Record<string, string>>,
): TaskPanelView {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const rows = snapshot.tasks.map((task): TaskPanelRow => {
    const group = groupOf(task, byId);
    const owner = task.owner ?? null;
    const ownerStopped =
      task.status === "in_progress" &&
      owner != null &&
      isSubagentId(owner) &&
      subagentStatus[owner] !== "running";
    const blockers =
      group === "blocked"
        ? openBlockedBy(task, byId).map((id) => ({ id, missing: !byId.has(id) }))
        : [];
    return {
      id: task.id,
      subject: task.subject,
      description: task.description,
      group,
      owner,
      ownerStopped,
      blockers,
    };
  });
  rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || Number(a.id) - Number(b.id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const groups = groupTaskBatches(snapshot.tasks);
  const many = groups.length > 1;
  const batches: TaskPanelBatch[] = groups.map((rowIds, i) => {
    const batchRows = rowIds.map((id) => rowsById.get(id)!);
    const progressLabel = taskProgressLabel(batchRows);
    const index = i + 1;
    const attention = batchRows.filter((row) => row.group === "in_progress" || row.group === "blocked").length;
    const allComplete = batchRows.length > 0 && batchRows.every((row) => row.group === "completed");
    return {
      index,
      progressLabel,
      tabLabel: many ? `${index} ${progressLabel}` : progressLabel,
      attention,
      allComplete,
      rowIds,
    };
  });
  const focus = focusBatchIndex(batches, rowsById);
  const view: TaskPanelView = {
    rows,
    unreadable: [...snapshot.unreadable],
    attention: rows.filter((row) => row.group === "in_progress" || row.group === "blocked").length,
    progressLabel: batches[focus]?.progressLabel ?? "",
    batches,
    focusBatchIndex: focus,
  };
  return view;
}
