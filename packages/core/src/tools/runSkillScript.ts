import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { resolveInstalledSkillPath } from "../skills/installedSkills.js";
import { forceKillChild, truncateOutput } from "./bash.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const RUN_SKILL_SCRIPT_TOOL_NAME = "run_skill_script";

const MAX_ARGS = 32;
const MAX_ARG_CHARS = 2_000;

const INTERPRETERS: Record<string, string> = {
  ".py": "python",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
};

export const runSkillScriptTool: Tool = {
  definition: {
    name: RUN_SKILL_SCRIPT_TOOL_NAME,
    description:
      "Run one installed skill script. Pass the skill name, a path relative to that skill directory, and an args array of strings. The host runs python or node on that file with the workspace as the working directory. Do not pass a shell command. Do not use powershell or bash to read or run skill files.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed skill name" },
        path: { type: "string", description: "Script path relative to the skill directory, such as scripts/fetch.py" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed as separate argv entries, not a command line",
        },
      },
      required: ["name", "path"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    const relative = String(args.path ?? "").trim();
    const parsed = parseArgs(args.args);
    if ("error" in parsed) return { content: parsed.error, is_error: true };
    const resolved = await resolveInstalledSkillPath(name, relative, ctx.skillsRoot);
    if ("error" in resolved) return { content: resolved.error, is_error: true };
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved.path);
    } catch (err) {
      return { content: String(err), is_error: true };
    }
    if (!info.isFile()) return { content: `不是文件：${relative}`, is_error: true };
    const interpreter = INTERPRETERS[extname(relative).toLowerCase()];
    if (!interpreter) {
      return {
        content: `run_skill_script 只运行 .py、.js、.mjs、.cjs。${relative} 不在其中。`,
        is_error: true,
      };
    }
    return runInterpreter(interpreter, resolved.path, parsed.args, ctx);
  },
};

function parseArgs(raw: unknown): { args: string[] } | { error: string } {
  if (raw == null) return { args: [] };
  if (typeof raw === "string") return { error: "args 必须是字符串数组，不能是一整句命令" };
  if (!Array.isArray(raw)) return { error: "args 必须是字符串数组" };
  if (raw.length > MAX_ARGS) return { error: `参数过多（${raw.length}，最多 ${MAX_ARGS}）` };
  const args: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "args 的每一项都必须是字符串" };
    if (item.length > MAX_ARG_CHARS) return { error: `单个参数超过 ${MAX_ARG_CHARS} 字符` };
    if (item.includes("\0")) return { error: "参数不能包含空字符" };
    args.push(item);
  }
  return { args };
}

function runInterpreter(
  interpreter: string,
  scriptPath: string,
  args: string[],
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.signal?.aborted) return Promise.resolve({ content: "Command cancelled", is_error: true });
  return new Promise((resolve) => {
    const child = spawn(interpreter, [scriptPath, ...args], {
      cwd: ctx.workspacePath,
      env: process.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let capped = false;
    const budget = Math.max(0, ctx.maxToolOutputChars);

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve({
        content: truncateOutput(result.content, ctx.maxToolOutputChars),
        is_error: result.is_error,
      });
    };
    const killForCap = () => {
      if (capped) return;
      capped = true;
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      forceKillChild(child);
    };
    const appendChunk = (which: "out" | "err", chunk: string) => {
      if (settled || capped) return;
      const used = stdout.length + stderr.length;
      if (used >= budget) {
        killForCap();
        return;
      }
      const room = budget - used;
      const take = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (which === "out") stdout += take;
      else stderr += take;
      if (stdout.length + stderr.length >= budget) killForCap();
    };
    const timer = setTimeout(() => {
      forceKillChild(child);
      finish({ content: `Command timeout after ${ctx.bashTimeoutMs}ms`, is_error: true });
    }, ctx.bashTimeoutMs);
    const onAbort = () => {
      forceKillChild(child);
      finish({ content: "Command cancelled", is_error: true });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => appendChunk("out", String(d)));
    child.stderr.on("data", (d) => appendChunk("err", String(d)));
    child.on("error", (err) => finish({ content: String(err), is_error: true }));
    child.on("close", (code) => {
      const content = [stdout, stderr].filter(Boolean).join("\n");
      finish({
        content: content || `(exit ${code ?? "?"})`,
        is_error: capped ? false : code !== 0,
      });
    });
  });
}
