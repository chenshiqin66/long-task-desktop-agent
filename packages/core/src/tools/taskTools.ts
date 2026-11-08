import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";
import {
  openBlockedBy,
  TaskStore,
  type TaskRecord,
} from "../store/taskStore.js";

/** Parent session, when the model omits owner. A deferred run should pass its own id. */
export const MAIN_TASK_OWNER = "main";

export const TASK_TOOL_NAMES = [
  "task_create",
  "task_list",
  "task_get",
  "task_update",
  "task_delete",
  "claim_task",
  "complete_task",
] as const;

export function isTaskTool(name: string): boolean {
  return (TASK_TOOL_NAMES as readonly string[]).includes(name);
}

const ID_PARAM = {
  type: "string",
  description: "Task id, such as 1. A leading # is accepted.",
};

function finish(ctx: ToolContext, content: string, isError = false): ToolResult {
  return { content: truncateOutput(content, ctx.maxToolOutputChars), is_error: isError };
}

async function withStore(
  ctx: ToolContext,
  run: (store: TaskStore) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!ctx.sessionId) {
    return { content: "Task tools belong to the parent session.", is_error: true };
  }
  try {
    return await run(TaskStore.forSession(ctx.workspacePath, ctx.sessionId));
  } catch (err) {
    return finish(ctx, err instanceof Error ? err.message : String(err), true);
  }
}

function ownerArg(raw: unknown, ctx: ToolContext): { ok: true; owner: string } | { ok: false; error: string } {
  const explicit = typeof raw === "string" ? raw.trim() : "";
  if (ctx.taskOwner) {
    if (explicit && explicit !== ctx.taskOwner) {
      return { ok: false, error: `owner is ${ctx.taskOwner}` };
    }
    return { ok: true, owner: ctx.taskOwner };
  }
  return { ok: true, owner: explicit || MAIN_TASK_OWNER };
}

function idArg(raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  return typeof raw === "string" ? raw : "";
}

export function formatTaskLine(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): string {
  const owner = task.owner ? ` (${task.owner})` : "";
  const open = task.status === "pending" ? openBlockedBy(task, byId) : [];
  const blocked = open.length > 0 ? ` [blocked by ${open.map((id) => `#${id}`).join(", ")}]` : "";
  return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
}

export function formatTaskList(tasks: readonly TaskRecord[], unreadable: readonly string[]): string {
  if (tasks.length === 0 && unreadable.length === 0) return "No tasks.";
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lines = tasks.map((task) => formatTaskLine(task, byId));
  for (const name of unreadable) lines.push(`Unreadable task file: ${name}`);
  return lines.join("\n");
}

function formatTask(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): string {
  const blocks = task.blocks.length > 0 ? task.blocks.map((id) => `#${id}`).join(", ") : "(none)";
  const blockedBy =
    task.blockedBy.length > 0
      ? task.blockedBy
          .map((id) => {
            const dep = byId.get(id);
            return dep ? `#${id} [${dep.status}]` : `#${id} [missing]`;
          })
          .join(", ")
      : "(none)";
  const open = openBlockedBy(task, byId);
  return [
    formatTaskLine(task, byId),
    `owner: ${task.owner ?? "(none)"}`,
    `blocks: ${blocks}`,
    `blocked by: ${blockedBy}`,
    `open blockers: ${open.length > 0 ? open.map((id) => `#${id}`).join(", ") : "(none)"}`,
    "description:",
    task.description,
  ].join("\n");
}

export const taskCreateTool: Tool = {
  definition: {
    name: "task_create",
    description: [
      "Record one step of a piece of work that has several dependent steps. This does not run the step and does not start a subagent.",
      "subject is a short imperative. description says what done looks like and what not to do.",
      "blocked_by lists task ids that must be completed before this one can be claimed. The new task is pending.",
      "Skip this for a single edit or a question.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short imperative title, 200 characters or fewer" },
        description: {
          type: "string",
          description: "What done looks like, and what is out of scope",
        },
        blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must be completed first. Omit when nothing blocks this step.",
        },
      },
      required: ["subject", "description"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      if (args.blocked_by !== undefined && !Array.isArray(args.blocked_by)) {
        return finish(ctx, "blocked_by must be a list of task ids", true);
      }
      const created = await store.create({
        subject: typeof args.subject === "string" ? args.subject : "",
        description: typeof args.description === "string" ? args.description : "",
        blockedBy: Array.isArray(args.blocked_by) ? args.blocked_by : [],
      });
      if (!created.ok) return finish(ctx, created.error, true);
      return finish(ctx, `Created ${formatTaskLine(created.value, new Map([[created.value.id, created.value]]))}`);
    });
  },
};

export const taskListTool: Tool = {
  definition: {
    name: "task_list",
    description: [
      "List this session's tasks in id order.",
      "A pending task with open blockers is marked blocked and claim_task will fail for it. Completed blockers are left off that note.",
      "This list does not run any task.",
    ].join(" "),
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      const snapshot = await store.list();
      return finish(ctx, formatTaskList(snapshot.tasks, snapshot.unreadable));
    });
  },
};

export const taskGetTool: Tool = {
  definition: {
    name: "task_get",
    description: "Read one task, including its description, owner, and dependency ids.",
    parameters: {
      type: "object",
      properties: { task_id: ID_PARAM },
      required: ["task_id"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      const got = await store.get(idArg(args.task_id));
      if (!got.ok) return finish(ctx, got.error, true);
      const snapshot = await store.list();
      const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
      byId.set(got.value.id, got.value);
      return finish(ctx, formatTask(got.value, byId));
    });
  },
};

export const taskUpdateTool: Tool = {
  definition: {
    name: "task_update",
    description: [
      "Change a task's subject, description, or dependency links.",
      "Does not change status. Use claim_task to start a task and complete_task to finish it.",
      "Dependencies can change only while the task is pending.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task_id: ID_PARAM,
        subject: { type: "string", description: "Replacement title. Omit to leave it." },
        description: { type: "string", description: "Replacement description. Omit to leave it." },
        add_blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Blocker ids to add.",
        },
        remove_blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Blocker ids to drop.",
        },
      },
      required: ["task_id"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if ("status" in args || "owner" in args) {
      return finish(ctx, "status and owner change only through claim_task and complete_task", true);
    }
    if (
      (args.add_blocked_by !== undefined && !Array.isArray(args.add_blocked_by)) ||
      (args.remove_blocked_by !== undefined && !Array.isArray(args.remove_blocked_by))
    ) {
      return finish(ctx, "blocked_by changes must be lists of task ids", true);
    }
    return withStore(ctx, async (store) => {
      const updated = await store.update({
        id: idArg(args.task_id),
        ...(typeof args.subject === "string" ? { subject: args.subject } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(Array.isArray(args.add_blocked_by) ? { addBlockedBy: args.add_blocked_by } : {}),
        ...(Array.isArray(args.remove_blocked_by) ? { removeBlockedBy: args.remove_blocked_by } : {}),
      });
      if (!updated.ok) return finish(ctx, updated.error, true);
      const snapshot = await store.list();
      const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
      return finish(ctx, `Updated ${formatTaskLine(updated.value, byId)}`);
    });
  },
};

export const taskDeleteTool: Tool = {
  definition: {
    name: "task_delete",
    description: [
      "Remove one task and drop its id from other tasks' blocks and blocked_by lists.",
      "The id is not reused. Does not run or cancel a subagent.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: { task_id: ID_PARAM },
      required: ["task_id"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      const deleted = await store.delete(idArg(args.task_id));
      if (!deleted.ok) return finish(ctx, deleted.error, true);
      const progress = deleted.value.status === "in_progress" ? ` It was in_progress${deleted.value.owner ? `, owned by ${deleted.value.owner}` : ""}.` : "";
      return finish(ctx, `Deleted #${deleted.value.id} ${deleted.value.subject}.${progress}`);
    });
  },
};

export const claimTaskTool: Tool = {
  definition: {
    name: "claim_task",
    description: [
      "Move a pending task to in_progress and set its owner.",
      "Fails if the task is not pending, or if any blocked_by task is not completed.",
      "Call this when you start the work. Omit owner: the parent is main, and a subagent is itself.",
      "Two claims of the same task cannot both succeed.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task_id: ID_PARAM,
        owner: {
          type: "string",
          description: "Who is taking the task. Omit this. The parent is recorded as main, and a subagent as its own id.",
        },
      },
      required: ["task_id"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      const owner = ownerArg(args.owner, ctx);
      if (!owner.ok) return finish(ctx, owner.error, true);
      const claimed = await store.claim(idArg(args.task_id), owner.owner);
      if (!claimed.ok) return finish(ctx, claimed.error, true);
      return finish(ctx, `Claimed #${claimed.value.id} (${claimed.value.subject}) as ${claimed.value.owner}`);
    });
  },
};

export const completeTaskTool: Tool = {
  definition: {
    name: "complete_task",
    description: [
      "Move an in_progress task to completed. Fails unless you are the owner who claimed it.",
      "This is the only way to finish a task and release tasks it blocks.",
      "Saying the work is done in the reply does not complete it. Omit owner. It must be the owner who claimed the task.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task_id: ID_PARAM,
        owner: {
          type: "string",
          description: "Must match the owner set by claim_task. Omit this. The parent is main, and a subagent is its own id.",
        },
      },
      required: ["task_id"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    return withStore(ctx, async (store) => {
      const owner = ownerArg(args.owner, ctx);
      if (!owner.ok) return finish(ctx, owner.error, true);
      const done = await store.complete(idArg(args.task_id), owner.owner);
      if (!done.ok) return finish(ctx, done.error, true);
      const released =
        done.value.unblocked.length > 0
          ? ` Unblocked: ${done.value.unblocked.map((task) => `#${task.id} ${task.subject}`).join(", ")}`
          : "";
      return finish(ctx, `Completed #${done.value.task.id} (${done.value.task.subject}).${released}`);
    });
  },
};

export const taskTools: Tool[] = [
  taskCreateTool,
  taskListTool,
  taskGetTool,
  taskUpdateTool,
  taskDeleteTool,
  claimTaskTool,
  completeTaskTool,
];
