import type { ToolCall } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AssembledMessage } from "../context/assemble.js";

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

export interface LlmProvider {
  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
}
