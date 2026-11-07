import { newId, nowIso } from "../ids.js";
import type { AgentConfig, Message, ToolCall, TraceEvent } from "../types.js";

/** Parent turn hears these. They use the parent turn id so the transcript gate keeps them. */
export type SubagentToolEvent =
  | { type: "tool_call"; tool_call: ToolCall }
  | { type: "tool_result"; tool_call_id: string; content: string; is_error: boolean };
import { assembleContext } from "../context/assemble.js";
import { projectAuditMessages, toolsFingerprint } from "../context/auditContext.js";
import { prepareOutbound } from "../context/images.js";
import type { LlmProvider } from "../provider/types.js";
import { extractSkillTokens } from "../skills/tokens.js";
import { listInstalledSkills, readInstalledSkillFile } from "../skills/installedSkills.js";
import type { SkillBodyAttachment } from "../skills/prompt.js";
import {
  capSubagentResult,
  exploreSystemPrompt,
  subagentToolRounds,
  toolRoundsNote,
  workerSystemPrompt,
  type SubagentType,
} from "../tools/agentTool.js";
import { ToolHost } from "../tools/host.js";
import type { ToolResult } from "../tools/types.js";
import { SubagentStore, subagentDir, type SubagentMeta } from "../store/subagentStore.js";

const CANCELLED = "Cancelled: subagent stopped.";

/**
 * One subagent run. Its transcript lives under the parent session and is not
 * appended to the parent messages. The return value is the only text the parent sees.
 */
export async function runIsolatedSubagent(opts: {
  workspacePath: string;
  sessionId: string;
  parentTurnId: string;
  parentToolCallId: string;
  config: AgentConfig;
  provider: LlmProvider;
  skillsRoot: string;
  tools: ToolHost;
  signal: AbortSignal;
  subagentType: SubagentType;
  task: string;
  description: string;
  outputDir?: string;
  /** Live tool rows for the parent transcript. Omit in tests that only check the receipt. */
  onTool?: (event: SubagentToolEvent) => void;
}): Promise<ToolResult> {
  const agentId = newId("agent");
  const turnId = newId("turn");
  const dir = subagentDir(opts.workspacePath, opts.sessionId, agentId);
  const now = nowIso();
  const meta: SubagentMeta = {
    agent_id: agentId,
    session_id: opts.sessionId,
    turn_id: turnId,
    parent_turn_id: opts.parentTurnId,
    parent_tool_call_id: opts.parentToolCallId,
    subagent_type: opts.subagentType,
    description: opts.description,
    ...(opts.outputDir ? { output_dir: opts.outputDir } : {}),
    status: "running",
    created_at: now,
    updated_at: now,
  };
  const store = await SubagentStore.create(dir, meta);
  const toolRounds = subagentToolRounds(opts.subagentType, opts.config.maxSteps);
  const systemPrompt =
    opts.subagentType === "worker"
      ? workerSystemPrompt(opts.workspacePath, opts.outputDir ?? "", toolRounds)
      : exploreSystemPrompt(opts.workspacePath, toolRounds);
  const installed = (await listInstalledSkills(opts.skillsRoot)).filter((skill) => skill.enabled);
  const skillBodies = await bodiesForTask(opts.task, opts.skillsRoot, opts.config.maxReadChars);
  const attached = new Set(skillBodies.map((skill) => skill.name));
  const messages: Message[] = [
    {
      id: newId("msg"),
      session_id: opts.sessionId,
      turn_id: turnId,
      role: "user",
      content: opts.task,
      created_at: nowIso(),
    },
  ];
  await store.appendMessage(messages[0]!);
  await trace(store, opts.sessionId, turnId, "turn_start", {
    parent_tool_call_id: opts.parentToolCallId,
    subagent_type: opts.subagentType,
  });
  const files: string[] = [];
  let steps = 0;
  let finalText = "";
  let failed = false;

  const finish = async (status: SubagentMeta["status"], result: ToolResult): Promise<ToolResult> => {
    await store.updateMeta({ status });
    return result;
  };

  try {
    while (true) {
      if (opts.signal.aborted) {
        return finish("cancelled", {
          content: capSubagentResult(CANCELLED, files),
          is_error: true,
        });
      }

      const ctx = assembleContext({
        systemPrompt,
        toolDefinitions: opts.tools.listDefinitions(),
        history: messages.slice(0, -1),
        currentUser: messages[messages.length - 1]!,
        contextCharLimit: opts.config.contextCharLimit,
        installedSkills: installed,
        skillBodies,
      });
      const prepared = await prepareOutbound(ctx.messages, async () => null);
      const fingerprint = toolsFingerprint(opts.tools.listDefinitions());
      const requestId = newId("trace");
      await trace(store, opts.sessionId, turnId, "llm_request", {
        model: opts.config.model,
        context_id: requestId,
      });
      await store.appendContext(fingerprint.sha256, fingerprint.tools, {
        type: "request",
        id: requestId,
        turn_id: turnId,
        model: opts.config.model,
        messages: projectAuditMessages(prepared.messages, prepared.sentImages),
      });

      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      let llmError: string | undefined;
      try {
        for await (const chunk of opts.provider.chatStream({
          messages: prepared.messages,
          tools: opts.tools.listDefinitions(),
          model: opts.config.model,
          signal: opts.signal,
        })) {
          if (opts.signal.aborted) break;
          if (chunk.type === "text" && chunk.text) assistantText += chunk.text;
          else if (chunk.type === "tool_call_delta" && chunk.tool_call) toolCalls.push(chunk.tool_call);
          else if (chunk.type === "error") llmError = chunk.error ?? "llm error";
        }
      } catch (err) {
        if (!opts.signal.aborted) llmError = String(err);
      }

      if (opts.signal.aborted) {
        return finish("cancelled", {
          content: capSubagentResult(CANCELLED, files),
          is_error: true,
        });
      }
      if (llmError) {
        failed = true;
        finalText = `Subagent model error: ${llmError}`;
        break;
      }

      const assistant: Message = {
        id: newId("msg"),
        session_id: opts.sessionId,
        turn_id: turnId,
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        created_at: nowIso(),
      };
      messages.push(assistant);
      await store.appendMessage(assistant);
      await trace(store, opts.sessionId, turnId, "llm_response", {
        content_chars: assistantText.length,
        tool_calls: toolCalls.map((call) => call.function.name),
      });

      if (toolCalls.length === 0) {
        finalText = assistantText;
        break;
      }

      if (steps >= toolRounds) {
        const notice = `Reached max tool steps (${toolRounds}). Stopped.`;
        for (const tc of toolCalls) {
          opts.onTool?.({ type: "tool_call", tool_call: tc });
          opts.onTool?.({
            type: "tool_result",
            tool_call_id: tc.id,
            content: `Skipped: reached max tool steps (${toolRounds}).`,
            is_error: true,
          });
          const toolMsg: Message = {
            id: newId("msg"),
            session_id: opts.sessionId,
            turn_id: turnId,
            role: "tool",
            name: tc.function.name,
            tool_call_id: tc.id,
            tool_call_arguments: tc.function.arguments,
            content: `Skipped: reached max tool steps (${toolRounds}).`,
            is_error: true,
            created_at: nowIso(),
          };
          messages.push(toolMsg);
          await store.appendMessage(toolMsg);
        }
        finalText = assistantText.trim() ? `${assistantText.trim()}\n\n${notice}` : notice;
        break;
      }

      steps += 1;
      for (const tc of toolCalls) {
        if (opts.signal.aborted) {
          return finish("cancelled", {
            content: capSubagentResult(CANCELLED, files),
            is_error: true,
          });
        }
        opts.onTool?.({ type: "tool_call", tool_call: tc });
        const executed = await opts.tools.execute(tc.function.name, tc.function.arguments, {
          workspacePath: opts.workspacePath,
          signal: opts.signal,
          bashTimeoutMs: opts.config.bashTimeoutMs,
          maxToolOutputChars: opts.config.maxToolOutputChars,
          maxReadChars: opts.config.maxReadChars,
          maxSearchResults: opts.config.maxSearchResults,
          apiKey: opts.config.apiKey,
          llmBaseUrl: opts.config.baseUrl,
          skillsRoot: opts.skillsRoot,
          attachedSkillNames: attached,
          ...(opts.outputDir ? { writeRoot: opts.outputDir } : {}),
        });
        const result = {
          content: `${toolRoundsNote(steps, toolRounds)}\n\n${executed.content}`,
          is_error: executed.is_error,
        };
        opts.onTool?.({
          type: "tool_result",
          tool_call_id: tc.id,
          content: result.content,
          is_error: result.is_error,
        });
        if (!result.is_error) noteFile(files, tc);
        const toolMsg: Message = {
          id: newId("msg"),
          session_id: opts.sessionId,
          turn_id: turnId,
          role: "tool",
          name: tc.function.name,
          tool_call_id: tc.id,
          tool_call_arguments: tc.function.arguments,
          content: result.content,
          is_error: result.is_error,
          created_at: nowIso(),
        };
        messages.push(toolMsg);
        await store.appendMessage(toolMsg);
        await trace(store, opts.sessionId, turnId, "tool_result", {
          tool: tc.function.name,
          is_error: result.is_error,
        });
      }
    }
  } catch (err) {
    failed = true;
    finalText = `Subagent failed: ${String(err)}`;
  }

  return finish(failed ? "error" : "completed", {
    content: capSubagentResult(finalText, files),
    is_error: failed,
  });
}

async function trace(
  store: SubagentStore,
  sessionId: string,
  turnId: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const event: TraceEvent = {
    id: newId("trace"),
    session_id: sessionId,
    turn_id: turnId,
    type,
    timestamp: nowIso(),
    detail,
  };
  await store.appendTrace(event);
}

function noteFile(files: string[], tc: ToolCall): void {
  if (tc.function.name !== "write_file" && tc.function.name !== "str_replace" && tc.function.name !== "delete_file") {
    return;
  }
  try {
    const args = JSON.parse(tc.function.arguments) as { path?: unknown };
    if (typeof args.path === "string" && args.path.trim() && !files.includes(args.path)) {
      files.push(args.path);
    }
  } catch {
    /* the tool result still stands */
  }
}

async function bodiesForTask(
  task: string,
  skillsRoot: string,
  maxReadChars: number,
): Promise<SkillBodyAttachment[]> {
  const bodies: SkillBodyAttachment[] = [];
  for (const name of extractSkillTokens(task)) {
    const result = await readInstalledSkillFile(name, undefined, maxReadChars, skillsRoot);
    if (result.is_error || !result.directory) continue;
    bodies.push({ name, directory: result.directory, body: result.content });
  }
  return bodies;
}
