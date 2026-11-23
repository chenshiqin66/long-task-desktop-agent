import type { ComposerKind, CurrentModelByKind } from "./composerKind.js";
import type { ImageByModel, ImageModelOptions, ImagePresetId } from "./imageOptions.js";
import type { ModelKind } from "./modelKind.js";
import type { TtsModelOptions } from "./speechOptions.js";
import type { VideoModelOptions } from "./videoOptions.js";

export interface StoredModel {
  id: string;
  /** Shown in the models page and the composer picker. */
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  kind: ModelKind;
  /** Present when kind is video. Active tab's options (mirrors videoByModel[model]). */
  video?: VideoModelOptions;
  /** Per MiniMax H3 preset options. Each tab keeps its own parameter set. */
  videoByModel?: Record<string, VideoModelOptions>;
  /** Present when kind is tts. */
  tts?: TtsModelOptions;
  /** Present when kind is image. Active tab's options (mirrors imageByModel[imagePreset]). */
  image?: ImageModelOptions;
  /** Per Seedream preset options. Each tab keeps its own parameter set. */
  imageByModel?: ImageByModel;
  /** Active Seedream preset. Model itself may be an official id or an endpoint id. */
  imagePreset?: ImagePresetId;
}

export interface StoredConfig {
  /** The current model. Kept in sync with models[currentModelId] so older readers still work. */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** When missing, the top-level baseUrl / model / apiKey are treated as one entry. */
  models?: StoredModel[];
  /** Which models[] entry is current. Missing or unknown means the first entry of composerKind. */
  currentModelId?: string;
  /**
   * Composer primary category (Chat / 生图 / 合成语音 / 生视频).
   * Missing means text. ASR and search are not values here.
   */
  composerKind?: ComposerKind;
  /** Last chosen model id per composer kind. Switching tabs restores these. */
  currentModelByKind?: CurrentModelByKind;
  /** Text model used by the explain pane. Missing or non-text falls back to a text model. */
  currentExplainModelId?: string;
  /**
   * Search model web_search points to. It is used alongside the current chat model, not instead of it.
   * Missing or not a search model means the first search model.
   */
  currentSearchModelId?: string;
  /**
   * ASR model mic dictation points to. Used alongside the chat model (like search).
   * Missing or not an ASR model means the first ASR model.
   */
  currentAsrModelId?: string;
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
  /**
   * Older way to configure web_search, used only when no search model exists.
   * Empty means DeepSeek's default address. Still expects DeepSeek's JSON.
   */
  searchBaseUrl?: string;
  /** Older search key, used only when no search model exists. */
  searchApiKey?: string;
}
