import type { ToolCall } from "../types.js";
import type { LlmChatRequest, LlmProvider, LlmStreamChunk } from "./types.js";

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "AbortSignal";
}

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.trim().replace(/\/$/, "");
    this.apiKey = opts.apiKey.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const url = `${this.baseUrl}/chat/completions`;
    const tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: tools.length ? tools : undefined,
          stream: true,
        }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted || isAbortError(err)) return;
      // Include URL (no key) — "fetch failed" alone is opaque when baseUrl is mistyped.
      yield { type: "error", error: `${String(err)} (POST ${url})` };
      return;
    }
    if (!res.ok) {
      yield { type: "error", error: `HTTP ${res.status}: ${await res.text()}` };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: "Empty response body" };
      return;
    }

    const pending = new Map<number, ToolCall>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        if (req.signal?.aborted) return;
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (req.signal?.aborted || isAbortError(err)) return;
          yield { type: "error", error: String(err) };
          return;
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            for (const tc of pending.values()) {
              yield { type: "tool_call_delta", tool_call: tc };
            }
            pending.clear();
            return;
          }
          let json: {
            usage?: LlmStreamChunk["usage"];
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.usage) yield { type: "usage", usage: json.usage };
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length) {
            yield { type: "text", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const cur =
                pending.get(idx) ??
                ({
                  id: tc.id ?? `call_${idx}`,
                  type: "function",
                  function: { name: "", arguments: "" },
                } as ToolCall);
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.function.name += tc.function.name;
              if (tc.function?.arguments) {
                cur.function.arguments += tc.function.arguments;
              }
              pending.set(idx, cur);
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    for (const tc of pending.values()) {
      yield { type: "tool_call_delta", tool_call: tc };
    }
  }
}
