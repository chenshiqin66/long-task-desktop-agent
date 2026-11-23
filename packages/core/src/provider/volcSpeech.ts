import { gunzipSync, gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AudioMime } from "../types.js";
import type { TtsModelOptions } from "../config/speechOptions.js";
import {
  VOLC_ASR_ASYNC_URL,
  VOLC_ASR_NOSTREAM_URL,
  VOLC_ASR_RESOURCE_ID,
  VOLC_TTS_HTTP_URL,
  VOLC_TTS_RESOURCE_ID,
  defaultTtsModelOptions,
} from "../config/speechOptions.js";

export type SpeechFormat = "mp3" | "wav";

export interface SpeechGenRequest {
  apiKey: string;
  text: string;
  speaker?: string;
  format?: SpeechFormat;
  sampleRate?: number;
  signal?: AbortSignal;
}

export interface SpeechGenResult {
  mime: AudioMime;
  base64: string;
}

export interface AsrFileRequest {
  apiKey: string;
  /** Raw audio bytes (mp3/wav/webm/ogg/pcm). */
  audio: Uint8Array;
  /** Hint for the ASR audio.format field. */
  format: "mp3" | "wav" | "ogg" | "raw";
  sampleRate?: number;
  signal?: AbortSignal;
}

function abortError(signal?: AbortSignal): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  if (signal?.reason !== undefined) {
    try {
      (err as Error & { cause?: unknown }).cause = signal.reason;
    } catch {
      /* ignore */
    }
  }
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export function buildTtsHttpBody(req: {
  text: string;
  speaker?: string;
  format?: SpeechFormat;
  sampleRate?: number;
}): Record<string, unknown> {
  const defaults = defaultTtsModelOptions();
  const text = req.text.trim();
  if (!text) throw new Error("语音合成请先输入文本");
  return {
    req_params: {
      text,
      speaker: req.speaker?.trim() || defaults.speaker,
      audio_params: {
        format: req.format === "wav" ? "wav" : "mp3",
        sample_rate: req.sampleRate && req.sampleRate > 0 ? req.sampleRate : defaults.sampleRate,
      },
    },
  };
}

export function mimeForSpeechFormat(format: SpeechFormat): AudioMime {
  return format === "wav" ? "audio/wav" : "audio/mpeg";
}

/**
 * HTTP chunked unidirectional TTS (Agent Plan).
 * Response is NDJSON lines; audio chunks are base64 in `data`, end code 20000000.
 */
export async function synthesizeSpeechHttp(
  req: SpeechGenRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SpeechGenResult> {
  const apiKey = req.apiKey.trim();
  if (!apiKey) throw new Error("语音合成缺少 API Key（请使用豆包语音专属 Key）");
  const format: SpeechFormat = req.format === "wav" ? "wav" : "mp3";
  const body = buildTtsHttpBody(req);
  throwIfAborted(req.signal);
  const res = await fetchImpl(VOLC_TTS_HTTP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Connection: "keep-alive",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": VOLC_TTS_RESOURCE_ID,
      "X-Control-Require-Usage-Tokens-Return": "*",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.body) throw new Error("语音合成响应没有正文");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const audioChunks: Buffer[] = [];
  let sawEnd = false;
  let lastError = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data: { code?: number; data?: string; message?: string };
    try {
      data = JSON.parse(trimmed) as { code?: number; data?: string; message?: string };
    } catch {
      return;
    }
    const code = data.code ?? 0;
    if (code === 0 && data.data) {
      audioChunks.push(Buffer.from(data.data, "base64"));
      return;
    }
    if (code === 20000000) {
      sawEnd = true;
      return;
    }
    if (code > 0) {
      lastError = data.message || `TTS error code ${code}`;
      sawEnd = true;
    }
  };

  while (true) {
    throwIfAborted(req.signal);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) consumeLine(line);
    if (sawEnd) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  if (lastError) throw new Error(lastError);
  if (!audioChunks.length) throw new Error("语音合成未返回音频数据");
  return {
    mime: mimeForSpeechFormat(format),
    base64: Buffer.concat(audioChunks).toString("base64"),
  };
}

export function ttsOptionsFromConfig(tts?: TtsModelOptions | null): Pick<
  SpeechGenRequest,
  "speaker" | "format" | "sampleRate"
> {
  const opts = tts ?? defaultTtsModelOptions();
  return {
    speaker: opts.speaker,
    format: opts.format,
    sampleRate: opts.sampleRate,
  };
}

/* ---- ASR binary SAUC protocol (gzip + JSON) ---- */

const MSG_FULL_CLIENT = 0b0001;
const MSG_AUDIO_ONLY = 0b0010;
const MSG_FULL_SERVER = 0b1001;
const MSG_ERROR = 0b1111;
const FLAG_POS_SEQ = 0b0001;
const FLAG_NEG_SEQ = 0b0011;
const SERIAL_NONE = 0b0000;
const SERIAL_JSON = 0b0001;
const COMPRESS_GZIP = 0b0001;

function asrHeader(messageType: number, flags: number, serialization: number, compression: number): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = (0x01 << 4) | 0x01;
  buf[1] = (messageType << 4) | (flags & 0x0f);
  buf[2] = ((serialization & 0x0f) << 4) | (compression & 0x0f);
  buf[3] = 0;
  return buf;
}

/** Full client request: JSON + gzip + positive sequence. */
function buildAsrFullClientFrame(payload: Buffer, sequence = 1): Buffer {
  const compressed = gzipSync(payload);
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(sequence, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([
    asrHeader(MSG_FULL_CLIENT, FLAG_POS_SEQ, SERIAL_JSON, COMPRESS_GZIP),
    seq,
    size,
    compressed,
  ]);
}

/** Audio-only request: raw gzip bytes + sequence (negative when last). */
function buildAsrAudioFrame(chunk: Buffer, sequence: number, isLast: boolean): Buffer {
  const compressed = gzipSync(chunk);
  const flags = isLast ? FLAG_NEG_SEQ : FLAG_POS_SEQ;
  const seqVal = isLast ? -Math.abs(sequence) : sequence;
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(seqVal, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([
    asrHeader(MSG_AUDIO_ONLY, flags, SERIAL_NONE, COMPRESS_GZIP),
    seq,
    size,
    compressed,
  ]);
}

function parseAsrServerFrame(raw: Buffer): {
  messageType: number;
  flags: number;
  payload: Record<string, unknown> | null;
  errorCode?: number;
  errorMessage?: string;
  isLast: boolean;
} {
  if (raw.length < 4) return { messageType: 0, flags: 0, payload: null, isLast: false };
  const headerSize = (raw[0]! & 0x0f) * 4;
  const messageType = (raw[1]! >> 4) & 0x0f;
  const flags = raw[1]! & 0x0f;
  const compression = raw[2]! & 0x0f;
  let offset = headerSize > 0 ? headerSize : 4;

  // Error frames: code(4) + msg_size(4) + message — not the JSON payload layout.
  if (messageType === MSG_ERROR) {
    if (raw.length < offset + 8) {
      return { messageType, flags, payload: null, isLast: false, errorMessage: "ASR 服务返回错误" };
    }
    const errorCode = raw.readUInt32BE(offset);
    const msgSize = raw.readUInt32BE(offset + 4);
    let msgBuf = raw.subarray(offset + 8, offset + 8 + msgSize);
    if (compression === COMPRESS_GZIP && msgBuf.length) {
      try {
        msgBuf = gunzipSync(msgBuf);
      } catch {
        /* keep raw bytes */
      }
    }
    const errorMessage = msgBuf.toString("utf8") || `ASR 错误码 ${errorCode}`;
    return { messageType, flags, payload: null, errorCode, errorMessage, isLast: true };
  }

  if (flags === FLAG_POS_SEQ || flags === FLAG_NEG_SEQ) offset += 4;
  if (raw.length < offset + 4) return { messageType, flags, payload: null, isLast: false };
  const payloadSize = raw.readUInt32BE(offset);
  offset += 4;
  let payloadBuf = raw.subarray(offset, offset + payloadSize);
  if (compression === COMPRESS_GZIP && payloadBuf.length) {
    try {
      payloadBuf = gunzipSync(payloadBuf);
    } catch {
      return { messageType, flags, payload: null, isLast: false };
    }
  }
  let payload: Record<string, unknown> | null = null;
  if (payloadBuf.length) {
    try {
      payload = JSON.parse(payloadBuf.toString("utf8")) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  const code = typeof payload?.code === "number" ? payload.code : 0;
  const isLast =
    Boolean(payload && (payload as { is_last_package?: boolean }).is_last_package) ||
    (flags & 0b0010) !== 0;
  if (code !== 0 && code !== 20000000) {
    const msg =
      (typeof payload?.message === "string" && payload.message) ||
      (typeof payload?.error === "string" && payload.error) ||
      `ASR 错误码 ${code}`;
    return { messageType: MSG_ERROR, flags, payload, errorCode: code, errorMessage: msg, isLast: true };
  }
  return { messageType, flags, payload, isLast };
}

function extractTranscript(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const result = payload.result as { text?: string; utterances?: { text?: string }[] } | undefined;
  if (result?.text) return String(result.text);
  if (Array.isArray(result?.utterances)) {
    return result.utterances.map((u) => u.text ?? "").join("");
  }
  if (typeof payload.text === "string") return payload.text;
  return "";
}

function asrFullClientPayload(format: AsrFileRequest["format"], sampleRate: number): Buffer {
  // Official formats: wav / mp3 / ogg / pcm. "raw" is the codec for PCM, not the format.
  const audioFormat = format === "raw" ? "pcm" : format;
  const json = {
    user: { uid: "long-task-desktop-agent" },
    audio: {
      format: audioFormat,
      ...(audioFormat === "pcm" || audioFormat === "wav" ? { codec: "raw" as const } : {}),
      rate: sampleRate,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
    },
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

async function openAsrSocket(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WebSocket> {
  throwIfAborted(signal);
  const requestId = randomUUID();
  const ws = new WebSocket(url, {
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": VOLC_ASR_RESOURCE_ID,
      "X-Api-Request-Id": requestId,
      "X-Api-Connect-Id": randomUUID(),
      "X-Api-Sequence": "-1",
    },
  });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    ws.once("error", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("ASR WebSocket 连接失败"));
    });
  });
  return ws;
}

/**
 * Upload-style transcription via nostream WebSocket: send full audio then final negative packet.
 */
export async function transcribeAudioFile(req: AsrFileRequest): Promise<string> {
  const apiKey = req.apiKey.trim();
  if (!apiKey) throw new Error("语音识别缺少 API Key（请使用豆包语音专属 Key）");
  if (!req.audio.length) throw new Error("请先添加要转写的音频");
  const sampleRate = req.sampleRate && req.sampleRate > 0 ? req.sampleRate : 16000;
  const ws = await openAsrSocket(VOLC_ASR_NOSTREAM_URL, apiKey, req.signal);

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let transcript = "";
    const finish = (err?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve((text ?? transcript).trim());
    };
    const onAbort = () => finish(abortError(req.signal));
    req.signal?.addEventListener("abort", onAbort, { once: true });

    ws.on("message", (data) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const parsed = parseAsrServerFrame(raw);
      if (parsed.messageType === MSG_ERROR) {
        const detail = parsed.errorCode
          ? `${parsed.errorMessage}（${parsed.errorCode}）`
          : parsed.errorMessage || "语音识别服务返回错误";
        finish(new Error(detail));
        return;
      }
      if (parsed.messageType === MSG_FULL_SERVER) {
        const piece = extractTranscript(parsed.payload);
        if (piece) transcript = piece;
        if (parsed.isLast) finish(undefined, transcript);
      }
    });
    ws.on("close", () => {
      if (!settled) finish(undefined, transcript);
    });
    ws.on("error", () => finish(new Error("语音识别 WebSocket 出错")));

    try {
      // Full client must carry sequence=1; audio packets continue from 2.
      ws.send(buildAsrFullClientFrame(asrFullClientPayload(req.format, sampleRate), 1));
      // ~200ms chunks for 16kHz s16le mono; for mp3/wav the byte size is a heuristic.
      const chunkSize = 6400;
      const bytes = Buffer.from(req.audio);
      let seq = 1;
      if (!bytes.length) {
        ws.send(buildAsrAudioFrame(Buffer.alloc(0), 2, true));
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          throwIfAborted(req.signal);
          seq += 1;
          const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
          const isLast = i + chunkSize >= bytes.length;
          ws.send(buildAsrAudioFrame(Buffer.from(slice), seq, isLast));
        }
      }
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export type MicAsrHandlers = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

/** Streaming mic ASR session (async endpoint). Caller feeds PCM s16le 16kHz mono chunks. */
export class MicAsrSession {
  private ws: WebSocket | null = null;
  private seq = 1;
  private closed = false;

  constructor(
    private readonly apiKey: string,
    private readonly handlers: MicAsrHandlers = {},
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    const ws = await openAsrSocket(VOLC_ASR_ASYNC_URL, this.apiKey, signal);
    this.ws = ws;
    this.seq = 1;
    ws.on("message", (data) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const parsed = parseAsrServerFrame(raw);
      if (parsed.messageType === MSG_ERROR) {
        const detail = parsed.errorCode
          ? `${parsed.errorMessage}（${parsed.errorCode}）`
          : parsed.errorMessage || "语音识别服务返回错误";
        this.handlers.onError?.(detail);
        return;
      }
      if (parsed.messageType === MSG_FULL_SERVER) {
        const piece = extractTranscript(parsed.payload);
        if (!piece && !parsed.isLast) return;
        const definite = Boolean(
          (parsed.payload?.result as { utterances?: { definite?: boolean }[] } | undefined)
            ?.utterances?.some((u) => u.definite) || parsed.isLast,
        );
        if (definite || parsed.isLast) this.handlers.onFinal?.(piece);
        else this.handlers.onPartial?.(piece);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      this.handlers.onClose?.();
    });
    ws.on("error", () => this.handlers.onError?.("语音识别 WebSocket 出错"));
    ws.send(buildAsrFullClientFrame(asrFullClientPayload("raw", 16000), 1));
  }

  sendPcm(chunk: Uint8Array): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    this.ws.send(buildAsrAudioFrame(Buffer.from(chunk), this.seq, false));
  }

  finish(): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    this.ws.send(buildAsrAudioFrame(Buffer.alloc(0), this.seq, true));
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

export function asrFormatFromMime(mime: string): AsrFileRequest["format"] {
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav" || mime === "audio/wave" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/ogg" || mime === "audio/opus") return "ogg";
  // Openspeech nostream accepts wav/mp3/ogg/pcm only — not webm/m4a containers.
  throw new Error("语音识别暂只支持 mp3、wav 或 ogg，请转换后重试");
}
