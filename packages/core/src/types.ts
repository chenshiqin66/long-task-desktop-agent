import type { ModelKind } from "./config/modelKind.js";
import type { TtsModelOptions } from "./config/speechOptions.js";
import type { VideoModelOptions } from "./config/videoOptions.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Image bytes live under the session directory. The message stores only this reference. */
export interface ImageAttachment {
  id: string;
  mime: ImageMime;
  /** Relative to the session directory, e.g. images/img_abc.png */
  path: string;
}

/** Image the renderer already resized, sent with submit. Base64 is the raw payload, not a data URL. */
export interface SubmittedImage {
  mime: ImageMime;
  base64: string;
}

export type VideoMime = "video/mp4" | "video/webm" | "video/quicktime";
export interface VideoAttachment {
  id: string;
  mime: VideoMime;
  path: string; // videos/vid_<hex>.mp4 | .webm | .mov
}
export interface SubmittedVideo {
  mime: VideoMime;
  base64: string;
}

export type AudioMime = "audio/mpeg" | "audio/wav" | "audio/webm" | "audio/mp4" | "audio/ogg";
export interface AudioAttachment {
  id: string;
  mime: AudioMime;
  /** Relative to the session directory, e.g. audios/aud_abc.mp3 */
  path: string;
}
export interface SubmittedAudio {
  mime: AudioMime;
  base64: string;
}

export interface Message {
  id: string;
  session_id: string;
  turn_id: string;
  role: Role;
  content: string;
  images?: ImageAttachment[];
  videos?: VideoAttachment[];
  audios?: AudioAttachment[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * Tool-call arguments (input) for role=tool. Persisted for audit/UI;
   * not forwarded to the LLM (input already lives on the paired assistant.tool_calls).
   */
  tool_call_arguments?: string;
  /** role=tool only. False when the tool ran and returned a normal result. */
  is_error?: boolean;
  /** Matching TraceEvent.id when this message has a 1:1 audit event. */
  trace_id?: string;
  interrupted?: boolean;
  created_at: string;
}

export interface SessionMeta {
  session_id: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
  title?: string;
  /** Who last set the title; auto-title runs only when unset and title is still default. */
  title_source?: "user" | "auto";
}

export type RuntimeEvent =
  | { type: "text"; turn_id: string; delta: string }
  | { type: "tool_call"; turn_id: string; tool_call: ToolCall; parent_tool_call_id?: string; session_id?: string }
  | {
      type: "tool_result";
      turn_id: string;
      tool_call_id: string;
      content: string;
      is_error: boolean;
      /** Set when this call belongs to a subagent. The row sits under that parent tool, not inside it. */
      parent_tool_call_id?: string;
      /** Which session the subagent belongs to. Late rows must not paint onto another session. */
      session_id?: string;
    }
  | {
      type: "ask_user";
      turn_id: string;
      request_id: string;
      tool_call_id: string;
      question: string;
      options: string[];
    }
  | {
      type: "permission_request";
      turn_id: string;
      request_id: string;
      tool_call_id: string;
      tool: string;
      risk: "write";
      summary: string;
      command?: string;
      /** Present when this allow does not cover later writes in the turn. */
      grant?: "once";
    }
  | { type: "error"; turn_id?: string; message: string; code: string }
  | {
      type: "done";
      turn_id: string;
      reason: "completed" | "max_steps" | "cancelled" | "error";
    }
  | {
      type: "status";
      turn_id: string;
      phase:
        | "assembling"
        | "llm"
        | "tool"
        | "awaiting_permission"
        | "awaiting_user"
        | "generating_image"
        | "generating_video"
        | "generating_speech"
        | "transcribing";
    }
  | {
      type: "session_title";
      session_id: string;
      title: string;
      source: "auto";
    }
  /** A continuation turn is about to call the model for a background receipt. */
  | { type: "inbox_wake"; turn_id: string; session_id: string }
  /** A task-notification user message was just appended. */
  | { type: "task_notification"; turn_id: string; content: string }
  /** A message typed during a continuation was appended. The bubble is already on screen. */
  | { type: "held_user"; turn_id: string; session_id: string }
  | { type: "generated_images"; turn_id: string; message_id: string; images: ImageAttachment[] }
  | { type: "generated_videos"; turn_id: string; message_id: string; videos: VideoAttachment[] }
  | { type: "generated_audios"; turn_id: string; message_id: string; audios: AudioAttachment[] };

export interface TraceEvent {
  id: string;
  session_id: string;
  turn_id?: string;
  type: string;
  timestamp: string;
  /** Matching Message.id when this event corresponds to a persisted message. */
  message_id?: string;
  /** Links llm_response / llm_error back to llm_request, and tool_result back to tool_call. */
  request_id?: string;
  token_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
  detail?: Record<string, unknown>;
}

export interface AgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  kind: ModelKind;
  bashTimeoutMs: number;
  maxSteps: number;
  contextCharLimit: number;
  maxToolOutputChars: number;
  maxReadChars: number;
  maxSearchResults: number;
  /** web_search target. Comes from the current search model, never from the chat model. Set only when non-empty. */
  searchBaseUrl?: string;
  searchApiKey?: string;
  /** From the current video model entry. Only set when kind is video. */
  video?: VideoModelOptions;
  /** From the current TTS model entry. Only set when kind is tts. */
  tts?: TtsModelOptions;
}

/** Per-turn overrides from the composer (not written to config.json). */
export type TurnSubmitOptions = {
  video?: Partial<Pick<VideoModelOptions, "mode" | "resolution" | "duration" | "ratio">>;
};

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "baseUrl" | "model" | "apiKey"> = {
  kind: "text",
  bashTimeoutMs: 60_000,
  maxSteps: 50,
  contextCharLimit: 100_000,
  maxToolOutputChars: 20_000,
  maxReadChars: 50_000,
  maxSearchResults: 50,
};
