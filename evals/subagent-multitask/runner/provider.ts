import { OpenAICompatibleProvider } from "@agent/core";
import type { LlmChatRequest, LlmProvider, LlmStreamChunk, ToolCall } from "@agent/core";
import type { LiveModelSettings } from "./types.js";

export type AgentKind = "parent" | "subagent";

export interface RecordedExchange {
  kind: AgentKind;
  system: string;
  toolNames: string[];
  messages: LlmChatRequest["messages"];
  model: string;
  text: string;
  toolCalls: ToolCall[];
  error?: string;
  ms: number;
  /** True when an offline probe deliberately did not run this subagent. */
  stubbed?: boolean;
}

export function requestSystem(req: LlmChatRequest): string {
  const first = req.messages[0];
  if (!first) return "";
  return typeof first.content === "string" ? first.content : "";
}

export function classifyRequest(req: LlmChatRequest): AgentKind {
  return /You are an? (?:explore|worker) subagent/.test(requestSystem(req)) ? "subagent" : "parent";
}

export function recordedRequest(req: LlmChatRequest, kind: AgentKind): Omit<RecordedExchange, "text" | "toolCalls" | "ms"> {
  return {
    kind,
    system: requestSystem(req),
    toolNames: req.tools.map((tool) => tool.name),
    messages: req.messages,
    model: req.model,
  };
}

// ---------------------------------------------------------------------------
// Scripted provider (runtime-layer cases)
// ---------------------------------------------------------------------------

export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ScriptedResponse {
  text?: string;
  calls?: ScriptedCall[];
}

export interface ScriptedScript {
  parent: ScriptedResponse[];
  subagent: ScriptedResponse[];
}

function callChunk(call: ToolCall): LlmStreamChunk {
  return { type: "tool_call_delta", tool_call: call };
}

function callsFor(response: ScriptedResponse, kind: AgentKind, index: number): ToolCall[] {
  return (response.calls ?? []).map((call, offset) => ({
    id: call.id ?? `scripted_${kind}_${index}_${offset}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  }));
}

/**
 * Emits pre-written model output. A parent request and a subagent request have
 * independent counters, so the case script stays readable.
 */
export class ScriptedProvider implements LlmProvider {
  readonly exchanges: RecordedExchange[] = [];
  private readonly counters: Record<AgentKind, number> = { parent: 0, subagent: 0 };

  constructor(private readonly script: ScriptedScript) {}

  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const kind = classifyRequest(req);
    const index = this.counters[kind]++;
    const queue = kind === "parent" ? this.script.parent : this.script.subagent;
    const response = queue[index] ?? { text: kind === "parent" ? "Done." : "Finished the assigned work." };
    const toolCalls = callsFor(response, kind, index);
    const exchange: RecordedExchange = {
      ...recordedRequest(req, kind),
      text: response.text ?? "",
      toolCalls,
      ms: 0,
    };
    this.exchanges.push(exchange);

    return (async function* () {
      if (response.text) yield { type: "text", text: response.text } satisfies LlmStreamChunk;
      for (const call of toolCalls) yield callChunk(call);
    })();
  }
}

// ---------------------------------------------------------------------------
// Live provider (model / both cases)
// ---------------------------------------------------------------------------

export interface LiveProviderPolicy {
  /** Cancel the turn after the first parent response, before any tool runs. */
  stopBeforeTools?: boolean;
  /** Cancel after a parent response that contains a subagent call, before it runs. */
  stopAtSubagent?: boolean;
  /** Cancel after a parent response that contains a write tool. */
  stopAtWrite?: boolean;
  /**
   * Do not send subagent requests to the model. The child produces a stub
   * reply, so no real receipt can reach the parent during this turn.
   */
  stubSubagents?: boolean;
}

const WRITE_TOOLS = new Set(["write_file", "str_replace", "delete_file"]);

/** How long a stubbed child waits before a joined parent call is released. */
const STUB_JOIN_GRACE_MS = 15_000;

export function policyNeedsStop(policy: LiveProviderPolicy, exchange: Omit<RecordedExchange, "text" | "toolCalls" | "ms"> & {
  text: string;
  toolCalls: ToolCall[];
}): boolean {
  if (exchange.kind !== "parent") return false;
  const names = exchange.toolCalls.map((call) => call.function.name);
  if (policy.stopBeforeTools) return true;
  if (policy.stopAtSubagent && names.includes("subagent")) return true;
  if (policy.stopAtWrite && names.some((name) => WRITE_TOOLS.has(name))) return true;
  return false;
}

/**
 * Wraps the real model, records every request and response, and gives the
 * runner a hook that fires after a parent response has streamed completely.
 * The hook runs before the runtime persists the batch or executes a tool, so
 * `runtime.cancel()` stops the batch deterministically.
 */
export class RecordingProvider implements LlmProvider {
  readonly exchanges: RecordedExchange[] = [];
  onParentExchange: ((exchange: RecordedExchange) => void) | null = null;

  constructor(
    private readonly inner: LlmProvider,
    private readonly policy: LiveProviderPolicy = {},
  ) {}

  async *chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const kind = classifyRequest(req);
    const started = Date.now();
    const exchange: RecordedExchange = {
      ...recordedRequest(req, kind),
      text: "",
      toolCalls: [],
      ms: 0,
    };
    this.exchanges.push(exchange);

    if (kind === "subagent" && this.policy.stubSubagents) {
      exchange.stubbed = true;
      // A deferred child must not finish while the parent turn is alive, or its
      // notification would start a second parent turn and pollute the probe.
      // Wait for the runner's stop. A joined call has no stop coming, so cap the
      // wait and let the turn finish; the case already fails on the delivery
      // choice.
      await waitForAbort(req.signal, STUB_JOIN_GRACE_MS);
      exchange.ms = Date.now() - started;
      return;
    }

    try {
      for await (const chunk of this.inner.chatStream(req)) {
        if (chunk.type === "text" && chunk.text) exchange.text += chunk.text;
        else if (chunk.type === "tool_call_delta" && chunk.tool_call) exchange.toolCalls.push(chunk.tool_call);
        else if (chunk.type === "error") exchange.error = chunk.error ?? "llm error";
        yield chunk;
      }
    } finally {
      exchange.ms = Date.now() - started;
      if (kind === "parent" && !exchange.stubbed) this.onParentExchange?.(exchange);
    }
  }
}

function waitForAbort(signal: AbortSignal | undefined, capMs: number): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, capMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface LiveProviderBundle {
  provider: RecordingProvider;
  settings: LiveModelSettings;
}

export function createLiveProvider(settings: LiveModelSettings, policy: LiveProviderPolicy): LiveProviderBundle {
  const inner = new OpenAICompatibleProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
  return { provider: new RecordingProvider(inner, policy), settings };
}
