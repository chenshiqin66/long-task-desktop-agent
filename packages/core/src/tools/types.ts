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
  /** Skill names whose bodies are already attached to this submit. */
  attachedSkillNames?: ReadonlySet<string>;
  /** Installed-skill root. Defaults to the user skills directory. */
  skillsRoot?: string;
  /** Worker subagent: writes must stay inside this workspace-relative directory. */
  writeRoot?: string;
  /**
   * Parent turn: writes into these directories fail. Set for output_dir values
   * claimed by subagents in the same assistant response.
   */
  blockedOutputDirs?: readonly string[];
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
