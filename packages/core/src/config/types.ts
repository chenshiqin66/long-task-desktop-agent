export interface StoredConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Directories shown in the sidebar. Adding one does not remove the others. */
  workspacePaths?: string[];
  /** Sidebar labels keyed by workspace path. Missing key means show the folder name. Does not rename the directory. */
  workspaceLabels?: Record<string, string>;
  /** Workspaces the user collapsed. Missing paths stay expanded. */
  workspaceCollapsed?: string[];
  /** Workspace the agent runs in. Restored on launch. */
  lastWorkspacePath?: string;
  bashTimeoutMs?: number;
  maxSteps?: number;
  contextCharLimit?: number;
  maxToolOutputChars?: number;
  maxReadChars?: number;
  maxSearchResults?: number;
}
