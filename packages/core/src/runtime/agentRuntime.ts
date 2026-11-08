import { newId, nowIso } from "../ids.js";
import type {
  AgentConfig,
  ImageMime,
  Message,
  RuntimeEvent,
  SessionMeta,
  SubmittedImage,
  ToolCall,
  TraceEvent,
} from "../types.js";
import { MAX_IMAGES_PER_MESSAGE, SessionStore } from "../store/sessionStore.js";
import { ContextStore } from "../store/contextStore.js";
import { TraceStore } from "../store/traceStore.js";
import { TaskStore } from "../store/taskStore.js";
import { shouldRemindTasks, taskReminderText } from "../context/taskReminder.js";
import { ToolHost } from "../tools/host.js";
import { classifyToolCall } from "../tools/policy.js";
import {
  AGENT_TOOL_NAME,
  EXPLORE_TOOL_ROUNDS,
  parseAgentCall,
  toolsForSubagent,
  WORKER_TOOL_ROUNDS,
  type AgentCall,
} from "../tools/agentTool.js";
import { outputDirsOverlap } from "../tools/writeScope.js";
import type { ToolResult } from "../tools/types.js";
import { assembleContext } from "../context/assemble.js";
import { projectAuditMessages, toolsFingerprint } from "../context/auditContext.js";
import { countOutboundImages, outboundTextChars, prepareOutbound } from "../context/images.js";
import { countUserTurns } from "../context/compress.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL,
  canAppendToolRepair,
  findMissingToolResults,
} from "../context/repairToolCalls.js";
import {
  generateSessionTitle,
  isDefaultSessionTitle,
} from "../session/autoTitle.js";
import type { LlmProvider } from "../provider/types.js";
import { AgentError } from "./errors.js";
import { extractSkillTokens } from "../skills/tokens.js";
import {
  defaultSkillsRoot,
  listInstalledSkills,
  readInstalledSkillFile,
} from "../skills/installedSkills.js";
import type { SkillBodyAttachment } from "../skills/prompt.js";
import { AutoAllowGate, type PermissionGate } from "./permission.js";
import { ClosedAskGate, type AskGate } from "./askGate.js";
import { ASK_USER_TOOL_NAME, parseAskUserArgs } from "../tools/askUserTool.js";
import { runIsolatedSubagent } from "./subagentRun.js";

/** Auto-name after this many user turns (completed). */
const AUTO_TITLE_AFTER_USER_TURNS = 3;

export type EventListener = (event: RuntimeEvent) => void;

const IMAGE_RULES = `
Images:
- A user message may include images. Inspect them and use what you see. When image parts are present, do not say you cannot see images.
- An older user message may end with "像素未再次发送". The pixels are gone. Do not invent visual details from that note. If the task still needs the picture, ask the user to attach it again.`;

const ASK_USER_RULES = `
Asking the user:
- If you need a decision, preference, or missing fact before continuing, call ask_user. The same turn stays open. The answer arrives as that tool's result. Then continue the task.
- Do not collect that answer by only printing a question. A reply with no tool calls ends the turn, and the next user message starts a new turn.
- Ask one question per call. Use options only for a few short choices. The user can type a different answer.
- Do not put other tool calls in the same response as ask_user. Those later calls are skipped.`;

const SUBAGENT_RULES = `
Subagents:
- Call subagent when the next step would dump search or file text you do not need later, or when the deliverable is new files in one directory.
- For a single known file, call read_file yourself. For a one-line edit of a file you have already read, call str_replace yourself.
- The subagent does not see this conversation. Write the task so it can act without guessing your intent.
- Say why the task exists and where it sits in the work, so an edge case can be judged instead of followed mechanically.
- State what to do and what not to do. explore is read-only investigation and has ${EXPLORE_TOOL_ROUNDS} tool rounds. worker may create and edit files only inside the output_dir you pass, and has ${WORKER_TOOL_ROUNDS} tool rounds. One response full of tool calls is one round. Pick the type that matches the boundary. Do not tell a worker to stay read-only, and do not tell explore to edit.
- Define what finished looks like: a report with file paths and line numbers, or files at named paths with named sections. "Look around" and "understand this" are not done conditions.
- Give anchors the subagent cannot already know: paths, symbol names, constraints, and approaches already rejected. Do not leave it to rediscover them.
- You do not pick individual tools. explore may list, read, and search. worker may also write inside output_dir. Both may list, get, claim, and complete tasks on this session's list. Neither can run a shell, ask the user, call subagent, or create, update, or delete tasks. They cannot message each other. Choosing the type is the tool limit. A tool allowlist written into the task is not enforced.
- Do not delegate understanding. "From what you find, fix the bug" asks the subagent to decide the diagnosis. You do that first. Name the fault, the behavior you want, and how you will check it. Run any verification command yourself after the receipt comes back. The subagent cannot run a shell.
- Several subagent calls in one response run at the same time. Their output directories must not overlap.
- Do not use subagent to ask the user a question or to run a shell command.
- To assign a listed task, pass task_id. The runtime claims it as that subagent. Do not claim it yourself first. A blocked or already claimed task does not start. If the subagent stops before complete_task, that claim returns to pending.`;

const TASK_RULES = `
Task list:
- When the work has several steps and a later step depends on an earlier one, call task_create for each step before you start. A single edit or a question does not need a task.
- subject is a short imperative. description says what done looks like and what not to do. blocked_by lists the task ids that must be completed first. A new task is pending.
- When you start a pending task, call claim_task. When that work is finished, call complete_task. Saying it is done in your reply does not complete it.
- claim_task fails while a blocker is still open. complete_task fails unless the task is in_progress and you are its owner.
- Use task_list to see what is open. A pending task marked blocked is not claimable yet. task_update changes words and dependencies, not status.
- task_create does not run the step and does not start a subagent. The list belongs to this session. A subagent can claim and complete on it, and cannot create, update, or delete tasks.`;

const SEARCH_RULES = `
Search:
- keyword_search takes a path and every term in one call. Pass the narrowest file or directory. Do not call it again for another word in that same path.`;

const WEB_SEARCH_RULES = `
Web search citations (mandatory when web_search was used in this turn):
- Treat each tool result block "[n] title" / "URL: ..." as source n.
- Any factual claim taken from search MUST have an inline citation like [1] or [2][3] right after the claim.
- End the reply with a "来源" section listing every cited n as a markdown link: [n] [title](url) — title is the link text; do not print the bare URL after an em dash.
- Do not invent titles or URLs. Do not cite sources you did not use. If search returned nothing useful, say so and omit the 来源 section.
- Workspace-only answers (no web_search) do not need a 来源 section.`;

/** System prompt matches the shell that actually runs. On Windows that is powershell.exe, not WSL bash. */
export function buildDefaultSystemPrompt(workspacePath: string): string {
  if (process.platform === "win32") {
    return `You are a coding agent on Windows. The workspace is this Windows directory:
${workspacePath}

Use tools when needed. Prefer concise, correct changes. When you tell the user a path, use a Windows path.

Shell:
- The shell tool is powershell. It starts powershell.exe in the workspace above.
- Use Windows PowerShell 5.1 syntax and Windows paths. PowerShell 5.1 has no && or ||.
- Do not launch bash.exe, wsl.exe, or Git Bash. Do not use /mnt, /usr, apt, fc-list, or python3 unless the user explicitly asked for WSL.
- Windows programs are started by name or by their Windows path.

File edits:
- Create or overwrite files with write_file.
- Make surgical edits with str_replace.
- Never write file contents via powershell (no here-strings, Set-Content, Add-Content, Out-File, or redirection).
- Use list_dir / read_file / keyword_search to inspect; powershell for builds, tests, git, and other commands.
${SEARCH_RULES}
${ASK_USER_RULES}
${IMAGE_RULES}
${SUBAGENT_RULES}
${TASK_RULES}
${WEB_SEARCH_RULES}`;
  }

  return `You are a coding agent working inside a local repository workspace.
The workspace path is ${workspacePath}.
Use tools when needed. Prefer concise, correct changes.

File edits:
- Create or overwrite files with write_file.
- Make surgical edits with str_replace.
- Never write file contents via bash (no heredoc, cat/echo/printf redirects, tee).
- Use list_dir / read_file / keyword_search to inspect; bash for builds, tests, git, and other commands.
${SEARCH_RULES}
${ASK_USER_RULES}
${IMAGE_RULES}
${SUBAGENT_RULES}
${TASK_RULES}
${WEB_SEARCH_RULES}`;
}

const CANCELLED_TOOL_CONTENT = "Cancelled: tool was not executed.";
/** Shown when the user stops a turn before any assistant text exists. */
const CANCELLED_TURN_NOTICE = "任务已终止";
const DENIED_TOOL_CONTENT = "Cancelled: user denied permission";
const BLOCKED_TOOL_CONTENT = "Blocked dangerous command";
const ASK_SKIPPED_CONTENT =
  "Skipped: not run because ask_user was waiting for the user. Use their answer before calling tools again.";
const ASK_UNAVAILABLE_CONTENT = "ask_user is not connected to a user.";
const ASK_EMPTY_CONTENT = "Empty answer.";
const ANSWER_MAX = 8_000;

/** Sessions written before the tool rename still show the model the name `agent`. */
function renameLegacySubagentCall(call: ToolCall): ToolCall {
  if (call.function.name !== "agent") return call;
  return { ...call, function: { ...call.function, name: AGENT_TOOL_NAME } };
}

export class AgentRuntime {
  private readonly store: SessionStore;
  private readonly traces: TraceStore;
  private readonly contexts: ContextStore;
  private readonly tools: ToolHost;
  private readonly provider: LlmProvider;
  private readonly config: AgentConfig;
  private readonly systemPrompt: string;
  private readonly workspacePath: string;
  private readonly permissions: PermissionGate;
  private readonly asks: AskGate;
  private listeners = new Set<EventListener>();
  /** Assistant replies already stored when this session was last shown its open tasks. */
  private taskReminderAssistants = new Map<string, number>();
  private abort: AbortController | null = null;
  private running = false;
  /** Set when the user allows one write. Covers later writes in this submit, not ask_user or blocked commands. */
  private turnWritesAllowed = false;
  /**
   * output_dir values accepted in the current tool batch. Parent writes into
   * them fail until the next model call, including after the subagent returns,
   * because that write was planned before the receipt existed.
   */
  private batchOutputDirs: string[] = [];
  /** Serializes parent jsonl appends while several subagents finish together. */
  private parentWriteChain: Promise<void> = Promise.resolve();
  private readonly skillsRoot: string;
  /** Bodies pinned for the submit currently running. Cleared when it ends. */
  private skillBodies: SkillBodyAttachment[] = [];

  constructor(opts: {
    workspacePath: string;
    config: AgentConfig;
    provider: LlmProvider;
    systemPrompt?: string;
    store?: SessionStore;
    traces?: TraceStore;
    contexts?: ContextStore;
    tools?: ToolHost;
    permissions?: PermissionGate;
    asks?: AskGate;
    /** Installed-skill root. Tests pass a temporary directory. */
    skillsRoot?: string;
  }) {
    this.workspacePath = opts.workspacePath;
    this.config = opts.config;
    this.provider = opts.provider;
    this.systemPrompt = opts.systemPrompt ?? buildDefaultSystemPrompt(opts.workspacePath);
    this.store = opts.store ?? new SessionStore(opts.workspacePath);
    this.traces = opts.traces ?? new TraceStore(opts.workspacePath);
    this.contexts = opts.contexts ?? new ContextStore(opts.workspacePath);
    this.tools = opts.tools ?? new ToolHost();
    this.permissions = opts.permissions ?? new AutoAllowGate();
    this.asks = opts.asks ?? new ClosedAskGate();
    this.skillsRoot = opts.skillsRoot ?? defaultSkillsRoot();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const l of this.listeners) l(event);
  }

  /** Persist a message; on failure emit error+done and return false. */
  private async persistMessage(turn_id: string, msg: Message): Promise<boolean> {
    try {
      await this.store.appendMessage(msg);
      return true;
    } catch (err) {
      this.emit({
        type: "error",
        turn_id,
        message: String(err),
        code: "storage_write_failed",
      });
      this.emit({ type: "done", turn_id, reason: "error" });
      return false;
    }
  }

  /** Persist a trace event; on failure emit error+done and return false. */
  private async persistTrace(
    turn_id: string,
    event: Parameters<TraceStore["append"]>[0],
  ): Promise<boolean> {
    try {
      await this.traces.append(event);
      return true;
    } catch (err) {
      this.emit({
        type: "error",
        turn_id,
        message: String(err),
        code: "storage_write_failed",
      });
      this.emit({ type: "done", turn_id, reason: "error" });
      return false;
    }
  }

  /** Persist the outbound context; on failure emit error+done and return false. */
  private async persistContext(
    turn_id: string,
    opts: Parameters<ContextStore["appendRequest"]>[0],
  ): Promise<boolean> {
    try {
      await this.contexts.appendRequest(opts);
      return true;
    } catch (err) {
      this.emit({
        type: "error",
        turn_id,
        message: String(err),
        code: "storage_write_failed",
      });
      this.emit({ type: "done", turn_id, reason: "error" });
      return false;
    }
  }

  createSession(title?: string): Promise<SessionMeta> {
    return this.store.createSession(title);
  }

  listSessions(): Promise<SessionMeta[]> {
    return this.store.listSessions();
  }

  loadMessages(sessionId: string): Promise<Message[]> {
    return this.store.readMessages(sessionId);
  }

  /** Session artifacts the UI reads. Each file is already parsed records, not raw text. */
  async loadSessionArtifacts(sessionId: string): Promise<{
    meta: SessionMeta;
    messages: Message[];
    traces: TraceEvent[];
    context: unknown[];
  }> {
    const meta = await this.store.getMeta(sessionId);
    const messages = await this.store.readMessages(sessionId);
    const traces = await this.traces.read(sessionId);
    const context = await this.contexts.read(sessionId);
    return { meta, messages, traces, context };
  }

  renameSession(
    sessionId: string,
    title: string,
    opts?: { source?: "user" | "auto" },
  ): Promise<SessionMeta> {
    return this.store.renameSession(sessionId, title, opts);
  }

  /**
   * After ≥3 user turns, once, if the title is still default — ask the model
   * for a ≤12-char name. Best-effort; never fails the turn.
   */
  private async maybeAutoTitle(sessionId: string): Promise<void> {
    try {
      const meta = await this.store.getMeta(sessionId);
      if (meta.title_source === "user" || meta.title_source === "auto") return;
      if (!isDefaultSessionTitle(meta.title)) return;
      const messages = await this.store.readMessages(sessionId);
      if (countUserTurns(messages) < AUTO_TITLE_AFTER_USER_TURNS) return;
      const title = await generateSessionTitle({
        provider: this.provider,
        model: this.config.model,
        messages,
        signal: this.abort?.signal,
      });
      const updated = await this.store.renameSession(sessionId, title, {
        source: "auto",
      });
      this.emit({
        type: "session_title",
        session_id: sessionId,
        title: updated.title || title,
        source: "auto",
      });
    } catch {
      // ignore — naming must not break the turn
    }
  }

  private async emitDoneAndMaybeTitle(
    sessionId: string,
    turn_id: string,
    reason: "completed" | "max_steps",
  ): Promise<void> {
    this.emit({ type: "done", turn_id, reason });
    await this.maybeAutoTitle(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    this.taskReminderAssistants.delete(sessionId);
    return this.store.deleteSession(sessionId);
  }

  /** System-prompt addendum for this request. Empty when the open list was touched recently. */
  private async taskReminder(sessionId: string, messages: Message[]): Promise<string | undefined> {
    try {
      const snapshot = await TaskStore.forSession(this.workspacePath, sessionId).list();
      const openCount = snapshot.tasks.filter((task) => task.status !== "completed").length;
      if (
        !shouldRemindTasks({
          messages,
          openTaskCount: openCount,
          assistantCountAtLastReminder: this.taskReminderAssistants.get(sessionId) ?? null,
        })
      ) {
        return undefined;
      }
      this.taskReminderAssistants.set(
        sessionId,
        messages.filter((message) => message.role === "assistant").length,
      );
      return taskReminderText(snapshot.tasks);
    } catch {
      return undefined;
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** True for the whole submit, including permission and ask waits. */
  get isTurnRunning(): boolean {
    return this.running;
  }

  readSessionImage(sessionId: string, relativePath: string): Promise<string> {
    return this.store.readImageDataUrl(sessionId, relativePath);
  }

  async submit(sessionId: string, text: string, images?: SubmittedImage[]): Promise<void> {
    if (this.running) throw new AgentError("A turn is already running", "busy");
    const trimmed = text.trim();
    const incoming = images ?? [];
    if (!trimmed && incoming.length === 0) {
      throw new AgentError("Empty message", "empty");
    }
    if (incoming.length > MAX_IMAGES_PER_MESSAGE) {
      throw new AgentError(`At most ${MAX_IMAGES_PER_MESSAGE} images`, "bad_image");
    }
    this.running = true;
    this.turnWritesAllowed = false;
    this.batchOutputDirs = [];
    this.abort = new AbortController();
    const turn_id = newId("turn");
    try {
      this.skillBodies = await this.loadSkillBodies(trimmed);
      // Close any orphaned tool_calls from a prior crash/storage failure before
      // appending the new user message (append-only jsonl needs them at the end).
      await this.repairStoredToolCalls(sessionId);

      const storedImages = [];
      for (const image of incoming) {
        storedImages.push(
          await this.store.saveImage(sessionId, image.mime as ImageMime, image.base64),
        );
      }

      if (!(await this.persistTrace(turn_id, { session_id: sessionId, turn_id, type: "turn_start" }))) {
        return;
      }
      const userMsgId = newId("msg");
      const userTraceId = newId("trace");
      const userMsg: Message = {
        id: userMsgId,
        session_id: sessionId,
        turn_id,
        role: "user",
        content: trimmed,
        ...(storedImages.length ? { images: storedImages } : {}),
        trace_id: userTraceId,
        created_at: nowIso(),
      };
      if (!(await this.persistMessage(turn_id, userMsg))) return;
      if (
        !(await this.persistTrace(turn_id, {
          id: userTraceId,
          session_id: sessionId,
          turn_id,
          type: "user_message",
          message_id: userMsgId,
          detail: { content_chars: trimmed.length, image_count: storedImages.length },
        }))
      ) {
        return;
      }

      let steps = 0;

      while (true) {
        if (this.abort.signal.aborted) {
          await this.handleCancel(sessionId, turn_id, "");
          return;
        }

        this.emit({ type: "status", turn_id, phase: "assembling" });
        const loopHistory = await this.store.readMessages(sessionId);
        const installedSkills = (await listInstalledSkills(this.skillsRoot)).filter((skill) => skill.enabled);
        const extraSystem = await this.taskReminder(sessionId, loopHistory);
        const ctx = assembleContext({
          systemPrompt: this.systemPrompt,
          toolDefinitions: this.tools.listDefinitions(),
          history: loopHistory.slice(0, -1),
          currentUser: loopHistory[loopHistory.length - 1]!,
          contextCharLimit: this.config.contextCharLimit,
          installedSkills,
          skillBodies: this.skillBodies,
          extraSystem,
        });

        this.emit({ type: "status", turn_id, phase: "llm" });
        // Lightweight request meta only — full assembled payload is a separate concern.
        const requestId = newId("trace");
        const prepared = await prepareOutbound(ctx.messages, async (relativePath) => {
          try {
            return await this.store.readImageForSend(sessionId, relativePath);
          } catch {
            return null;
          }
        });
        const apiMessages = prepared.messages;
        const fingerprint = toolsFingerprint(this.tools.listDefinitions());
        if (
          !(await this.persistContext(turn_id, {
            sessionId,
            id: requestId,
            turnId: turn_id,
            model: this.config.model,
            toolsSha256: fingerprint.sha256,
            tools: fingerprint.tools,
            messages: projectAuditMessages(apiMessages, prepared.sentImages),
          }))
        ) {
          return;
        }
        const approxChars = apiMessages.reduce((n, m) => n + outboundTextChars(m.content), 0);
        const imageCount = countOutboundImages(apiMessages);
        if (
          !(await this.persistTrace(turn_id, {
            id: requestId,
            session_id: sessionId,
            turn_id,
            type: "llm_request",
            detail: {
              model: this.config.model,
              message_count: apiMessages.length,
              approx_chars: approxChars,
              image_count: imageCount,
              context_id: requestId,
            },
          }))
        ) {
          return;
        }

        let assistantText = "";
        const toolCalls: ToolCall[] = [];
        let usage:
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        let llmError: string | undefined;

        try {
          for await (const chunk of this.provider.chatStream({
            messages: apiMessages,
            tools: this.tools.listDefinitions(),
            model: this.config.model,
            signal: this.abort.signal,
          })) {
            if (this.abort.signal.aborted) break;
            if (chunk.type === "text" && chunk.text) {
              assistantText += chunk.text;
              this.emit({ type: "text", turn_id, delta: chunk.text });
            } else if (chunk.type === "tool_call_delta" && chunk.tool_call) {
              const call = renameLegacySubagentCall(chunk.tool_call);
              toolCalls.push(call);
              this.emit({ type: "tool_call", turn_id, tool_call: call });
            } else if (chunk.type === "usage") {
              usage = chunk.usage;
            } else if (chunk.type === "error") {
              llmError = chunk.error ?? "llm error";
            }
          }
        } catch (err) {
          if (!this.abort.signal.aborted) llmError = String(err);
        }

        // Abort during stream: keep partial text, do NOT persist tool_calls or execute them.
        if (this.abort.signal.aborted) {
          await this.handleCancel(sessionId, turn_id, assistantText);
          return;
        }

        if (llmError) {
          if (
            !(await this.persistTrace(turn_id, {
              session_id: sessionId,
              turn_id,
              type: "llm_error",
              request_id: requestId,
              error: llmError,
              token_usage: usage,
            }))
          ) {
            return;
          }
          this.emit({ type: "error", turn_id, message: llmError, code: "llm_error" });
          this.emit({ type: "done", turn_id, reason: "error" });
          return;
        }

        const assistantMsgId = newId("msg");
        const assistantTraceId = newId("trace");
        const assistantMsg: Message = {
          id: assistantMsgId,
          session_id: sessionId,
          turn_id,
          role: "assistant",
          content: assistantText,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          trace_id: assistantTraceId,
          created_at: nowIso(),
        };
        if (!(await this.persistMessage(turn_id, assistantMsg))) return;
        if (
          !(await this.persistTrace(turn_id, {
            id: assistantTraceId,
            session_id: sessionId,
            turn_id,
            type: "llm_response",
            message_id: assistantMsgId,
            request_id: requestId,
            token_usage: usage,
            detail: {
              content: assistantText,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            },
          }))
        ) {
          // Assistant with tool_calls already on disk — close them so the next
          // submit does not 400. persistTrace already emitted done(error).
          if (toolCalls.length) {
            await this.appendSyntheticToolResultsBestEffort(
              sessionId,
              turn_id,
              toolCalls,
              SYNTHETIC_INTERRUPTED_TOOL,
            );
          }
          return;
        }

        if (toolCalls.length === 0) {
          await this.emitDoneAndMaybeTitle(sessionId, turn_id, "completed");
          return;
        }

        if (steps >= this.config.maxSteps) {
          // Close open tool_calls with synthetic errors so history stays
          // OpenAI-valid for a subsequent user turn ("continue").
          const skipContent = `Skipped: reached max tool steps (${this.config.maxSteps}). Tool was not executed.`;
          const closed = await this.closeToolCallsWithPersist(
            sessionId,
            turn_id,
            toolCalls,
            skipContent,
            { skipped_max_steps: true },
          );
          if (!closed) return;

          const notice = `Reached max tool steps (${this.config.maxSteps}). Stopped. Continue or change your instruction.`;
          this.emit({ type: "text", turn_id, delta: notice });
          const noticeMsgId = newId("msg");
          const noticeTraceId = newId("trace");
          if (
            !(await this.persistMessage(turn_id, {
              id: noticeMsgId,
              session_id: sessionId,
              turn_id,
              role: "assistant",
              content: notice,
              trace_id: noticeTraceId,
              created_at: nowIso(),
            }))
          ) {
            return;
          }
          if (
            !(await this.persistTrace(turn_id, {
              id: noticeTraceId,
              session_id: sessionId,
              turn_id,
              type: "max_steps",
              message_id: noticeMsgId,
              detail: { maxSteps: this.config.maxSteps, content: notice },
            }))
          ) {
            return;
          }
          await this.emitDoneAndMaybeTitle(sessionId, turn_id, "max_steps");
          return;
        }

        steps += 1;
        const stop = await this.runToolBatch(sessionId, turn_id, toolCalls);
        if (stop) return;
      }
    } finally {
      this.running = false;
      this.turnWritesAllowed = false;
      this.batchOutputDirs = [];
      this.abort = null;
      this.skillBodies = [];
    }
  }

  private async loadSkillBodies(text: string): Promise<SkillBodyAttachment[]> {
    const bodies: SkillBodyAttachment[] = [];
    for (const name of extractSkillTokens(text)) {
      const result = await readInstalledSkillFile(
        name,
        undefined,
        this.config.maxReadChars,
        this.skillsRoot,
      );
      if (result.is_error || !result.directory) {
        const missing = result.content.startsWith("未找到技能");
        const disabled = result.content === `技能 ${name} 已停用`;
        throw new AgentError(
          missing
            ? `未知技能 /${name}`
            : disabled
              ? `技能 /${name} 已停用`
              : `无法读取技能 /${name}：${result.content}`,
          "unknown_skill",
        );
      }
      bodies.push({ name, directory: result.directory, body: result.content });
    }
    return bodies;
  }

  /**
   * Run one assistant tool batch. Agent calls before the first ask_user run together.
   * @returns true when the submit must stop (cancel, storage failure).
   */
  private async runToolBatch(
    sessionId: string,
    turn_id: string,
    toolCalls: ToolCall[],
  ): Promise<boolean> {
    const settled = new Set<string>();
    const claimed: string[] = [];
    for (const tc of toolCalls) {
      if (tc.function.name === ASK_USER_TOOL_NAME) break;
      if (tc.function.name !== AGENT_TOOL_NAME) continue;
      const parsed = parseAgentCall(tc.function.arguments);
      if (!parsed.ok || parsed.call.subagent_type !== "worker" || !parsed.call.output_dir) continue;
      if (claimed.some((dir) => outputDirsOverlap(dir, parsed.call.output_dir!))) continue;
      claimed.push(parsed.call.output_dir);
    }
    this.batchOutputDirs = claimed;
    try {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        if (settled.has(tc.id)) continue;
        if (this.abort!.signal.aborted) {
          await this.handleCancel(
            sessionId,
            turn_id,
            "",
            toolCalls.filter((call) => !settled.has(call.id)),
          );
          return true;
        }

        if (tc.function.name === AGENT_TOOL_NAME) {
          const group: ToolCall[] = [];
          for (let j = i; j < toolCalls.length; j++) {
            const next = toolCalls[j]!;
            if (next.function.name === ASK_USER_TOOL_NAME) break;
            if (next.function.name === AGENT_TOOL_NAME && !settled.has(next.id)) group.push(next);
          }
          const outcome = await this.runAgentGroup(sessionId, turn_id, group);
          for (const call of group) settled.add(call.id);
          if (outcome === "storage_failed") {
            await this.repairStoredToolCalls(sessionId);
            return true;
          }
          if (outcome === "stop") {
            await this.handleCancel(
              sessionId,
              turn_id,
              "",
              toolCalls.filter((call) => !settled.has(call.id)),
            );
            return true;
          }
          continue;
        }

        const result = await this.runAuthorizedTool(sessionId, turn_id, tc);
        settled.add(tc.id);
        if (result === "storage_failed") {
          await this.repairStoredToolCalls(sessionId);
          return true;
        }
        if (result === "cancelled") {
          await this.handleCancel(
            sessionId,
            turn_id,
            "",
            toolCalls.filter((call) => !settled.has(call.id)),
          );
          return true;
        }
        if (result === "asked") {
          const pending = toolCalls.filter((call) => !settled.has(call.id));
          const closed = await this.closeToolCallsWithPersist(
            sessionId,
            turn_id,
            pending,
            ASK_SKIPPED_CONTENT,
            { skipped_after_ask: true },
          );
          if (!closed) return true;
          break;
        }
        if (this.abort!.signal.aborted) {
          await this.handleCancel(
            sessionId,
            turn_id,
            "",
            toolCalls.filter((call) => !settled.has(call.id)),
          );
          return true;
        }
      }
      return false;
    } finally {
      this.batchOutputDirs = [];
    }
  }

  /**
   * Approve worker calls one at a time, then run every accepted subagent together.
   * Each call in `calls` has a tool result when this returns, unless storage failed.
   */
  private async runAgentGroup(
    sessionId: string,
    turn_id: string,
    calls: ToolCall[],
  ): Promise<"ok" | "stop" | "storage_failed"> {
    const persisted = new Set<string>();
    const ready: { tc: ToolCall; call: AgentCall }[] = [];
    const dirs: string[] = [];

    const persist = async (
      tc: ToolCall,
      result: ToolResult,
      detail: Record<string, unknown>,
    ): Promise<"ok" | "storage_failed"> => {
      const stored = await this.enqueueParentWrite(() =>
        this.persistToolOutcome(sessionId, turn_id, tc, result, detail),
      );
      if (stored === "ok") persisted.add(tc.id);
      return stored;
    };

    const cancelUnpersisted = async (): Promise<"stop" | "storage_failed"> => {
      const rest = calls.filter((call) => !persisted.has(call.id));
      const closed = await this.closeToolCallsWithPersist(
        sessionId,
        turn_id,
        rest,
        CANCELLED_TOOL_CONTENT,
        { cancelled: true },
      );
      for (const call of rest) persisted.add(call.id);
      return closed ? "stop" : "storage_failed";
    };

    for (const tc of calls) {
      if (this.abort?.signal.aborted) return cancelUnpersisted();
      const parsed = parseAgentCall(tc.function.arguments);
      if (!parsed.ok) {
        const stored = await persist(tc, { content: parsed.error, is_error: true }, { tool: AGENT_TOOL_NAME });
        if (stored === "storage_failed") return "storage_failed";
        continue;
      }
      if (parsed.call.subagent_type === "worker") {
        const dir = parsed.call.output_dir!;
        const clash = dirs.find((existing) => outputDirsOverlap(existing, dir));
        if (clash) {
          const stored = await persist(
            tc,
            {
              content: `output_dir ${dir} overlaps ${clash}, already used by another subagent call in this response.`,
              is_error: true,
            },
            { tool: AGENT_TOOL_NAME },
          );
          if (stored === "storage_failed") return "storage_failed";
          continue;
        }
        if (!this.turnWritesAllowed) {
          const request_id = newId("perm");
          const summary = `Needs confirmation: worker writes under ${dir}`;
          this.emit({ type: "status", turn_id, phase: "awaiting_permission" });
          this.emit({
            type: "permission_request",
            turn_id,
            request_id,
            tool_call_id: tc.id,
            tool: AGENT_TOOL_NAME,
            risk: "write",
            summary,
          });
          const decision = await this.permissions.request({
            request_id,
            turn_id,
            tool_call_id: tc.id,
            tool: AGENT_TOOL_NAME,
            risk: "write",
            summary,
            signal: this.abort?.signal,
          });
          if (this.abort?.signal.aborted) {
            const stored = await persist(
              tc,
              { content: CANCELLED_TOOL_CONTENT, is_error: true },
              { cancelled: true },
            );
            if (stored === "storage_failed") return "storage_failed";
            return cancelUnpersisted();
          }
          if (decision === "deny") {
            const stored = await persist(
              tc,
              { content: DENIED_TOOL_CONTENT, is_error: true },
              { denied: true },
            );
            if (stored === "storage_failed") return "storage_failed";
            continue;
          }
          this.turnWritesAllowed = true;
        }
        dirs.push(dir);
      }
      ready.push({ tc, call: parsed.call });
    }

    this.batchOutputDirs = dirs;
    this.emit({ type: "status", turn_id, phase: "tool" });
    const outcomes = await Promise.all(
      ready.map(async (item) => {
        const agentId = newId("subagent");
        const tasks = TaskStore.forSession(this.workspacePath, sessionId);
        if (item.call.task_id) {
          const claimed = await tasks.claim(item.call.task_id, agentId);
          if (!claimed.ok) {
            return { item, result: { content: claimed.error, is_error: true } };
          }
        }
        const releaseClaim = async (content: string): Promise<string> => {
          const released = await tasks.releaseInProgress(agentId);
          if (!released.length) return content;
          const ids = released.map((task) => `#${task.id}`).join(", ");
          return `${content}\n\nReleased back to pending: ${ids}. complete_task was not called.`;
        };
        try {
          const result = await runIsolatedSubagent({
            workspacePath: this.workspacePath,
            sessionId,
            parentTurnId: turn_id,
            parentToolCallId: item.tc.id,
            config: this.config,
            provider: this.provider,
            skillsRoot: this.skillsRoot,
            tools: this.tools.subset(toolsForSubagent(item.call.subagent_type)),
            signal: this.abort!.signal,
            onTool: (event) => {
              if (event.type === "tool_call") {
                this.emit({
                  type: "tool_call",
                  turn_id,
                  tool_call: event.tool_call,
                  parent_tool_call_id: item.tc.id,
                });
                return;
              }
              this.emit({
                type: "tool_result",
                turn_id,
                tool_call_id: event.tool_call_id,
                content: event.content,
                is_error: event.is_error,
                parent_tool_call_id: item.tc.id,
              });
            },
            subagentType: item.call.subagent_type,
            task: item.call.task,
            description: item.call.description,
            outputDir: item.call.output_dir,
            agentId,
            taskId: item.call.task_id,
          });
          return { item, result: { ...result, content: await releaseClaim(result.content) } };
        } catch (err) {
          return {
            item,
            result: {
              content: await releaseClaim(`Subagent failed: ${String(err)}`),
              is_error: true,
            },
          };
        }
      }),
    );
    for (const outcome of outcomes) {
      const stored = await persist(outcome.item.tc, outcome.result, {
        tool: AGENT_TOOL_NAME,
        subagent_type: outcome.item.call.subagent_type,
        is_error: outcome.result.is_error,
      });
      if (stored === "storage_failed") return "storage_failed";
    }
    if (this.abort?.signal.aborted) return "stop";
    return "ok";
  }

  private enqueueParentWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.parentWriteChain.then(fn, fn);
    this.parentWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Classify → optionally ask permission → execute or synthesize error tool result.
   * @returns "ok" | "cancelled" (abort while waiting) | "storage_failed"
   */
  private async runAuthorizedTool(
    sessionId: string,
    turn_id: string,
    tc: ToolCall,
  ): Promise<"ok" | "cancelled" | "storage_failed" | "asked"> {
    if (tc.function.name === ASK_USER_TOOL_NAME) {
      return this.runAskUser(sessionId, turn_id, tc);
    }
    const verdict = classifyToolCall(tc.function.name, tc.function.arguments);

    if (verdict.risk === "blocked") {
      return this.persistToolOutcome(sessionId, turn_id, tc, {
        content: BLOCKED_TOOL_CONTENT,
        is_error: true,
      }, { blocked: true });
    }

    if (verdict.risk === "write" && !this.turnWritesAllowed) {
      const request_id = newId("perm");
      this.emit({ type: "status", turn_id, phase: "awaiting_permission" });
      this.emit({
        type: "permission_request",
        turn_id,
        request_id,
        tool_call_id: tc.id,
        tool: tc.function.name,
        risk: "write",
        summary: verdict.summary,
        command: verdict.command,
      });
      const decision = await this.permissions.request({
        request_id,
        turn_id,
        tool_call_id: tc.id,
        tool: tc.function.name,
        risk: "write",
        summary: verdict.summary,
        command: verdict.command,
        signal: this.abort?.signal,
      });
      if (decision === "allow" && !this.abort?.signal.aborted) {
        this.turnWritesAllowed = true;
      }
      if (this.abort?.signal.aborted || decision === "deny") {
        // If user denied (not abort), still close this tool_call with deny text then
        // let caller continue or cancel remaining — abort path uses cancelled.
        if (this.abort?.signal.aborted) {
          const stored = await this.persistToolOutcome(sessionId, turn_id, tc, {
            content: CANCELLED_TOOL_CONTENT,
            is_error: true,
          }, { cancelled: true });
          return stored === "storage_failed" ? "storage_failed" : "cancelled";
        }
        return this.persistToolOutcome(sessionId, turn_id, tc, {
          content: DENIED_TOOL_CONTENT,
          is_error: true,
        }, { denied: true });
      }
    }

    this.emit({ type: "status", turn_id, phase: "tool" });
    const callTraceId = await this.persistToolCallStart(sessionId, turn_id, tc);
    if (callTraceId === "storage_failed") return "storage_failed";
    const started = Date.now();
    const result = await this.tools.execute(tc.function.name, tc.function.arguments, {
      workspacePath: this.workspacePath,
      signal: this.abort!.signal,
      bashTimeoutMs: this.config.bashTimeoutMs,
      maxToolOutputChars: this.config.maxToolOutputChars,
      maxReadChars: this.config.maxReadChars,
      maxSearchResults: this.config.maxSearchResults,
      apiKey: this.config.apiKey,
      llmBaseUrl: this.config.baseUrl,
      skillsRoot: this.skillsRoot,
      attachedSkillNames: new Set(this.skillBodies.map((skill) => skill.name)),
      blockedOutputDirs: this.batchOutputDirs,
      sessionId,
    });
    return this.persistToolOutcome(
      sessionId,
      turn_id,
      tc,
      result,
      {
        tool: tc.function.name,
        is_error: result.is_error,
        duration_ms: Date.now() - started,
      },
      callTraceId,
    );
  }

  /**
   * Suspend this turn until the user answers. Later tool calls in the same
   * batch are skipped by the caller so they are not executed before the answer.
   */
  private async runAskUser(
    sessionId: string,
    turn_id: string,
    tc: ToolCall,
  ): Promise<"ok" | "cancelled" | "storage_failed" | "asked"> {
    const parsed = parseAskUserArgs(tc.function.arguments);
    if (!parsed.ok) {
      const stored = await this.persistToolOutcome(
        sessionId,
        turn_id,
        tc,
        { content: parsed.error, is_error: true },
        { tool: "ask_user" },
      );
      return stored === "storage_failed" ? "storage_failed" : "ok";
    }

    const callTraceId = await this.persistToolCallStart(sessionId, turn_id, tc);
    if (callTraceId === "storage_failed") return "storage_failed";
    const request_id = newId("ask");
    this.emit({ type: "status", turn_id, phase: "awaiting_user" });
    this.emit({
      type: "ask_user",
      turn_id,
      request_id,
      tool_call_id: tc.id,
      question: parsed.call.question,
      options: parsed.call.options,
    });
    const decision = await this.asks.request({
      request_id,
      turn_id,
      tool_call_id: tc.id,
      question: parsed.call.question,
      options: parsed.call.options,
      signal: this.abort?.signal,
    });

    if (this.abort?.signal.aborted || decision.type === "cancel") {
      const stored = await this.persistToolOutcome(
        sessionId,
        turn_id,
        tc,
        { content: CANCELLED_TOOL_CONTENT, is_error: true },
        { cancelled: true },
        callTraceId,
      );
      return stored === "storage_failed" ? "storage_failed" : "cancelled";
    }

    if (decision.type === "unavailable") {
      const stored = await this.persistToolOutcome(
        sessionId,
        turn_id,
        tc,
        { content: ASK_UNAVAILABLE_CONTENT, is_error: true },
        { tool: "ask_user" },
        callTraceId,
      );
      return stored === "storage_failed" ? "storage_failed" : "asked";
    }

    const text = decision.text.trim().slice(0, ANSWER_MAX);
    if (!text) {
      const stored = await this.persistToolOutcome(
        sessionId,
        turn_id,
        tc,
        { content: ASK_EMPTY_CONTENT, is_error: true },
        { tool: "ask_user" },
        callTraceId,
      );
      return stored === "storage_failed" ? "storage_failed" : "asked";
    }

    const stored = await this.persistToolOutcome(
      sessionId,
      turn_id,
      tc,
      { content: text, is_error: false },
      { tool: "ask_user" },
      callTraceId,
    );
    return stored === "storage_failed" ? "storage_failed" : "asked";
  }

  private async persistToolCallStart(
    sessionId: string,
    turn_id: string,
    tc: ToolCall,
  ): Promise<string | "storage_failed"> {
    const id = newId("trace");
    if (
      !(await this.persistTrace(turn_id, {
        id,
        session_id: sessionId,
        turn_id,
        type: "tool_call",
        detail: {
          tool: tc.function.name,
          tool_call_id: tc.id,
          arguments: tc.function.arguments,
        },
      }))
    ) {
      return "storage_failed";
    }
    return id;
  }

  private async persistToolOutcome(
    sessionId: string,
    turn_id: string,
    tc: ToolCall,
    result: ToolResult,
    detail: Record<string, unknown>,
    requestId?: string,
  ): Promise<"ok" | "storage_failed"> {
    let startId = requestId;
    if (!startId) {
      const started = await this.persistToolCallStart(sessionId, turn_id, tc);
      if (started === "storage_failed") return "storage_failed";
      startId = started;
    }
    const msgId = newId("msg");
    const traceId = newId("trace");
    const toolMsg: Message = {
      id: msgId,
      session_id: sessionId,
      turn_id,
      role: "tool",
      name: tc.function.name,
      tool_call_id: tc.id,
      tool_call_arguments: tc.function.arguments,
      content: result.content,
      is_error: result.is_error,
      trace_id: traceId,
      created_at: nowIso(),
    };
    if (!(await this.persistMessage(turn_id, toolMsg))) return "storage_failed";
    if (
      !(await this.persistTrace(turn_id, {
        id: traceId,
        session_id: sessionId,
        turn_id,
        type: "tool_result",
        message_id: msgId,
        ...(startId ? { request_id: startId } : {}),
        detail: {
          tool: tc.function.name,
          tool_call_id: tc.id,
          arguments: tc.function.arguments,
          content: result.content,
          is_error: result.is_error,
          ...detail,
        },
      }))
    ) {
      return "storage_failed";
    }
    this.emit({
      type: "tool_result",
      turn_id,
      tool_call_id: tc.id,
      content: result.content,
      is_error: result.is_error,
    });
    return "ok";
  }

  /**
   * Append synthetic tool results for orphaned tool_calls when it is safe to
   * append at end of jsonl. Best-effort; never emits done (caller owns lifecycle).
   */
  private async repairStoredToolCalls(sessionId: string): Promise<void> {
    let msgs: Message[];
    try {
      msgs = await this.store.readMessages(sessionId);
    } catch {
      return;
    }
    if (!canAppendToolRepair(msgs)) return;
    const missing = findMissingToolResults(msgs);
    for (const info of missing) {
      try {
        await this.store.appendMessage({
          id: newId("msg"),
          session_id: info.session_id,
          turn_id: info.turn_id,
          role: "tool",
          name: info.name,
          tool_call_id: info.tool_call_id,
          tool_call_arguments: info.arguments,
          content: SYNTHETIC_INTERRUPTED_TOOL,
          is_error: true,
          created_at: nowIso(),
        });
      } catch {
        break;
      }
    }
  }

  /** Best-effort closes after done(error) already emitted — no second done. */
  private async appendSyntheticToolResultsBestEffort(
    sessionId: string,
    turn_id: string,
    toolCalls: ToolCall[],
    content: string,
  ): Promise<void> {
    for (const tc of toolCalls) {
      try {
        await this.store.appendMessage({
          id: newId("msg"),
          session_id: sessionId,
          turn_id,
          role: "tool",
          name: tc.function.name,
          tool_call_id: tc.id,
          tool_call_arguments: tc.function.arguments,
          content,
          is_error: true,
          created_at: nowIso(),
        });
      } catch {
        break;
      }
    }
  }

  /**
   * Persist tool results + traces + UI events for a batch of tool_calls.
   * @returns false if persistMessage/persistTrace already emitted done(error).
   */
  private async closeToolCallsWithPersist(
    sessionId: string,
    turn_id: string,
    toolCalls: ToolCall[],
    content: string,
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    for (const tc of toolCalls) {
      const callTraceId = await this.persistToolCallStart(sessionId, turn_id, tc);
      if (callTraceId === "storage_failed") return false;
      const msgId = newId("msg");
      const traceId = newId("trace");
      const toolMsg: Message = {
        id: msgId,
        session_id: sessionId,
        turn_id,
        role: "tool",
        name: tc.function.name,
        tool_call_id: tc.id,
        tool_call_arguments: tc.function.arguments,
        content,
        is_error: true,
        trace_id: traceId,
        created_at: nowIso(),
      };
      if (!(await this.persistMessage(turn_id, toolMsg))) return false;
      if (
        !(await this.persistTrace(turn_id, {
          id: traceId,
          session_id: sessionId,
          turn_id,
          type: "tool_result",
          message_id: msgId,
          request_id: callTraceId,
          detail: {
            tool: tc.function.name,
            tool_call_id: tc.id,
            arguments: tc.function.arguments,
            content,
            is_error: true,
            ...detail,
          },
        }))
      ) {
        return false;
      }
      this.emit({
        type: "tool_result",
        turn_id,
        tool_call_id: tc.id,
        content,
        is_error: true,
      });
    }
    return true;
  }

  /**
   * Finish a cancelled turn.
   * - Mid-stream: pass accumulated text; do not pass pendingToolCalls (assistant+tools not persisted).
   * - Mid-tools: pass "" for text and remaining tool_calls to close without executing.
   * Persist helpers already emit done(error) on failure — never emit a second done.
   */
  private async handleCancel(
    sessionId: string,
    turn_id: string,
    assistantText: string,
    pendingToolCalls: ToolCall[] = [],
  ): Promise<void> {
    const reply = assistantText.length > 0 ? assistantText : pendingToolCalls.length ? "" : CANCELLED_TURN_NOTICE;
    if (reply.length > 0) {
      const msgId = newId("msg");
      const traceId = newId("trace");
      if (
        !(await this.persistMessage(turn_id, {
          id: msgId,
          session_id: sessionId,
          turn_id,
          role: "assistant",
          content: reply,
          interrupted: true,
          trace_id: traceId,
          created_at: nowIso(),
        }))
      ) {
        return;
      }
      if (
        !(await this.persistTrace(turn_id, {
          id: traceId,
          session_id: sessionId,
          turn_id,
          type: "llm_response",
          message_id: msgId,
          detail: { content: reply, interrupted: true, cancelled_notice: reply !== assistantText },
        }))
      ) {
        return;
      }
    }

    if (pendingToolCalls.length) {
      const closed = await this.closeToolCallsWithPersist(
        sessionId,
        turn_id,
        pendingToolCalls,
        CANCELLED_TOOL_CONTENT,
        { cancelled: true },
      );
      if (!closed) return;
    }

    if (
      !(await this.persistTrace(turn_id, {
        session_id: sessionId,
        turn_id,
        type: "cancel",
        detail: {
          reason: "user",
          pending_tool_call_ids: pendingToolCalls.map((t) => t.id),
        },
      }))
    ) {
      return;
    }
    this.emit({ type: "done", turn_id, reason: "cancelled" });
  }
}
