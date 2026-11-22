import type { ImageMime, ToolCall, VideoMime } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AssembledMessage } from "../context/assemble.js";
import type { VideoFrameMode, VideoRatio, VideoResolution } from "./videoGeneration.js";

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
  /** Frame images in order; roles come from `mode`. */
  images?: { dataUrl: string }[];
  mode?: VideoFrameMode;
  resolution?: VideoResolution;
  duration?: number;
  ratio?: VideoRatio;
  signal?: AbortSignal;
}

export interface VideoGenResult {
  mime: VideoMime;
  base64: string;
}

export interface LlmProvider {
  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
  generateImage?(req: ImageGenRequest): Promise<ImageGenResult>;
  generateVideo?(req: VideoGenRequest): Promise<VideoGenResult>;
}
