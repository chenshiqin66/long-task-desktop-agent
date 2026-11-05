export interface ToolResult {
  content: string;
  is_error: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  workspacePath: string;
  signal?: AbortSignal;
  bashTimeoutMs: number;
  maxToolOutputChars: number;
  maxReadChars: number;
  maxSearchResults: number;
  /** API key for network tools (e.g. DeepSeek web_search). Never logged by tools. */
  apiKey?: string;
  /** Chat-completions base URL; used to derive `/v1/tools/search`. */
  llmBaseUrl?: string;
  /** Optional override for search endpoint origin (tests / custom gateways). */
  searchBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
