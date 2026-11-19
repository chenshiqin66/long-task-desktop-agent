import type { MemoryStore } from "../memory/store.js";

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
  /** web_search endpoint. Empty means DeepSeek's default. Independent of the chat model. */
  searchBaseUrl?: string;
  /** DeepSeek API key for web_search. Required; never logged by tools. No fallback to the chat model's key. */
  searchApiKey?: string;
  fetchImpl?: typeof fetch;
  /** Skill names whose bodies are already attached to this submit. */
  attachedSkillNames?: ReadonlySet<string>;
  /** Installed-skill root. Defaults to the user skills directory. */
  skillsRoot?: string;
  /** Worker subagent: writes must stay inside this workspace-relative directory. */
  writeRoot?: string;
  /** Session whose task list these tools read. Subagents use the parent session. */
  sessionId?: string;
  /**
   * Owner used when claim_task or complete_task omits owner.
   * The parent leaves this unset and is recorded as main. A subagent sets its own id.
   */
  taskOwner?: string;
  /**
   * Parent turn: writes into these directories fail. Set for output_dir values
   * claimed by subagents in the same assistant response.
   */
  blockedOutputDirs?: readonly string[];
  /** Memory for this workspace. Only the parent session has it. */
  memory?: MemoryStore;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
