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

export interface Message {
  id: string;
  session_id: string;
  turn_id: string;
  role: Role;
  content: string;
  images?: ImageAttachment[];
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
  | { type: "tool_call"; turn_id: string; tool_call: ToolCall; parent_tool_call_id?: string }
  | {
      type: "tool_result";
      turn_id: string;
      tool_call_id: string;
      content: string;
      is_error: boolean;
      /** Set when this call belongs to a subagent. The row sits under that parent tool, not inside it. */
      parent_tool_call_id?: string;
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
      phase: "assembling" | "llm" | "tool" | "awaiting_permission" | "awaiting_user";
    }
  | {
      type: "session_title";
      session_id: string;
      title: string;
      source: "auto";
    };

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
  bashTimeoutMs: number;
  maxSteps: number;
  contextCharLimit: number;
  maxToolOutputChars: number;
  maxReadChars: number;
  maxSearchResults: number;
}

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "baseUrl" | "model" | "apiKey"> = {
  bashTimeoutMs: 60_000,
  maxSteps: 50,
  contextCharLimit: 100_000,
  maxToolOutputChars: 20_000,
  maxReadChars: 50_000,
  maxSearchResults: 50,
};
