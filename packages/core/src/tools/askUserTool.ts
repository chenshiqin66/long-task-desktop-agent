import type { Tool, ToolResult } from "./types.js";

export const ASK_USER_TOOL_NAME = "ask_user";

/** ToolHost must throw this instead of storing a fake tool result. */
export const ASK_USER_NOT_LOCAL =
  "ask_user is not a local command. The runtime must suspend the turn until the user answers.";

const QUESTION_MAX = 2_000;
const OPTION_MAX = 200;
const OPTIONS_MAX = 6;

export interface AskUserCall {
  question: string;
  options: string[];
}

export function parseAskUserArgs(
  raw: unknown,
): { ok: true; call: AskUserCall } | { ok: false; error: string } {
  let args: { question?: unknown; options?: unknown };
  if (typeof raw === "string") {
    try {
      args = raw ? (JSON.parse(raw) as { question?: unknown; options?: unknown }) : {};
    } catch (err) {
      return { ok: false, error: `Invalid JSON arguments: ${String(err)}` };
    }
  } else if (raw && typeof raw === "object") {
    args = raw as { question?: unknown; options?: unknown };
  } else {
    args = {};
  }

  const question = String(args.question ?? "").trim();
  if (!question) return { ok: false, error: "ask_user requires a question" };
  const options = Array.isArray(args.options)
    ? args.options
        .map((item) => String(item ?? "").trim().slice(0, OPTION_MAX))
        .filter(Boolean)
        .slice(0, OPTIONS_MAX)
    : [];
  return {
    ok: true,
    call: { question: question.slice(0, QUESTION_MAX), options },
  };
}

export const askUserTool: Tool = {
  definition: {
    name: ASK_USER_TOOL_NAME,
    description:
      "Ask the user one question and wait for their answer before doing anything else. Use this when a decision, preference, or missing fact blocks the current task. The answer comes back as this tool's result in the same turn. Do not only print the question. Put at most a few short choices in options; the user can still type their own answer. Do not call other tools in the same response.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "One clear question for the user." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional short choices. The user may pick one or type something else.",
        },
      },
      required: ["question"],
    },
  },
  async execute(): Promise<ToolResult> {
    throw new Error(ASK_USER_NOT_LOCAL);
  },
};
