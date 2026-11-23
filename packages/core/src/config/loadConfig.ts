import { copyFile, mkdir, readFile, chmod, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFile, errorCode } from "../store/fileLock.js";
import type { StoredConfig, StoredModel } from "./types.js";
import {
  isComposerKind,
  parseComposerKind,
  readCurrentModelByKind,
  type ComposerKind,
  type CurrentModelByKind,
} from "./composerKind.js";
import { isAsrModel, isSearchModel, modelKindOf } from "./modelKind.js";
import {
  defaultTtsModelOptions,
  readTtsModelOptions,
} from "./speechOptions.js";
import {
  defaultVideoModelOptions,
  normalizeVideoByModel,
  normalizeVideoModelOptions,
  readVideoModelOptions,
} from "./videoOptions.js";
import {
  DEFAULT_IMAGE_PRESET,
  defaultImageModelOptions,
  inferImagePresetFromModel,
  normalizeImageByModel,
  parseImagePresetId,
  readImageModelOptions,
} from "./imageOptions.js";
import { newId } from "../ids.js";
import type { AgentConfig } from "../types.js";
import { DEFAULT_AGENT_CONFIG } from "../types.js";
import { getAgentHome } from "./agentHome.js";

export function getDefaultConfigPath(): string {
  return join(getAgentHome(), "config.json");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Set when a config file could not be parsed. Cleared by takeConfigQuarantine. */
let pendingQuarantine: { movedTo: string } | { stillAt: string } | null = null;

/** One-shot notice for the app. Missing files do not set this. */
export function takeConfigQuarantine(): { movedTo: string } | { stillAt: string } | null {
  const notice = pendingQuarantine;
  pendingQuarantine = null;
  return notice;
}

export async function loadStoredConfig(
  path = getDefaultConfigPath(),
): Promise<StoredConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    // Windows editors / PowerShell -Encoding utf8 often write a UTF-8 BOM.
    return JSON.parse(stripBom(text)) as StoredConfig;
  } catch {
    const backup = `${path}.broken-${Date.now()}`;
    try {
      await rename(path, backup);
      pendingQuarantine = { movedTo: backup };
    } catch {
      pendingQuarantine = { stillAt: path };
    }
    return null;
  }
}

export async function saveStoredConfig(
  cfg: StoredConfig,
  path = getDefaultConfigPath(),
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {
    /* best-effort on platforms that ignore mode */
  });
  // One rolling backup so a bad write or a silent recreate can be undone.
  try {
    await copyFile(path, `${path}.bak`);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
  await replaceFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

/** autoMemory is on unless the file says false. */
export function autoMemoryOf(stored: StoredConfig | null): boolean {
  return stored?.autoMemory !== false;
}

/** Stable id for a file that only has the old top-level model fields. */
export const LEGACY_MODEL_ID = "default";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanModel(entry: StoredModel): StoredModel {
  const kind = modelKindOf(entry);
  const model = entry.model.trim();
  const cleaned: StoredModel = {
    id: entry.id.trim(),
    name: entry.name.trim(),
    baseUrl: entry.baseUrl.trim(),
    model,
    apiKey: entry.apiKey.trim(),
    kind,
  };
  if (kind === "video") {
    const packed = normalizeVideoByModel(model || "MiniMax-H3-Lite", entry.videoByModel, entry.video);
    cleaned.model = packed.model;
    cleaned.video = packed.video;
    cleaned.videoByModel = packed.videoByModel;
  }
  if (kind === "tts") {
    cleaned.tts = entry.tts ? readTtsModelOptions(entry.tts) : defaultTtsModelOptions();
  }
  if (kind === "image") {
    const preset =
      parseImagePresetId(entry.imagePreset) ??
      inferImagePresetFromModel(model) ??
      DEFAULT_IMAGE_PRESET;
    const packed = normalizeImageByModel(preset, entry.imageByModel, entry.image);
    cleaned.imagePreset = packed.preset;
    cleaned.image = packed.image;
    cleaned.imageByModel = packed.imageByModel;
  }
  return cleaned;
}

function readModelEntry(raw: unknown): StoredModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id).trim();
  if (!id) return null;
  const modelName = asString(row.model);
  const kind = modelKindOf(row);
  const imagePreset =
    parseImagePresetId(row.imagePreset) ??
    inferImagePresetFromModel(modelName) ??
    DEFAULT_IMAGE_PRESET;
  const model = cleanModel({
    id,
    name: asString(row.name),
    baseUrl: asString(row.baseUrl),
    model: modelName,
    apiKey: asString(row.apiKey),
    kind,
    ...(kind === "video"
      ? {
          video: readVideoModelOptions(modelName, row.video),
          videoByModel:
            row.videoByModel && typeof row.videoByModel === "object"
              ? (row.videoByModel as StoredModel["videoByModel"])
              : undefined,
        }
      : {}),
    ...(kind === "tts" ? { tts: readTtsModelOptions(row.tts) } : {}),
    ...(kind === "image"
      ? {
          imagePreset,
          image: row.image ? readImageModelOptions(imagePreset, row.image) : undefined,
          imageByModel:
            row.imageByModel && typeof row.imageByModel === "object"
              ? (row.imageByModel as StoredModel["imageByModel"])
              : undefined,
        }
      : {}),
  });
  if (!model.name) model.name = model.model || "未命名模型";
  return model;
}

function legacyModel(stored: StoredConfig): StoredModel | null {
  const baseUrl = asString(stored.baseUrl).trim();
  const model = asString(stored.model).trim();
  const apiKey = asString(stored.apiKey).trim();
  if (!baseUrl && !model && !apiKey) return null;
  return {
    id: LEGACY_MODEL_ID,
    name: model || "未命名模型",
    baseUrl,
    model,
    apiKey,
    kind: modelKindOf(undefined),
  };
}

/** Configured models. A missing list becomes one entry from the top-level fields. */
export function modelsOf(stored: StoredConfig | null): StoredModel[] {
  if (!stored) return [];
  if (Array.isArray(stored.models)) {
    const models: StoredModel[] = [];
    const seen = new Set<string>();
    for (const raw of stored.models) {
      const entry = readModelEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      models.push(entry);
    }
    if (models.length || Object.prototype.hasOwnProperty.call(stored, "models")) return models;
  }
  const one = legacyModel(stored);
  return one ? [one] : [];
}

/**
 * Active composer category. Explicit `composerKind` wins; otherwise infer from
 * `currentModelId` when that entry is a composer kind (upgrade path).
 */
export function composerKindOf(stored: StoredConfig | null): ComposerKind {
  if (!stored) return "text";
  if (stored.composerKind !== undefined) return parseComposerKind(stored.composerKind);
  const cur = modelsOf(stored).find((entry) => entry.id === stored.currentModelId);
  const kind = modelKindOf(cur);
  return isComposerKind(kind) ? kind : "text";
}

/** Models listed in the composer picker for one category. */
export function modelsForComposerKind(
  stored: StoredConfig | null,
  kind: ComposerKind = composerKindOf(stored),
): StoredModel[] {
  return modelsOf(stored).filter((entry) => modelKindOf(entry) === kind);
}

/**
 * The current composer model for `composerKind`.
 * Search / ASR never win. Missing pool for that kind → null.
 */
export function currentModelOf(stored: StoredConfig | null): StoredModel | null {
  const kind = composerKindOf(stored);
  const pool = modelsForComposerKind(stored, kind);
  if (!pool.length) return null;
  const byKind = readCurrentModelByKind(stored?.currentModelByKind);
  const preferred = stored?.currentModelId ?? byKind[kind];
  return pool.find((entry) => entry.id === preferred) ?? pool[0]!;
}

/** The model web_search points to: the chosen search model, else the first one, else none. */
export function searchModelOf(stored: StoredConfig | null): StoredModel | null {
  const search = modelsOf(stored).filter((entry) => isSearchModel(entry));
  if (!search.length) return null;
  return search.find((entry) => entry.id === stored?.currentSearchModelId) ?? search[0]!;
}

/** The ASR model mic dictation points to: chosen ASR, else the first one, else none. */
export function asrModelOf(stored: StoredConfig | null): StoredModel | null {
  const asr = modelsOf(stored).filter((entry) => isAsrModel(entry));
  if (!asr.length) return null;
  return asr.find((entry) => entry.id === stored?.currentAsrModelId) ?? asr[0]!;
}

/** Memory extraction always uses a text model, never the current image, video, tts, or asr model. */
export function textModelForMemory(stored: StoredConfig | null): StoredModel | null {
  const models = modelsOf(stored);
  const current = currentModelOf(stored);
  if (current && modelKindOf(current) === "text") return current;
  return models.find((entry) => modelKindOf(entry) === "text") ?? null;
}

/** The explain pane uses a text model of its own, not the current image, video, tts, or asr model. */
export function textModelForExplain(stored: StoredConfig | null): StoredModel | null {
  const models = modelsOf(stored);
  const chosen = models.find((entry) => entry.id === stored?.currentExplainModelId);
  if (chosen && modelKindOf(chosen) === "text") return chosen;
  return textModelForMemory(stored);
}

export function withExplainModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = modelsOf(stored);
  const chosen = models.find((entry) => entry.id === modelId);
  if (!chosen || modelKindOf(chosen) !== "text") throw new Error("请选择生文模型");
  return normalizeStoredConfig({ ...stored, currentExplainModelId: chosen.id });
}

/** Point web_search at a search model. The chat model and the explain model stay as they are. */
export function withSearchModel(stored: StoredConfig, modelId: string): StoredConfig {
  const chosen = modelsOf(stored).find((entry) => entry.id === modelId);
  if (!chosen || !isSearchModel(chosen)) throw new Error("请选择网搜模型");
  return normalizeStoredConfig({ ...stored, currentSearchModelId: chosen.id });
}

/** Point mic dictation at an ASR model. The chat model stays as it is. */
export function withAsrModel(stored: StoredConfig, modelId: string): StoredConfig {
  const chosen = modelsOf(stored).find((entry) => entry.id === modelId);
  if (!chosen || !isAsrModel(chosen)) throw new Error("请选择语音识别模型");
  return normalizeStoredConfig({ ...stored, currentAsrModelId: chosen.id });
}

function explainModelIdOf(stored: StoredConfig, models: StoredModel[]): string | undefined {
  const chosen = models.find((entry) => entry.id === stored.currentExplainModelId);
  return chosen && modelKindOf(chosen) === "text" ? chosen.id : undefined;
}

function withExplainModelId(next: StoredConfig, explainId: string | undefined): StoredConfig {
  if (explainId) {
    next.currentExplainModelId = explainId;
    return next;
  }
  delete next.currentExplainModelId;
  return next;
}

function withSearchModelId(next: StoredConfig, searchId: string | undefined): StoredConfig {
  if (searchId) {
    next.currentSearchModelId = searchId;
    return next;
  }
  delete next.currentSearchModelId;
  return next;
}

function withAsrModelId(next: StoredConfig, asrId: string | undefined): StoredConfig {
  if (asrId) {
    next.currentAsrModelId = asrId;
    return next;
  }
  delete next.currentAsrModelId;
  return next;
}

/**
 * Copy the current chat entry into the top-level fields older readers still use.
 * The list always keeps its search models, even when there is no chat model.
 */
export function normalizeStoredConfig(stored: StoredConfig): StoredConfig {
  const models = modelsOf(stored);
  const kind = composerKindOf(stored);
  const byKind: CurrentModelByKind = { ...readCurrentModelByKind(stored.currentModelByKind) };
  const current = currentModelOf({ ...stored, models, composerKind: kind, currentModelByKind: byKind });
  if (current && isComposerKind(modelKindOf(current))) {
    byKind[modelKindOf(current) as ComposerKind] = current.id;
  }
  const searchId = searchModelOf({ ...stored, models })?.id;
  const asrId = asrModelOf({ ...stored, models })?.id;
  if (!current) {
    return withAsrModelId(
      withSearchModelId(
        withExplainModelId(
          {
            ...stored,
            models,
            composerKind: kind,
            currentModelByKind: byKind,
            currentModelId: undefined,
            baseUrl: "",
            model: "",
            apiKey: "",
          },
          undefined,
        ),
        searchId,
      ),
      asrId,
    );
  }
  return withAsrModelId(
    withSearchModelId(
      withExplainModelId(
        {
          ...stored,
          models,
          composerKind: kind,
          currentModelByKind: byKind,
          currentModelId: current.id,
          baseUrl: current.baseUrl,
          model: current.model,
          apiKey: current.apiKey,
        },
        explainModelIdOf(stored, models),
      ),
      searchId,
    ),
    asrId,
  );
}

/** Switch composer category; restore that kind's last model (or the first of the kind). */
export function withComposerKind(stored: StoredConfig, kind: ComposerKind): StoredConfig {
  const parsed = parseComposerKind(kind);
  const models = modelsOf(stored);
  const pool = models.filter((entry) => modelKindOf(entry) === parsed);
  const byKind: CurrentModelByKind = { ...readCurrentModelByKind(stored.currentModelByKind) };
  let id = byKind[parsed];
  if (!id || !pool.some((entry) => entry.id === id)) id = pool[0]?.id;
  if (id) byKind[parsed] = id;
  return normalizeStoredConfig({
    ...stored,
    models,
    composerKind: parsed,
    currentModelByKind: byKind,
    currentModelId: id,
  });
}

export function withCurrentModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = modelsOf(stored);
  // Search / ASR are bypasses — they cannot become the composer current model.
  const chat = models.filter((entry) => isComposerKind(modelKindOf(entry)));
  const current = chat.find((entry) => entry.id === modelId) ?? chat[0];
  if (!current) return normalizeStoredConfig({ ...stored, models, currentModelId: undefined });
  const kind = modelKindOf(current) as ComposerKind;
  const byKind: CurrentModelByKind = {
    ...readCurrentModelByKind(stored.currentModelByKind),
    [kind]: current.id,
  };
  return normalizeStoredConfig({
    ...stored,
    models,
    composerKind: kind,
    currentModelByKind: byKind,
    currentModelId: current.id,
  });
}

export function upsertModel(stored: StoredConfig, entry: StoredModel): StoredConfig {
  const next = readModelEntry(entry);
  if (!next) throw new Error("模型缺少标识");
  const previous = currentModelOf(stored);
  const models = modelsOf(stored);
  const index = models.findIndex((item) => item.id === next.id);
  if (index >= 0) models[index] = next;
  else models.push(next);
  // A new search model does not take over as the chat model.
  const currentId =
    previous && models.some((item) => item.id === previous.id)
      ? previous.id
      : isSearchModel(next)
        ? undefined
        : next.id;
  return normalizeStoredConfig({ ...stored, models, currentModelId: currentId });
}

export function removeModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = modelsOf(stored).filter((entry) => entry.id !== modelId);
  const kind = composerKindOf(stored);
  const pool = models.filter((entry) => modelKindOf(entry) === kind);
  const byKind: CurrentModelByKind = { ...readCurrentModelByKind(stored.currentModelByKind) };
  delete byKind[kind];
  for (const k of Object.keys(byKind) as ComposerKind[]) {
    if (!models.some((entry) => entry.id === byKind[k])) delete byKind[k];
  }
  const currentId =
    stored.currentModelId && stored.currentModelId !== modelId && pool.some((entry) => entry.id === stored.currentModelId)
      ? stored.currentModelId
      : pool[0]?.id;
  if (currentId) byKind[kind] = currentId;
  return normalizeStoredConfig({
    ...stored,
    models,
    composerKind: kind,
    currentModelByKind: byKind,
    currentModelId: currentId,
  });
}

export function duplicateModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = modelsOf(stored);
  const source = models.find((entry) => entry.id === modelId);
  if (!source) throw new Error("找不到这个模型");
  const copy: StoredModel = {
    ...source,
    id: newId("model"),
    name: `${source.name}（副本）`,
    kind: modelKindOf(source),
  };
  return normalizeStoredConfig({
    ...stored,
    models: [...models, copy],
    currentModelId: stored.currentModelId ?? currentModelOf(stored)?.id,
  });
}

export function toAgentConfig(stored: StoredConfig): AgentConfig {
  const current = currentModelOf(stored);
  const kind = modelKindOf(current);
  const model = (current?.model ?? asString(stored.model)).trim();
  return {
    // Trim: prompt()/hand-edited JSON often leave leading spaces that break fetch URLs.
    baseUrl: (current?.baseUrl ?? asString(stored.baseUrl)).trim(),
    model,
    apiKey: (current?.apiKey ?? asString(stored.apiKey)).trim(),
    kind,
    bashTimeoutMs: stored.bashTimeoutMs ?? DEFAULT_AGENT_CONFIG.bashTimeoutMs,
    maxSteps: stored.maxSteps ?? DEFAULT_AGENT_CONFIG.maxSteps,
    contextCharLimit: stored.contextCharLimit ?? DEFAULT_AGENT_CONFIG.contextCharLimit,
    maxToolOutputChars:
      stored.maxToolOutputChars ?? DEFAULT_AGENT_CONFIG.maxToolOutputChars,
    maxReadChars: stored.maxReadChars ?? DEFAULT_AGENT_CONFIG.maxReadChars,
    maxSearchResults: stored.maxSearchResults ?? DEFAULT_AGENT_CONFIG.maxSearchResults,
    ...(kind === "video"
      ? { video: current?.video ?? defaultVideoModelOptions(model || "MiniMax-H3-Lite") }
      : {}),
    ...(kind === "tts" ? { tts: current?.tts ?? defaultTtsModelOptions() } : {}),
    ...(kind === "image"
      ? {
          image:
            current?.image ??
            defaultImageModelOptions(inferImagePresetFromModel(model) ?? DEFAULT_IMAGE_PRESET),
        }
      : {}),
    ...searchTargetOf(stored),
  };
}

/**
 * Why the chat cannot start with this config. Null means a chat model is present and filled in.
 * Fresh installs have no config file; without this check the app used to POST to a default OpenAI
 * URL with an empty key and surface an opaque "fetch failed".
 * TTS/ASR call fixed openspeech hosts, so Base URL is optional for those kinds.
 */
export function chatModelProblem(stored: StoredConfig | null): string | null {
  const current = currentModelOf(stored);
  if (!current) return "还没有配置模型，请先在「模型」页添加";
  const kind = modelKindOf(current);
  if (kind === "tts" || kind === "asr") {
    if (!current.apiKey.trim()) return "当前模型还没有填写 API Key，请打开「模型」页补全（需豆包语音专属 Key）";
    if (!current.model.trim()) return "当前模型还没有填写 Model，请打开「模型」页补全";
    return null;
  }
  if (!current.apiKey.trim()) return "当前模型还没有填写 API Key，请打开「模型」页补全";
  if (!current.baseUrl.trim()) return "当前模型还没有填写 Base URL，请打开「模型」页补全";
  if (!current.model.trim()) return "当前模型还没有填写 Model，请打开「模型」页补全";
  return null;
}

/**
 * Where web_search goes. The current search model wins. The older searchBaseUrl / searchApiKey
 * fields apply only when there is no search model. Never the chat model's address or key.
 */
function searchTargetOf(stored: StoredConfig): { searchBaseUrl?: string; searchApiKey?: string } {
  const search = searchModelOf(stored);
  const baseUrl = (search ? search.baseUrl : asString(stored.searchBaseUrl)).trim();
  const apiKey = (search ? search.apiKey : asString(stored.searchApiKey)).trim();
  return {
    ...(baseUrl ? { searchBaseUrl: baseUrl } : {}),
    ...(apiKey ? { searchApiKey: apiKey } : {}),
  };
}
