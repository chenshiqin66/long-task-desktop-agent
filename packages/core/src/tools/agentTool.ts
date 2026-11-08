import type { Tool } from "./types.js";
import { cleanTaskId } from "../store/taskStore.js";
import { normalizeOutputDir } from "./writeScope.js";

export const AGENT_TOOL_NAME = "subagent";

/** ToolHost must throw this. The runtime runs the subagent, then stores one receipt. */
export const AGENT_NOT_LOCAL =
  "subagent is not a local command. The runtime must run the subagent and return its receipt.";

export const SUBAGENT_RESULT_MAX = 6_000;

/** File tools a subagent may receive. Shell, ask_user, subagent, and skill scripts stay out. */
export const SUBAGENT_TOOL_CEILING = [
  "list_dir",
  "read_file",
  "keyword_search",
  "web_search",
  "read_skill",
  "write_file",
  "str_replace",
  "delete_file",
] as const;

const WRITE_TOOLS = new Set<string>(["write_file", "str_replace", "delete_file"]);

/** Shared board. Creating, editing, and deleting tasks stay with the parent. */
export const SUBAGENT_TASK_TOOLS = ["task_list", "task_get", "claim_task", "complete_task"] as const;

export type SubagentType = "explore" | "worker";

/** Explore only searches and reports. Eight rounds is enough when the task names the files. */
export const EXPLORE_TOOL_ROUNDS = 8;
/** Worker reads the named sources and writes the deliverable. Higher than explore, still far under the parent cap. */
export const WORKER_TOOL_ROUNDS = 16;

/** A lowered parent maxSteps still binds. A raised one does not give a subagent a longer budget. */
export function subagentToolRounds(type: SubagentType, parentMaxSteps: number): number {
  const own = type === "worker" ? WORKER_TOOL_ROUNDS : EXPLORE_TOOL_ROUNDS;
  if (!Number.isFinite(parentMaxSteps)) return own;
  return Math.min(Math.max(0, Math.floor(parentMaxSteps)), own);
}

/** Prefix on each subagent tool result. Kept at the front so context trimming does not drop it. */
export function toolRoundsNote(used: number, cap: number): string {
  const left = Math.max(0, cap - used);
  if (left === 0) {
    return `Tool rounds left: 0 of ${cap}. Do not call tools again. Reply with the result.`;
  }
  return `Tool rounds left: ${left} of ${cap}. Put the remaining reads and searches in one response.`;
}

export function toolsForSubagent(type: SubagentType): readonly string[] {
  const files =
    type === "explore" ? SUBAGENT_TOOL_CEILING.filter((name) => !WRITE_TOOLS.has(name)) : SUBAGENT_TOOL_CEILING;
  return [...files, ...SUBAGENT_TASK_TOOLS];
}

export interface AgentCall {
  description: string;
  subagent_type: SubagentType;
  task: string;
  output_dir?: string;
  /** When set, the runtime claims this task as the subagent before the run. */
  task_id?: string;
}

const DESCRIPTION_MAX = 200;
const TASK_MAX = 20_000;

export function parseAgentCall(
  argsJson: string,
): { ok: true; call: AgentCall } | { ok: false; error: string } {
  let args: {
    description?: unknown;
    subagent_type?: unknown;
    task?: unknown;
    output_dir?: unknown;
    task_id?: unknown;
  };
  try {
    args = argsJson ? (JSON.parse(argsJson) as typeof args) : {};
  } catch (err) {
    return { ok: false, error: `Invalid JSON arguments: ${String(err)}` };
  }
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!description) return { ok: false, error: "subagent requires description" };
  const subagent_type = args.subagent_type;
  if (subagent_type !== "explore" && subagent_type !== "worker") {
    return { ok: false, error: "subagent_type must be explore or worker" };
  }
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return { ok: false, error: "subagent requires task" };
  if (task.length > TASK_MAX) {
    return { ok: false, error: `task is too long (${task.length} chars; max ${TASK_MAX})` };
  }
  const taskId = optionalTaskId(args.task_id);
  if (!taskId.ok) return taskId;
  const outputRaw = typeof args.output_dir === "string" ? args.output_dir.trim() : "";
  if (subagent_type === "explore") {
    if (outputRaw) return { ok: false, error: "explore is read-only and does not take output_dir" };
    return {
      ok: true,
      call: {
        description: description.slice(0, DESCRIPTION_MAX),
        subagent_type,
        task,
        ...(taskId.task_id ? { task_id: taskId.task_id } : {}),
      },
    };
  }
  const output = normalizeOutputDir(outputRaw);
  if (!output.ok) return output;
  return {
    ok: true,
    call: {
      description: description.slice(0, DESCRIPTION_MAX),
      subagent_type,
      task,
      output_dir: output.dir,
      ...(taskId.task_id ? { task_id: taskId.task_id } : {}),
    },
  };
}

function optionalTaskId(raw: unknown): { ok: true; task_id?: string } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true };
  const task_id = cleanTaskId(raw);
  if (!task_id) return { ok: false, error: "task_id must be a task id such as 1" };
  return { ok: true, task_id };
}

const RESULT_MARK = "\n…[truncated]";

export function capSubagentResult(summary: string, files: readonly string[]): string {
  const filesBlock = files.length ? `\n\nFiles:\n${files.map((file) => `- ${file}`).join("\n")}` : "";
  const body = summary.trim() || "(no summary)";
  const combined = `${body}${filesBlock}`;
  if (combined.length <= SUBAGENT_RESULT_MAX) return combined;
  const room = SUBAGENT_RESULT_MAX - filesBlock.length;
  if (room <= RESULT_MARK.length) {
    return combined.slice(0, SUBAGENT_RESULT_MAX - RESULT_MARK.length) + RESULT_MARK;
  }
  return body.slice(0, room - RESULT_MARK.length) + RESULT_MARK + filesBlock;
}

export function exploreSystemPrompt(workspacePath: string, toolRounds: number): string {
  return `You are an explore subagent. You only search and read. You do not write files, run a shell, or ask the user.
The workspace is:
${workspacePath}

You have ${toolRounds} tool rounds. One response that calls tools is one round, whether it contains one call or several.
The parent agent cannot see your tool results. Your last message is the only text it receives, and that message is length-capped.
Use the paths and the question in the task. Do not search the whole workspace when the task names a file or directory.
Call keyword_search once for a path: set path, and put every term in queries.
If the task omits the file, the question, or what finished looks like, say what is missing and stop. Do not guess.
In the final message, name paths, line numbers, and the facts the parent needs. Do not paste whole files.
When the task is done, or no rounds remain, stop calling tools.
You share this session's task list. You may call task_list, task_get, claim_task, and complete_task. Omit owner. You cannot create, edit, or delete tasks, and you cannot message another subagent. A task assigned to you is already claimed as you. Call complete_task for it when the work is finished.`;
}

export function workerSystemPrompt(workspacePath: string, outputDir: string, toolRounds: number): string {
  return `You are a worker subagent. You write a deliverable inside one directory and then stop.
The workspace is:
${workspacePath}

You may create and edit files only under this workspace-relative directory:
${outputDir}

You have ${toolRounds} tool rounds. One response that calls tools is one round.
Use write_file and str_replace for those files. Do not use a shell. Do not ask the user. Do not write anywhere else.
Read only the paths the task names. Call keyword_search with path and every term in one call.
If the task tells you to fix or extend something without the fault, the behavior to produce, and how the parent will check it, do not invent a broader change. Say what was missing.
The parent agent cannot see your tool results. Your last message is a short receipt: the paths you wrote, roughly how long each file is, the section titles, and anything you did not finish.
Do not paste the document body into that receipt.
When the files are written, or no rounds remain, stop calling tools.
You share this session's task list. You may call task_list, task_get, claim_task, and complete_task. Omit owner. You cannot create, edit, or delete tasks, and you cannot message another subagent. A task assigned to you is already claimed as you. Call complete_task for it when the work is finished.`;
}

export const agentTool: Tool = {
  definition: {
    name: AGENT_TOOL_NAME,
    description: [
      "Delegate a self-contained subtask to a subagent. The subagent has its own context.",
      "This conversation receives only a short receipt. Intermediate reads, searches, and file bodies stay out.",
      `explore: read-only, ${EXPLORE_TOOL_ROUNDS} tool rounds. Use it when the next step would search or read many files whose raw text you do not need afterward. For one known file, call read_file yourself.`,
      `worker: writes files, and only inside output_dir, ${WORKER_TOOL_ROUNDS} tool rounds. Use it when the deliverable is a new document or a set of files in one directory. output_dir is a workspace-relative directory such as docs/notes. For a one-line edit of a file you have already read, call str_replace yourself.`,
      "The subagent does not see this conversation and must not guess. The task must say why the work exists, what to do and what not to do, what finished looks like, and the paths, names, constraints, and rejected approaches.",
      "Do not delegate understanding. Name the fault, the change you want, and how you will check it. You run any verification command yourself after the receipt.",
      "You may call subagent more than once in the same response. Those subagents run at the same time. Their output_dir values must not overlap or contain one another.",
      "Do not use subagent to ask the user a question. Do not use it to run a shell command. Do not put a tool allowlist in the task: explore and worker already fix the tools.",
      "Subagents can list, get, claim, and complete tasks on this session's list. They cannot create, update, or delete tasks, and they cannot message each other.",
      "To assign a listed task, pass task_id. The runtime claims it as that subagent before the run. Do not claim it yourself first. If it is blocked or already claimed, the subagent does not start.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "3 to 8 word label for this delegation, shown in the transcript",
        },
        subagent_type: {
          type: "string",
          enum: ["explore", "worker"],
          description: "explore reads only. worker writes only inside output_dir.",
        },
        task: {
          type: "string",
          description:
            "Standalone instructions. The subagent does not see this conversation. Include why this task exists, what to do and what not to do, what finished looks like (paths and line numbers, or the files to write), and paths, names, constraints, and rejected approaches. Do not write 'from what you find, fix it'.",
        },
        output_dir: {
          type: "string",
          description:
            "Required for worker. Workspace-relative directory it may create and edit. Omit for explore.",
        },
        task_id: {
          type: "string",
          description:
            "Optional id of a listed task to assign. The runtime claims it as this subagent. Do not claim it yourself. Omit when the work is not on the list.",
        },
      },
      required: ["description", "subagent_type", "task"],
    },
  },
  async execute() {
    throw new Error(AGENT_NOT_LOCAL);
  },
};
