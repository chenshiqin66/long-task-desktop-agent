import type { ToolCall } from "../types.js";
import type {
  ImageGenRequest,
  ImageGenResult,
  LlmChatRequest,
  LlmProvider,
  LlmStreamChunk,
  SpeechGenRequest,
  SpeechGenResult,
  TranscribeRequest,
  VideoGenRequest,
  VideoGenResult,
} from "./types.js";
import {
  buildImageGenerationBody,
  imageUrlFromGenerationResponse,
  inferImageMimeFromUrl,
  parseImageFormat,
  parseImageGenerationResponse,
  parseImageMime,
} from "./imageGeneration.js";
import type { ImageOutputFormat } from "../config/imageOptions.js";
import {
  buildVideoGenerationBody,
  inferVideoMimeFromUrl,
  parseVideoMime,
  parseVideoTaskId,
  parseVideoTaskQuery,
  videoApiRoot,
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_POLL_TIMEOUT_MS,
} from "./videoGeneration.js";
import { synthesizeSpeechHttp, transcribeAudioFile } from "./volcSpeech.js";

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "AbortSignal";
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async *chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const retry = yield* this.openStream(req, true);
    if (retry) yield* this.openStream(req, false);
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${this.baseUrl}/images/generations`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildImageGenerationBody(req)),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch (err) {
      if (req.signal?.aborted || isAbortError(err)) throw err;
      throw new Error("No image in response");
    }
    try {
      return parseImageGenerationResponse(
        body,
        res.headers.get("content-type") ?? undefined,
        req.outputFormat,
      );
    } catch (err) {
      const imageUrl = imageUrlFromGenerationResponse(body);
      if (!imageUrl) throw err;
      return await this.downloadGeneratedImage(imageUrl, req.signal, req.outputFormat);
    }
  }

  private async downloadGeneratedImage(
    imageUrl: string,
    signal?: AbortSignal,
    preferredFormat?: ImageOutputFormat,
  ): Promise<ImageGenResult> {
    const res = await this.fetchImpl(imageUrl, { signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error("Empty image body");
    }
    const mime =
      parseImageMime(res.headers.get("content-type")) ??
      inferImageMimeFromUrl(imageUrl) ??
      parseImageFormat(preferredFormat) ??
      "image/png";
    return { mime, base64: Buffer.from(bytes).toString("base64") };
  }

  /**
   * PPIO MiniMax H3 (and compatible hosts): create async task → poll → download url.
   * Paths are `/v3/minimax/v2/...` on the API host (not under OpenAI `/v1`).
   */
  async generateVideo(req: VideoGenRequest): Promise<VideoGenResult> {
    const root = videoApiRoot(this.baseUrl);
    const createUrl = `${root}/v3/minimax/v2/video_generation`;
    const createRes = await this.fetchImpl(createUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildVideoGenerationBody(req)),
      signal: req.signal,
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`HTTP ${createRes.status}: ${text}`);
    }
    let created: unknown;
    try {
      created = JSON.parse(await createRes.text());
    } catch (err) {
      if (req.signal?.aborted || isAbortError(err)) throw err;
      throw new Error("创建视频任务失败：响应不是 JSON");
    }
    const taskId = parseVideoTaskId(created);
    const queryUrl = `${root}/v3/minimax/v2/query/video_generation/${encodeURIComponent(taskId)}`;
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    let videoUrl: string | undefined;
    while (Date.now() < deadline) {
      if (req.signal?.aborted) throw abortError(req.signal);
      const queryRes = await this.fetchImpl(queryUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: req.signal,
      });
      if (!queryRes.ok) {
        const text = await queryRes.text();
        throw new Error(`HTTP ${queryRes.status}: ${text}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(await queryRes.text());
      } catch (err) {
        if (req.signal?.aborted || isAbortError(err)) throw err;
        throw new Error("查询视频任务失败：响应不是 JSON");
      }
      const snapshot = parseVideoTaskQuery(body);
      if (snapshot.status === "succeeded") {
        videoUrl = snapshot.url;
        break;
      }
      if (snapshot.status === "failed" || snapshot.status === "cancelled") {
        throw new Error(snapshot.error ?? "视频生成失败");
      }
      await sleep(VIDEO_POLL_INTERVAL_MS, req.signal);
    }
    if (!videoUrl) throw new Error("视频生成超时，请稍后在派欧云控制台查看任务状态");
    return await this.downloadGeneratedVideo(videoUrl, req.signal);
  }

  private async downloadGeneratedVideo(videoUrl: string, signal?: AbortSignal): Promise<VideoGenResult> {
    const res = await this.fetchImpl(videoUrl, { signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error("Empty video body");
    }
    const mime = parseVideoMime(res.headers.get("content-type")) ?? inferVideoMimeFromUrl(videoUrl);
    return { mime, base64: Buffer.from(bytes).toString("base64") };
  }

  /** Volcengine openspeech HTTP TTS — ignores OpenAI-style baseUrl. */
  async generateSpeech(req: SpeechGenRequest): Promise<SpeechGenResult> {
    return synthesizeSpeechHttp(
      {
        apiKey: this.apiKey,
        text: req.text,
        speaker: req.speaker,
        format: req.format,
        sampleRate: req.sampleRate,
        signal: req.signal,
      },
      this.fetchImpl,
    );
  }

  /** Volcengine openspeech ASR nostream WebSocket — ignores OpenAI-style baseUrl. */
  async transcribeAudio(req: TranscribeRequest): Promise<string> {
    return transcribeAudioFile({
      apiKey: this.apiKey,
      audio: req.audio,
      format: req.format,
      sampleRate: req.sampleRate,
      signal: req.signal,
    });
  }

  private async *openStream(
    req: LlmChatRequest,
    includeUsage: boolean,
  ): AsyncGenerator<LlmStreamChunk, boolean | undefined> {
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
        headers: this.headers(),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: tools.length ? tools : undefined,
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
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
      const text = await res.text();
      if (includeUsage && res.status === 400 && /stream_options/i.test(text)) return true;
      yield { type: "error", error: `HTTP ${res.status}: ${text}` };
      return false;
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
