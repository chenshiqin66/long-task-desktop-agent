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
  /** Directories pinned in the workbench. Opening one shows the folder, and does not add a workspace. */
  favoriteFolders?: string[];
  /** Extract memory notes after each completed turn. Missing means on. Saved notes stay in context either way. */
  autoMemory?: boolean;
  bashTimeoutMs?: number;
  maxSteps?: number;
  contextCharLimit?: number;
  maxToolOutputChars?: number;
  maxReadChars?: number;
  maxSearchResults?: number;
  /** Search endpoint. Empty uses the chat base URL. Still expects DeepSeek's JSON. */
  searchBaseUrl?: string;
  /** Search key. Empty uses apiKey. */
  searchApiKey?: string;
}
