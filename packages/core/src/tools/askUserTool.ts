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
      "Ask the user one question and wait. Use this when a decision, preference, or missing fact blocks the current task. The answer comes back as this tool's result in the same turn. It is not a new user message: use it and continue, and do not reply to it as if they had asked you something. Do not only print the question. Do not call other tools in the same response. options, if any, are a few complete answers in the user's voice (their decision or fact). Never put your own instruction, suggestion, or request in an option, such as '告诉我…' or '我去改…'. The chosen string is returned unchanged. Leave options empty when they must type an open fact you do not already know, such as a path or a name.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "One clear question for the user. This is your question, not one of the answers." },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Each item is a complete answer the user might choose, written as their intent. Not your suggestion and not a prompt for them to send you. Omit when the answer is an open fact.",
        },
      },
      required: ["question"],
    },
  },
  async execute(): Promise<ToolResult> {
    throw new Error(ASK_USER_NOT_LOCAL);
  },
};
