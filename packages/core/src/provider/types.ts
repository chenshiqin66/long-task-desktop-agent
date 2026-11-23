import type { AudioMime, ImageMime, ToolCall, VideoMime } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AssembledMessage } from "../context/assemble.js";
import type { VideoCreateMode, VideoRatio, VideoResolution } from "./videoGeneration.js";
import type { SpeechFormat } from "./volcSpeech.js";

export interface LlmStreamChunk {
  type: "text" | "tool_call_delta" | "usage" | "error";
  text?: string;
  tool_call?: ToolCall;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
}

export interface LlmChatRequest {
  messages: AssembledMessage[];
  tools: ToolDefinition[];
  model: string;
  signal?: AbortSignal;
}

export interface ImageGenRequest {
  model: string;
  prompt: string;
  images?: { dataUrl: string }[];
  signal?: AbortSignal;
}

export interface ImageGenResult {
  mime: ImageMime;
  base64: string;
}

export interface VideoGenRequest {
  model: string;
  prompt: string;
  /** Frame images in order; roles come from `mode`. Reference mode → reference_image. */
  images?: { dataUrl: string }[];
  /** Reference mode only → reference_video. */
  videos?: { dataUrl: string }[];
  /** Reference mode only → reference_audio. */
  audios?: { dataUrl: string }[];
  mode?: VideoCreateMode;
  resolution?: VideoResolution;
  duration?: number;
  ratio?: VideoRatio;
  signal?: AbortSignal;
}

export interface VideoGenResult {
  mime: VideoMime;
  base64: string;
}

export interface SpeechGenRequest {
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

export interface TranscribeRequest {
  audio: Uint8Array;
  format: "mp3" | "wav" | "ogg" | "raw";
  sampleRate?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
  generateImage?(req: ImageGenRequest): Promise<ImageGenResult>;
  generateVideo?(req: VideoGenRequest): Promise<VideoGenResult>;
  generateSpeech?(req: SpeechGenRequest): Promise<SpeechGenResult>;
  transcribeAudio?(req: TranscribeRequest): Promise<string>;
}
