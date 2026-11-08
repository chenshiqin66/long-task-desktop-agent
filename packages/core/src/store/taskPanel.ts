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

export interface TaskPanelView {
  rows: TaskPanelRow[];
  unreadable: string[];
  /** in_progress plus blocked. The button uses this to change color. */
  attention: number;
}

const GROUP_ORDER: Record<TaskPanelGroup, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  completed: 3,
};

function groupOf(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): TaskPanelGroup {
  if (task.status === "completed") return "completed";
  if (task.status === "in_progress") return "in_progress";
  if (openBlockedBy(task, byId).length) return "blocked";
  return "pending";
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
  return {
    rows,
    unreadable: [...snapshot.unreadable],
    attention: rows.filter((row) => row.group === "in_progress" || row.group === "blocked").length,
  };
}
