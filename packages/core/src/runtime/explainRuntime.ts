import { assembleContext } from "../context/assemble.js";
import { projectAuditMessages, toolsFingerprint } from "../context/auditContext.js";
import { countOutboundImages, outboundTextChars, prepareOutbound } from "../context/images.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL,
  findMissingToolResults,
  makeSyntheticToolMessage,
} from "../context/repairToolCalls.js";
import {
  EXPLAIN_SYSTEM_PROMPT,
  buildExplainUserContent,
  explainWebSearchTool,
} from "../explain/context.js";
import { newId, nowIso } from "../ids.js";
import type { LlmProvider } from "../provider/types.js";
import { ExplainStore } from "../store/explainStore.js";
import { ToolHost } from "../tools/host.js";
import type { ToolContext } from "../tools/types.js";
import type { AgentConfig, Message, SubmittedImage, ToolCall } from "../types.js";
import { AgentError } from "./errors.js";

const CANCELLED_TOOL = "Cancelled: tool was not executed.";
const CANCELLED_NOTICE = "任务已终止";
const MAX_STEP_SKIP = "Skipped: reached max tool steps. Tool was not executed.";

export type ExplainEvent =
  | { type: "text"; session_id: string; turn_id: string; delta: string }
  | { type: "tool_call"; session_id: string; turn_id: string; tool_call: ToolCall }
  | {
      type: "tool_result";
      session_id: string;
      turn_id: string;
      tool_call_id: string;
      content: string;
      is_error: boolean;
    }
  | { type: "status"; session_id: string; turn_id: string; phase: "assembling" | "llm" | "tool" }
  | { type: "error"; session_id: string; turn_id?: string; message: string; code: string }
  | {
      type: "done";
      session_id: string;
      turn_id: string;
      reason: "completed" | "max_steps" | "cancelled" | "error";
    };

type Listener = (event: ExplainEvent) => void;

export interface ExplainTurnContext {
  user: string;
  assistant: string;
}

/**
 * One explain conversation per main session, with its own loop.
 * It does not read skills, task reminders, or the main transcript except the
 * quote the caller already folded into the user message.
 */
export class ExplainRuntime {
  readonly workspacePath: string;
  private readonly store: ExplainStore;
  private readonly tools: ToolHost;
  private readonly provider: LlmProvider;
  private readonly config: AgentConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private running = false;
  private activeSession: string | null = null;

  constructor(opts: {
    workspacePath: string;
    config: AgentConfig;
    provider: LlmProvider;
    store?: ExplainStore;
    fetchImpl?: typeof fetch;
  }) {
    this.workspacePath = opts.workspacePath;
    this.config = opts.config;
    this.provider = opts.provider;
    this.store = opts.store ?? new ExplainStore(opts.workspacePath);
    this.tools = new ToolHost([explainWebSearchTool()]);
    this.fetchImpl = opts.fetchImpl;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activeSessionId(): string | null {
    return this.activeSession;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    this.abort?.abort();
  }

  loadMessages(sessionId: string): Promise<Message[]> {
    return this.store.readMessages(sessionId);
  }

  getOpen(sessionId: string): Promise<boolean> {
    return this.store.getOpen(sessionId);
  }

  setOpen(sessionId: string, open: boolean): Promise<void> {
    return this.store.setOpen(sessionId, open);
  }

  readImage(sessionId: string, relativePath: string): Promise<string> {
    return this.store.readImageDataUrl(sessionId, relativePath);
  }

  async submit(
    sessionId: string,
    text: string,
    images?: SubmittedImage[],
    context?: ExplainTurnContext | null,
  ): Promise<void> {
    const trimmed = text.trim();
    const incoming = images ?? [];
    if (!trimmed && incoming.length === 0) {
      throw new AgentError("没有可发送的内容", "empty");
    }
    if (this.running) throw new AgentError("解释还在进行", "busy");
    this.running = true;
    this.activeSession = sessionId;
    this.abort = new AbortController();
    const turnId = newId("turn");
    try {
      await this.repairStoredTools(sessionId);
      const storedImages = [];
      for (const image of incoming) storedImages.push(await this.store.saveImage(sessionId, image));
      const content = context ? buildExplainUserContent(trimmed, context) : trimmed;
      const userMsg: Message = {
        id: newId("msg"),
        session_id: sessionId,
        turn_id: turnId,
        role: "user",
        content,
        ...(storedImages.length ? { images: storedImages } : {}),
        created_at: nowIso(),
      };
      await this.store.appendMessage(userMsg);
      await this.store.appendTrace({
        session_id: sessionId,
        turn_id: turnId,
        type: "user_message",
        message_id: userMsg.id,
        detail: { content_chars: content.length, image_count: storedImages.length },
      });
      await this.loop(sessionId, turnId);
    } catch (err) {
      if (!this.abort?.signal.aborted) {
        this.emit({
          type: "error",
          session_id: sessionId,
          turn_id: turnId,
          message: String(err),
          code: "storage_write_failed",
        });
        this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "error" });
      }
    } finally {
      this.running = false;
      this.activeSession = null;
      this.abort = null;
    }
  }

  private emit(event: ExplainEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async repairStoredTools(sessionId: string): Promise<void> {
    const existing = await this.store.readMessages(sessionId);
    for (const info of findMissingToolResults(existing)) {
      await this.store.appendMessage(
        makeSyntheticToolMessage(info, SYNTHETIC_INTERRUPTED_TOOL, {
          id: newId("msg"),
          created_at: nowIso(),
        }),
      );
    }
  }

  private async loop(sessionId: string, turnId: string): Promise<void> {
    let steps = 0;
    while (this.abort && !this.abort.signal.aborted) {
      this.emit({ type: "status", session_id: sessionId, turn_id: turnId, phase: "assembling" });
      const history = await this.store.readMessages(sessionId);
      const currentUser = history[history.length - 1];
      if (!currentUser) return;
      const assembled = assembleContext({
        systemPrompt: EXPLAIN_SYSTEM_PROMPT,
        toolDefinitions: this.tools.listDefinitions(),
        history: history.slice(0, -1),
        currentUser,
        contextCharLimit: this.config.contextCharLimit,
      });
      this.emit({ type: "status", session_id: sessionId, turn_id: turnId, phase: "llm" });
      const requestId = newId("trace");
      const prepared = await prepareOutbound(assembled.messages, async (relativePath) => {
        try {
          return await this.store.readImageForSend(sessionId, relativePath);
        } catch {
          return null;
        }
      });
      const fingerprint = toolsFingerprint(this.tools.listDefinitions());
      await this.store.appendContext({
        sessionId,
        id: requestId,
        turnId,
        model: this.config.model,
        toolsSha256: fingerprint.sha256,
        tools: fingerprint.tools,
        messages: projectAuditMessages(prepared.messages, prepared.sentImages),
      });
      await this.store.appendTrace({
        id: requestId,
        session_id: sessionId,
        turn_id: turnId,
        type: "llm_request",
        detail: {
          model: this.config.model,
          message_count: prepared.messages.length,
          approx_chars: prepared.messages.reduce((n, m) => n + outboundTextChars(m.content), 0),
          image_count: countOutboundImages(prepared.messages),
          context_id: requestId,
        },
      });

      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      let llmError: string | undefined;
      try {
        for await (const chunk of this.provider.chatStream({
          messages: prepared.messages,
          tools: this.tools.listDefinitions(),
          model: this.config.model,
          signal: this.abort.signal,
        })) {
          if (this.abort.signal.aborted) break;
          if (chunk.type === "text" && chunk.text) {
            assistantText += chunk.text;
            this.emit({ type: "text", session_id: sessionId, turn_id: turnId, delta: chunk.text });
          } else if (chunk.type === "tool_call_delta" && chunk.tool_call) {
            toolCalls.push(chunk.tool_call);
            this.emit({
              type: "tool_call",
              session_id: sessionId,
              turn_id: turnId,
              tool_call: chunk.tool_call,
            });
          } else if (chunk.type === "error") {
            llmError = chunk.error ?? "llm error";
          }
        }
      } catch (err) {
        if (!this.abort.signal.aborted) llmError = String(err);
      }

      if (this.abort.signal.aborted) {
        await this.persistCancelNote(sessionId, turnId, assistantText);
        return;
      }
      if (llmError) {
        await this.store.appendTrace({
          session_id: sessionId,
          turn_id: turnId,
          type: "llm_error",
          request_id: requestId,
          error: llmError,
        });
        this.emit({ type: "error", session_id: sessionId, turn_id: turnId, message: llmError, code: "llm_error" });
        this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "error" });
        return;
      }

      await this.store.appendMessage({
        id: newId("msg"),
        session_id: sessionId,
        turn_id: turnId,
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        created_at: nowIso(),
      });
      await this.store.appendTrace({
        session_id: sessionId,
        turn_id: turnId,
        type: "llm_response",
        request_id: requestId,
        detail: { content_chars: assistantText.length, tool_calls: toolCalls.length },
      });

      if (!toolCalls.length) {
        this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "completed" });
        return;
      }
      if (steps >= this.config.maxSteps) {
        await this.closeTools(sessionId, turnId, toolCalls, MAX_STEP_SKIP);
        const notice = `Reached max tool steps (${this.config.maxSteps}). Stopped.`;
        this.emit({ type: "text", session_id: sessionId, turn_id: turnId, delta: notice });
        await this.store.appendMessage({
          id: newId("msg"),
          session_id: sessionId,
          turn_id: turnId,
          role: "assistant",
          content: notice,
          created_at: nowIso(),
        });
        this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "max_steps" });
        return;
      }
      steps += 1;
      const finished = await this.runTools(sessionId, turnId, toolCalls);
      if (finished === "cancelled") {
        this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "cancelled" });
        return;
      }
    }
    if (this.abort?.signal.aborted) await this.persistCancelNote(sessionId, turnId, "");
  }

  private async runTools(
    sessionId: string,
    turnId: string,
    toolCalls: ToolCall[],
  ): Promise<"ok" | "cancelled"> {
    const ctx: ToolContext = {
      workspacePath: this.workspacePath,
      signal: this.abort?.signal,
      bashTimeoutMs: this.config.bashTimeoutMs,
      maxToolOutputChars: this.config.maxToolOutputChars,
      maxReadChars: this.config.maxReadChars,
      maxSearchResults: this.config.maxSearchResults,
      apiKey: this.config.apiKey,
      llmBaseUrl: this.config.baseUrl,
      fetchImpl: this.fetchImpl,
      sessionId,
    };
    this.emit({ type: "status", session_id: sessionId, turn_id: turnId, phase: "tool" });
    for (const call of toolCalls) {
      if (this.abort?.signal.aborted) {
        await this.closeTools(
          sessionId,
          turnId,
          toolCalls.slice(toolCalls.indexOf(call)),
          CANCELLED_TOOL,
        );
        return "cancelled";
      }
      const result = await this.tools.execute(call.function.name, call.function.arguments, ctx);
      await this.store.appendMessage({
        id: newId("msg"),
        session_id: sessionId,
        turn_id: turnId,
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        tool_call_arguments: call.function.arguments,
        content: result.content,
        is_error: result.is_error,
        created_at: nowIso(),
      });
      this.emit({
        type: "tool_result",
        session_id: sessionId,
        turn_id: turnId,
        tool_call_id: call.id,
        content: result.content,
        is_error: result.is_error,
      });
    }
    return "ok";
  }

  private async closeTools(
    sessionId: string,
    turnId: string,
    toolCalls: ToolCall[],
    content: string,
  ): Promise<void> {
    for (const call of toolCalls) {
      await this.store.appendMessage({
        id: newId("msg"),
        session_id: sessionId,
        turn_id: turnId,
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        tool_call_arguments: call.function.arguments,
        content,
        is_error: true,
        created_at: nowIso(),
      });
      this.emit({
        type: "tool_result",
        session_id: sessionId,
        turn_id: turnId,
        tool_call_id: call.id,
        content,
        is_error: true,
      });
    }
  }

  /** Assistant text was not stored yet. Tool calls from an aborted stream are dropped. */
  private async persistCancelNote(sessionId: string, turnId: string, partial: string): Promise<void> {
    const prior = await this.store.readMessages(sessionId);
    const saved = prior.some((message) => message.turn_id === turnId && message.role === "assistant");
    if (!saved) {
      await this.store.appendMessage({
        id: newId("msg"),
        session_id: sessionId,
        turn_id: turnId,
        role: "assistant",
        content: partial.trim() ? partial : CANCELLED_NOTICE,
        created_at: nowIso(),
      });
    }
    this.emit({ type: "done", session_id: sessionId, turn_id: turnId, reason: "cancelled" });
  }
}
