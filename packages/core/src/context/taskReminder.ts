import type { Message } from "../types.js";
import { formatTaskList, isTaskTool } from "../tools/taskTools.js";
import type { TaskRecord } from "../store/taskStore.js";

/** Assistant replies with no task tool before the parent is shown the open list again. */
export const TASK_REMINDER_EVERY = 10;

/** Assistant replies after the latest task tool. The reply that called the tool is not counted. */
export function assistantTurnsSinceTaskWork(messages: readonly Message[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "tool" && message.name && isTaskTool(message.name)) return count;
    if (message.role === "assistant") {
      if (message.tool_calls?.some((call) => isTaskTool(call.function.name))) return count;
      count += 1;
    }
  }
  return count;
}

export function shouldRemindTasks(opts: {
  messages: readonly Message[];
  openTaskCount: number;
  /** Assistant replies already in history when the previous reminder was attached. */
  assistantCountAtLastReminder: number | null;
}): boolean {
  if (opts.openTaskCount < 1) return false;
  if (assistantTurnsSinceTaskWork(opts.messages) < TASK_REMINDER_EVERY) return false;
  const assistants = opts.messages.filter((message) => message.role === "assistant").length;
  if (opts.assistantCountAtLastReminder == null) return true;
  return assistants - opts.assistantCountAtLastReminder >= TASK_REMINDER_EVERY;
}

export function taskReminderText(tasks: readonly TaskRecord[]): string {
  const open = tasks.filter((task) => task.status !== "completed");
  return [
    `Task reminder: the task tools have not been used in the last ${TASK_REMINDER_EVERY} replies. Open tasks:`,
    formatTaskList(open, []),
    "Pending tasks can be claimed. in_progress tasks already have an owner. complete_task only succeeds for that owner.",
    "To hand a listed task to a subagent, pass task_id and do not claim it yourself.",
    "Do not mention this reminder.",
  ].join("\n");
}
