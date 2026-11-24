import { attachComposerModelSizing, fitComposerModelEmpty, fitComposerModelSelect } from "./composerModelFit.js";
import {
  VIDEO_GEN_MODE_OPTIONS,
  VIDEO_MODEL_PRESETS,
  VIDEO_RATIO_OPTIONS,
  defaultVideoByModel,
  defaultVideoModelOptions,
  normalizeVideoByModel,
  normalizeVideoModelOptions,
  paintCheckGroup,
  readCheckGroup,
  readCheckGroupDefault,
  videoModelBlurb,
  videoOptionsSummary,
  videoPresetOf,
  videoTabLabel,
  type VideoByModel,
  type VideoGenMode,
  type VideoModelOptions,
  type VideoRatio,
  type VideoResolution,
} from "./videoModelForm.js";
import {
  DEFAULT_IMAGE_PRESET,
  IMAGE_BACKGROUND_OPTIONS,
  IMAGE_FORMAT_OPTIONS,
  IMAGE_MODEL_PRESETS,
  IMAGE_PROMPT_MODE_OPTIONS,
  IMAGE_RATIO_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  defaultImageByModel,
  defaultImageModelIds,
  defaultImageModelOptions,
  imageModelBlurb,
  imageOptionsSummary,
  imagePresetLabel,
  inferImagePresetFromModel,
  normalizeImageByModel,
  normalizeImageModelOptions,
  parseImagePresetId,
  type ImageBackground,
  type ImageByModel,
  type ImageModelOptions,
  type ImageOutputFormat,
  type ImagePresetId,
  type ImagePromptMode,
  type ImageRatio,
  type ImageSizeTier,
} from "./imageModelForm.js";

type ModelKind = "text" | "image" | "video" | "tts" | "asr" | "search";
type ComposerKind = "text" | "image" | "tts" | "video";

const MODEL_KINDS: readonly ModelKind[] = ["text", "image", "video", "tts", "asr", "search"];
const COMPOSER_KINDS: readonly ComposerKind[] = ["text", "image", "tts", "video"];

/** Library page tabs, grouped by what the model generates. */
export type ModelsTab = "text" | "image" | "speech" | "video" | "other";

export const MODELS_TABS: readonly { id: ModelsTab; label: string; kinds: readonly ModelKind[] }[] = [
  { id: "text", label: "生文", kinds: ["text"] },
  { id: "image", label: "生图", kinds: ["image"] },
  { id: "speech", label: "语音", kinds: ["tts", "asr"] },
  { id: "video", label: "生视频", kinds: ["video"] },
  // Non-generation helpers live here: search today, embedding etc. later.
  { id: "other", label: "其他", kinds: ["search"] },
];

export function modelsTabOfKind(kind: ModelKind): ModelsTab {
  return MODELS_TABS.find((row) => row.kinds.includes(kind))?.id ?? "other";
}

/** Models listed under one library tab. */
export function modelsForTab<T extends KindedModel>(
  models: readonly T[] | undefined,
  tab: ModelsTab,
): T[] {
  const kinds = MODELS_TABS.find((row) => row.id === tab)?.kinds ?? [];
  return (models ?? []).filter((entry) => kinds.includes(parseModelKind(entry.kind)));
}

type TtsModelOptions = {
  speaker: string;
  format: "mp3" | "wav";
  sampleRate: number;
};

const DEFAULT_TTS: TtsModelOptions = {
  speaker: "zh_female_vv_uranus_bigtts",
  format: "mp3",
  sampleRate: 24000,
};

type StoredModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  kind?: ModelKind;
  video?: VideoModelOptions;
  videoByModel?: VideoByModel;
  tts?: TtsModelOptions;
  image?: ImageModelOptions;
  imageByModel?: ImageByModel;
  imagePreset?: ImagePresetId;
};

type StoredConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: StoredModel[];
  currentModelId?: string;
  composerKind?: ComposerKind;
  currentModelByKind?: Partial<Record<ComposerKind, string>>;
  /** web_search's model. Separate from currentModelId: both are in use at the same time. */
  currentSearchModelId?: string;
  /** Mic dictation's ASR model. Separate from currentModelId. */
  currentAsrModelId?: string;
  [key: string]: unknown;
};

export type KindedModel = { id: string; kind?: unknown };

/** Models the composer picker used to list (all non-search). Prefer modelsForComposerKind. */
export function chatModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) !== "search");
}

export function parseComposerKind(raw: unknown): ComposerKind {
  return typeof raw === "string" && (COMPOSER_KINDS as readonly string[]).includes(raw)
    ? (raw as ComposerKind)
    : "text";
}

export function isComposerKind(kind: ModelKind): kind is ComposerKind {
  return (COMPOSER_KINDS as readonly string[]).includes(kind);
}

/** Models shown in the composer picker for one primary category. */
export function modelsForComposerKind<T extends KindedModel>(
  models: readonly T[] | undefined,
  kind: ComposerKind,
): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) === kind);
}

export function composerKindOf(cfg: StoredConfig | null | undefined): ComposerKind {
  if (!cfg) return "text";
  if (cfg.composerKind !== undefined) return parseComposerKind(cfg.composerKind);
  const cur = (cfg.models ?? []).find((entry) => entry.id === cfg.currentModelId);
  const kind = parseModelKind(cur?.kind);
  return isComposerKind(kind) ? kind : "text";
}

export function searchModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) === "search");
}

export function asrModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) === "asr");
}

/** The id in use within one pool: the saved id when it belongs to the pool, else the pool's first. */
export function inUseId(pool: readonly KindedModel[], savedId: string | undefined): string | undefined {
  return (pool.find((entry) => entry.id === savedId) ?? pool[0])?.id;
}

export interface ModelsHost {
  onOpen: () => void;
  onClose: () => void;
}

export function modelRowHeading(name: string, kindLabel: string): string {
  return `${name} · ${kindLabel}`;
}

export function composerModelOptionText(name: string, kindLabel: string): string {
  return `${name}（${kindLabel}）`;
}

function parseModelKind(raw: unknown): ModelKind {
  if (raw === "audio") return "tts";
  return typeof raw === "string" && (MODEL_KINDS as readonly string[]).includes(raw)
    ? (raw as ModelKind)
    : "text";
}

function normalizeTts(raw?: Partial<TtsModelOptions> | null): TtsModelOptions {
  const speaker =
    typeof raw?.speaker === "string" && raw.speaker.trim() ? raw.speaker.trim() : DEFAULT_TTS.speaker;
  const format = raw?.format === "wav" ? "wav" : "mp3";
  const sampleRate =
    typeof raw?.sampleRate === "number" && Number.isFinite(raw.sampleRate) && raw.sampleRate > 0
      ? Math.round(raw.sampleRate)
      : DEFAULT_TTS.sampleRate;
  return { speaker, format, sampleRate };
}

function modelKindOf(entry: { kind?: unknown } | null | undefined): ModelKind {
  return parseModelKind(entry?.kind);
}

function modelLabel(entry: StoredModel): string {
  return entry.name || entry.model || "未命名模型";
}

function kindLabelFromSelect(select: HTMLSelectElement, kind: ModelKind): string {
  for (let i = 0; i < select.options.length; i++) {
    const option = select.options[i];
    if (option && option.value === kind) return option.textContent || "生文";
  }
  return "生文";
}

function textButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "mcp-btn mcp-btn-danger" : "mcp-btn";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function newModelId(): string {
  return `model_${crypto.randomUUID().replace(/-/g, "")}`;
}

function emptyConfig(): StoredConfig {
  return { baseUrl: "", model: "", apiKey: "", models: [], currentModelId: undefined };
}

function duplicateModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = [...(stored.models ?? [])];
  const source = models.find((entry) => entry.id === modelId);
  if (!source) throw new Error("找不到这个模型");
  const copy: StoredModel = {
    ...source,
    id: newModelId(),
    name: `${source.name}（副本）`,
    kind: modelKindOf(source),
  };
  return {
    ...stored,
    models: [...models, copy],
    currentModelId: stored.currentModelId,
  };
}

/** Keep a password field masked unless the eye toggle is on. */
export function paintSecretReveal(
  input: HTMLInputElement,
  toggle: HTMLButtonElement,
  revealed: boolean,
): void {
  input.type = revealed ? "text" : "password";
  toggle.setAttribute("aria-label", revealed ? "隐藏 API Key" : "显示 API Key");
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
  const showIcon = toggle.querySelector(".icon-eye");
  const hideIcon = toggle.querySelector(".icon-eye-off");
  if (showIcon instanceof SVGElement) showIcon.toggleAttribute("hidden", revealed);
  if (hideIcon instanceof SVGElement) hideIcon.toggleAttribute("hidden", !revealed);
}

export function attachSecretReveal(input: HTMLInputElement, toggle: HTMLButtonElement): void {
  paintSecretReveal(input, toggle, false);
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    paintSecretReveal(input, toggle, input.type === "password");
  });
}

export function attachModelsLibrary(
  button: HTMLButtonElement,
  page: HTMLElement,
  select: HTMLSelectElement,
  emptyBtn: HTMLButtonElement,
  host: ModelsHost,
): {
  reload(): Promise<void>;
  isFormOpen(): boolean;
  cancelForm(): void;
  setComposerKind(kind: ComposerKind): Promise<ComposerKind>;
  resetComposerKindToChat(): Promise<void>;
  composerKind(): Promise<ComposerKind>;
  loadConfig(): Promise<StoredConfig | null>;
  cycleTab(step: number): void;
} {
  const list = page.querySelector("#models-list") as HTMLElement;
  const tabsHost = page.querySelector("#models-tabs") as HTMLElement;
  const note = page.querySelector("#models-note") as HTMLElement;
  const count = page.querySelector("#models-count") as HTMLElement;
  const addBtn = page.querySelector("#models-add") as HTMLButtonElement;
  const modal = document.querySelector("#models-modal") as HTMLDialogElement;
  const form = modal.querySelector("#models-form") as HTMLFormElement;
  const modalTitle = modal.querySelector("#models-modal-title") as HTMLElement;
  const modalClose = modal.querySelector("#models-modal-close") as HTMLButtonElement;
  const formError = modal.querySelector("#models-form-error") as HTMLElement;
  const nameInput = form.querySelector("#model-name") as HTMLInputElement;
  const kindSelect = form.querySelector("#model-kind") as HTMLSelectElement;
  const baseUrlInput = form.querySelector("#model-baseUrl") as HTMLInputElement;
  const modelField = form.querySelector("#model-model-field") as HTMLElement;
  const modelInput = form.querySelector("#model-model") as HTMLInputElement;
  const apiKeyInput = form.querySelector("#model-apiKey") as HTMLInputElement;
  const apiKeyToggle = form.querySelector("#model-apiKey-toggle") as HTMLButtonElement | null;
  if (apiKeyToggle) attachSecretReveal(apiKeyInput, apiKeyToggle);
  const cancelBtn = form.querySelector("#models-cancel") as HTMLButtonElement;
  const kindHint = form.querySelector("#model-kind-hint") as HTMLElement | null;
  const videoBaseUrlHint = form.querySelector("#model-video-baseurl-hint") as HTMLElement | null;
  const speechBaseUrlHint = form.querySelector("#model-speech-baseurl-hint") as HTMLElement | null;
  const ttsOptions = form.querySelector("#model-tts-options") as HTMLElement | null;
  const ttsSpeaker = form.querySelector("#model-tts-speaker") as HTMLInputElement | null;
  const ttsFormat = form.querySelector("#model-tts-format") as HTMLSelectElement | null;
  const ttsSampleRate = form.querySelector("#model-tts-sample-rate") as HTMLInputElement | null;
  const videoOptions = form.querySelector("#model-video-options") as HTMLElement;
  const videoTabsHost = form.querySelector("#model-video-tabs") as HTMLElement;
  const videoModesHost = form.querySelector("#model-video-modes") as HTMLElement;
  const videoResolutionsHost = form.querySelector("#model-video-resolutions") as HTMLElement;
  const videoDurationInput = form.querySelector("#model-video-duration") as HTMLInputElement;
  const videoDurationMinLabel = form.querySelector("#model-video-duration-min") as HTMLElement;
  const videoDurationValue = form.querySelector("#model-video-duration-value") as HTMLElement;
  const videoBlurb = form.querySelector("#model-video-blurb") as HTMLElement;
  const videoRatiosHost = form.querySelector("#model-video-ratios") as HTMLElement;
  const imageOptions = form.querySelector("#model-image-options") as HTMLElement;
  const imageTabsHost = form.querySelector("#model-image-tabs") as HTMLElement;
  const imageBlurb = form.querySelector("#model-image-blurb") as HTMLElement;
  const imageSizesHost = form.querySelector("#model-image-sizes") as HTMLElement;
  const imageRatiosHost = form.querySelector("#model-image-ratios") as HTMLElement;
  const imageFormatsHost = form.querySelector("#model-image-formats") as HTMLElement;
  const imageBackgroundsHost = form.querySelector("#model-image-backgrounds") as HTMLElement;
  const imageWatermark = form.querySelector("#model-image-watermark") as HTMLInputElement;
  const imagePromptModesHost = form.querySelector("#model-image-prompt-modes") as HTMLElement;
  const imagePromptGroup = form.querySelector("#model-image-prompt-group") as HTMLElement;
  const imagePromptNote = form.querySelector("#model-image-prompt-note") as HTMLElement;
  const imageBaseUrlHint = form.querySelector("#model-image-baseurl-hint") as HTMLElement | null;

  let editing: string | null = null;
  let painting = false;
  /** Library tab shown in the list; kept across reloads once the user picks one. */
  let activeTab: ModelsTab = "text";
  let tabChosen = false;
  let lastCfg: StoredConfig | null = null;
  let activeVideoModel = "MiniMax-H3-Lite";
  let videoDraftByModel: VideoByModel = defaultVideoByModel();
  let activeImagePreset: ImagePresetId = DEFAULT_IMAGE_PRESET;
  let imageDraftByModel: ImageByModel = defaultImageByModel();
  let imageModelDraftByPreset: Record<ImagePresetId, string> = defaultImageModelIds();
  let lastKind: ModelKind = "text";
  let modelBeforeImage = "";

  function durationBounds(model: string): { min: number; max: number } {
    const preset = videoPresetOf(model) ?? VIDEO_MODEL_PRESETS[0]!;
    return { min: preset.durationMin, max: preset.durationMax };
  }

  function clampTo(raw: number, min: number, max: number): number {
    if (!Number.isFinite(raw)) return min;
    return Math.min(max, Math.max(min, Math.round(raw)));
  }

  function durationsFromRange(min: number, max: number): number[] {
    const out: number[] = [];
    for (let n = min; n <= max; n++) out.push(n);
    return out;
  }

  function placeDurationLabels(rangeMin: number, rangeMax: number): void {
    const scaleMin = Number(videoDurationInput.min) || 0;
    const scaleMax = Number(videoDurationInput.max) || 15;
    const span = Math.max(1, scaleMax - scaleMin);
    const pctOf = (n: number) => ((n - scaleMin) / span) * 100;
    const startPct = pctOf(rangeMin);
    const maxPct = pctOf(rangeMax);
    const endPct = pctOf(Number(videoDurationInput.dataset.maxAllowed) || scaleMax);

    videoDurationMinLabel.textContent = String(rangeMin);
    videoDurationMinLabel.style.left = `${startPct}%`;
    videoDurationMinLabel.classList.toggle("is-start", startPct <= 4);

    videoDurationValue.textContent = String(rangeMax);
    videoDurationValue.style.left = `${maxPct}%`;
    videoDurationValue.classList.toggle("is-end", maxPct >= 96);

    videoDurationInput.style.setProperty("--video-duration-pct", `${maxPct}%`);
    videoDurationInput.style.setProperty("--video-duration-start", `${startPct}%`);
    videoDurationInput.style.setProperty("--video-duration-end", `${endPct}%`);
  }

  function paintDurationControls(model: string, video: VideoModelOptions): void {
    const { min, max } = durationBounds(model);
    const enabled = video.durations?.length ? video.durations : durationsFromRange(min, max);
    const rangeMax = clampTo(Math.max(...enabled), min, max);
    videoDurationInput.min = "0";
    videoDurationInput.max = "15";
    videoDurationInput.step = "1";
    videoDurationInput.value = String(rangeMax);
    videoDurationInput.dataset.minAllowed = String(min);
    videoDurationInput.dataset.maxAllowed = String(max);
    placeDurationLabels(min, rangeMax);
  }

  function readVideoForm(model = activeVideoModel): VideoModelOptions {
    const { min, max } = durationBounds(model);
    const rangeMax = clampTo(Number(videoDurationInput.value), min, max);
    return normalizeVideoModelOptions(model, {
      modes: readCheckGroup(videoModesHost) as VideoGenMode[],
      resolutions: readCheckGroup(videoResolutionsHost) as VideoResolution[],
      durations: durationsFromRange(min, rangeMax),
      ratios: readCheckGroup(videoRatiosHost) as VideoRatio[],
      mode: readCheckGroupDefault(videoModesHost) as VideoGenMode | undefined,
      resolution: readCheckGroupDefault(videoResolutionsHost) as VideoResolution | undefined,
      duration: min,
      ratio: readCheckGroupDefault(videoRatiosHost) as VideoRatio | undefined,
    });
  }

  function stashActiveVideoTab(): void {
    try {
      videoDraftByModel = {
        ...videoDraftByModel,
        [activeVideoModel]: readVideoForm(activeVideoModel),
      } as VideoByModel;
    } catch {
      /* keep previous draft for this tab */
    }
  }

  function paintVideoParams(model: string, video?: VideoModelOptions | null): void {
    const opts = normalizeVideoModelOptions(model, video ?? defaultVideoModelOptions(model));
    const preset = VIDEO_MODEL_PRESETS.find((row) => row.id === model) ?? VIDEO_MODEL_PRESETS[0]!;
    videoBlurb.textContent = videoModelBlurb(model) || preset.blurb;
    paintCheckGroup(
      videoModesHost,
      "video-mode",
      VIDEO_GEN_MODE_OPTIONS,
      new Set(opts.modes),
      opts.mode,
    );
    paintCheckGroup(
      videoResolutionsHost,
      "video-resolution",
      preset.resolutions.map((value) => ({ value, label: value })),
      new Set(opts.resolutions),
      opts.resolution,
    );
    paintDurationControls(model, opts);
    paintCheckGroup(
      videoRatiosHost,
      "video-ratio",
      VIDEO_RATIO_OPTIONS,
      new Set(opts.ratios),
      opts.ratio,
    );
  }

  function paintVideoTabs(active: string): void {
    videoTabsHost.replaceChildren();
    for (const preset of VIDEO_MODEL_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = preset.id === active ? "video-option-tab is-active" : "video-option-tab";
      btn.role = "tab";
      btn.dataset.videoModel = preset.id;
      btn.setAttribute("aria-selected", preset.id === active ? "true" : "false");
      btn.title = preset.id;
      btn.textContent = videoTabLabel(preset.id);
      btn.addEventListener("click", () => {
        if (preset.id === activeVideoModel) return;
        stashActiveVideoTab();
        activeVideoModel = preset.id;
        paintVideoTabs(activeVideoModel);
        paintVideoParams(activeVideoModel, videoDraftByModel[activeVideoModel as keyof VideoByModel]);
      });
      videoTabsHost.append(btn);
    }
  }

  function loadVideoDraft(entry?: StoredModel | null): void {
    const packed = normalizeVideoByModel(entry?.model || "MiniMax-H3-Lite", entry?.videoByModel, entry?.video);
    activeVideoModel = packed.model;
    videoDraftByModel = packed.videoByModel;
    paintVideoTabs(activeVideoModel);
    paintVideoParams(activeVideoModel, videoDraftByModel[activeVideoModel as keyof VideoByModel]);
  }

  function readImageForm(preset: ImagePresetId): ImageModelOptions {
    const sizes = readCheckGroup(imageSizesHost) as ImageSizeTier[];
    const ratios = readCheckGroup(imageRatiosHost) as ImageRatio[];
    const formats = readCheckGroup(imageFormatsHost) as ImageOutputFormat[];
    const backgrounds = readCheckGroup(imageBackgroundsHost) as ImageBackground[];
    const background = readCheckGroupDefault(imageBackgroundsHost) as ImageBackground | undefined;
    const format = readCheckGroupDefault(imageFormatsHost) as ImageOutputFormat | undefined;
    if (backgrounds.includes("transparent") && !formats.includes("png")) {
      throw new Error("透明背景需要同时启用 PNG 格式");
    }
    if (background === "transparent" && format !== "png") {
      throw new Error("透明背景需要选择 PNG");
    }
    const pro = preset === "Doubao-Seedream-5.0-pro";
    const promptModes = pro
      ? (readCheckGroup(imagePromptModesHost) as ImagePromptMode[])
      : (["standard"] as ImagePromptMode[]);
    const promptMode = pro
      ? (readCheckGroupDefault(imagePromptModesHost) as ImagePromptMode | undefined)
      : "standard";
    return normalizeImageModelOptions(preset, {
      sizes,
      ratios,
      formats,
      backgrounds,
      watermark: imageWatermark.checked,
      promptModes,
      size: readCheckGroupDefault(imageSizesHost) as ImageSizeTier | undefined,
      ratio: readCheckGroupDefault(imageRatiosHost) as ImageRatio | undefined,
      format,
      background,
      promptMode,
    });
  }

  function stashActiveImageTab(): void {
    try {
      imageDraftByModel = {
        ...imageDraftByModel,
        [activeImagePreset]: readImageForm(activeImagePreset),
      } as ImageByModel;
      imageModelDraftByPreset = {
        ...imageModelDraftByPreset,
        [activeImagePreset]: modelInput.value.trim(),
      };
    } catch {
      /* keep previous draft for this tab */
    }
  }

  function paintImageParams(preset: ImagePresetId, options?: ImageModelOptions | null): void {
    const opts = normalizeImageModelOptions(preset, options ?? defaultImageModelOptions(preset));
    const row = IMAGE_MODEL_PRESETS.find((item) => item.id === preset) ?? IMAGE_MODEL_PRESETS[0];
    imageBlurb.textContent = imageModelBlurb(preset) || row.blurb;
    paintCheckGroup(
      imageSizesHost,
      "image-size",
      IMAGE_SIZE_OPTIONS.filter((item) => row.sizes.includes(item.value)),
      new Set(opts.sizes),
      opts.size,
      { minOne: true },
    );
    paintCheckGroup(
      imageRatiosHost,
      "image-ratio",
      IMAGE_RATIO_OPTIONS.filter((item) => row.ratios.includes(item.value)),
      new Set(opts.ratios),
      opts.ratio,
      { minOne: true },
    );
    paintCheckGroup(
      imageFormatsHost,
      "image-format",
      IMAGE_FORMAT_OPTIONS.filter((item) => row.formats.includes(item.value)),
      new Set(opts.formats),
      opts.format,
      { minOne: true },
    );
    paintCheckGroup(
      imageBackgroundsHost,
      "image-background",
      IMAGE_BACKGROUND_OPTIONS.filter((item) =>
        (row.backgrounds as readonly string[]).includes(item.value),
      ),
      new Set(opts.backgrounds),
      opts.background,
      { minOne: true },
    );
    imageWatermark.checked = opts.watermark;
    const pro = preset === "Doubao-Seedream-5.0-pro";
    imagePromptGroup.hidden = !pro;
    imagePromptNote.hidden = pro;
    if (pro) {
      paintCheckGroup(
        imagePromptModesHost,
        "image-prompt-mode",
        IMAGE_PROMPT_MODE_OPTIONS.filter((item) =>
          (row.promptModes as readonly string[]).includes(item.value),
        ),
        new Set(opts.promptModes),
        opts.promptMode,
        { minOne: true },
      );
    } else {
      imagePromptModesHost.replaceChildren();
    }
  }

  function paintImageTabs(active: ImagePresetId): void {
    imageTabsHost.replaceChildren();
    for (const preset of IMAGE_MODEL_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = preset.id === active ? "video-option-tab is-active" : "video-option-tab";
      btn.role = "tab";
      btn.dataset.imageModel = preset.id;
      btn.setAttribute("aria-selected", preset.id === active ? "true" : "false");
      btn.title = preset.id;
      btn.textContent = imagePresetLabel(preset.id);
      btn.addEventListener("click", () => {
        if (preset.id === activeImagePreset) return;
        stashActiveImageTab();
        activeImagePreset = preset.id;
        paintImageTabs(activeImagePreset);
        paintImageParams(activeImagePreset, imageDraftByModel[activeImagePreset]);
        modelInput.value = imageModelDraftByPreset[activeImagePreset];
      });
      imageTabsHost.append(btn);
    }
  }

  function loadImageDraft(entry?: StoredModel | null): void {
    const preset =
      parseImagePresetId(entry?.imagePreset) ??
      inferImagePresetFromModel(entry?.model ?? "") ??
      DEFAULT_IMAGE_PRESET;
    const packed = normalizeImageByModel(preset, entry?.imageByModel, entry?.image);
    activeImagePreset = packed.preset;
    imageDraftByModel = packed.imageByModel;
    imageModelDraftByPreset = defaultImageModelIds();
    imageModelDraftByPreset[activeImagePreset] =
      entry?.model?.trim() || imageModelDraftByPreset[activeImagePreset];
    paintImageTabs(activeImagePreset);
    paintImageParams(activeImagePreset, imageDraftByModel[activeImagePreset]);
    modelInput.value = imageModelDraftByPreset[activeImagePreset];
  }

  videoDurationInput.addEventListener("input", () => {
    const { min, max } = durationBounds(activeVideoModel);
    const rangeMax = clampTo(Number(videoDurationInput.value), min, max);
    if (String(rangeMax) !== videoDurationInput.value) videoDurationInput.value = String(rangeMax);
    placeDurationLabels(min, rangeMax);
  });

  /** Search / video / speech kinds need stronger field hints than the empty defaults. */
  function syncKindFields(): void {
    const kind = parseModelKind(kindSelect.value);
    if (lastKind === "image" && kind !== "image") {
      modelInput.value = modelBeforeImage;
    }
    if (kind === "image" && lastKind !== "image" && lastKind !== "video") {
      modelBeforeImage = modelInput.value;
    }
    lastKind = kind;
    const search = kind === "search";
    const video = kind === "video";
    const image = kind === "image";
    const speech = kind === "tts" || kind === "asr";
    const tts = kind === "tts";
    modelInput.placeholder = search
      ? "可留空：搜索接口不使用模型名"
      : tts
        ? "seed-tts-2.0"
        : kind === "asr"
          ? "bigmodel"
          : "";
    baseUrlInput.placeholder = search
      ? "https://api.deepseek.com"
      : image
        ? "https://ark.cn-beijing.volces.com/api/v3"
        : video
          ? "https://api.ppio.com"
          : speech
            ? "（可选）方舟 Plan 地址仅作占位"
            : "";
    modelField.hidden = video;
    videoOptions.hidden = !video;
    imageOptions.hidden = !image;
    if (ttsOptions) ttsOptions.hidden = !tts;
    if (video) {
      if (!baseUrlInput.value.trim()) baseUrlInput.value = "https://api.ppio.com";
      loadVideoDraft();
    }
    if (image) {
      if (!baseUrlInput.value.trim()) {
        baseUrlInput.value = "https://ark.cn-beijing.volces.com/api/v3";
      }
      loadImageDraft();
    }
    if (tts && ttsSpeaker && ttsFormat && ttsSampleRate) {
      if (!ttsSpeaker.value.trim()) ttsSpeaker.value = DEFAULT_TTS.speaker;
      if (!ttsFormat.value) ttsFormat.value = DEFAULT_TTS.format;
      if (!ttsSampleRate.value) ttsSampleRate.value = String(DEFAULT_TTS.sampleRate);
    }
    if (kindHint) {
      kindHint.hidden = !(search || kind === "asr");
      if (search) {
        kindHint.textContent =
          "网搜模型只给 web_search 用，不会出现在输入框的模型选择里。它和对话模型各有一个「当前」，可以同时使用。接口按 DeepSeek 的搜索接口格式请求，Model 可以留空。";
      } else if (kind === "asr") {
        kindHint.textContent =
          "语音识别可作对话模型（上传音频转写），也可点「使用」设为麦克风旁路当前（类似网搜）。麦克风听写写入输入框，不会自动发送。";
      }
    }
    if (videoBaseUrlHint) videoBaseUrlHint.hidden = !video;
    if (imageBaseUrlHint) imageBaseUrlHint.hidden = !image;
    if (speechBaseUrlHint) speechBaseUrlHint.hidden = !speech;
  }

  function paintTtsFields(entry?: StoredModel): void {
    if (!ttsSpeaker || !ttsFormat || !ttsSampleRate) return;
    const opts = normalizeTts(entry?.tts);
    ttsSpeaker.value = opts.speaker;
    ttsFormat.value = opts.format;
    ttsSampleRate.value = String(opts.sampleRate);
  }

  function readTtsFields(): TtsModelOptions {
    return normalizeTts({
      speaker: ttsSpeaker?.value,
      format: ttsFormat?.value === "wav" ? "wav" : "mp3",
      sampleRate: Number(ttsSampleRate?.value),
    });
  }

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = err instanceof Error ? err.message : String(err);
  };

  let formReturnFocus: HTMLElement | null = null;

  function resetForm(): void {
    editing = null;
    form.reset();
    lastKind = "text";
    modelBeforeImage = "";
    formError.hidden = true;
    if (apiKeyToggle) paintSecretReveal(apiKeyInput, apiKeyToggle, false);
    syncKindFields();
    if (formReturnFocus?.isConnected) formReturnFocus.focus();
    formReturnFocus = null;
  }

  function closeForm(): void {
    if (modal.open) modal.close();
    else resetForm();
  }

  function openForm(entry?: StoredModel): void {
    formReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editing = entry?.id ?? null;
    nameInput.value = entry?.name ?? "";
    kindSelect.value = modelKindOf(entry);
    lastKind = modelKindOf(entry);
    modelBeforeImage =
      modelKindOf(entry) === "image" || modelKindOf(entry) === "video"
        ? ""
        : (entry?.model ?? "");
    syncKindFields();
    baseUrlInput.value = entry?.baseUrl ?? "";
    modelInput.value = entry?.model ?? "";
    apiKeyInput.value = entry?.apiKey ?? "";
    if (apiKeyToggle) paintSecretReveal(apiKeyInput, apiKeyToggle, false);
    if (modelKindOf(entry) === "video") {
      loadVideoDraft(entry);
    }
    if (modelKindOf(entry) === "image") {
      loadImageDraft(entry);
    }
    if (modelKindOf(entry) === "tts") {
      paintTtsFields(entry);
    } else {
      paintTtsFields();
    }
    formError.hidden = true;
    modalTitle.textContent = editing ? "编辑模型" : "添加模型";
    if (!modal.open) modal.showModal();
    nameInput.focus();
  }

  function paintPicker(cfg: StoredConfig | null): void {
    // Only the active composer category. Search / ASR never appear here.
    const kind = composerKindOf(cfg);
    const models = modelsForComposerKind(cfg?.models, kind);
    const remembered = cfg?.currentModelByKind?.[kind];
    const currentId = inUseId(models, cfg?.currentModelId ?? remembered) ?? "";
    painting = true;
    select.replaceChildren();
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未配置模型";
      select.append(option);
      select.value = "";
      select.hidden = true;
      select.disabled = true;
      emptyBtn.hidden = false;
    } else {
      for (const entry of models) {
        const option = document.createElement("option");
        option.value = entry.id;
        const entryKind = modelKindOf(entry);
        option.dataset.kind = entryKind;
        // Same category for every option — show name only to keep the control short.
        option.textContent = modelLabel(entry);
        select.append(option);
      }
      select.value = models.some((entry) => entry.id === currentId) ? currentId : models[0]!.id;
      select.hidden = false;
      select.disabled = false;
      emptyBtn.hidden = true;
    }
    // A single candidate reads as plain text, not a one-item dropdown.
    select.classList.toggle("is-static", models.length === 1);
    painting = false;
    fitComposerModelSelect(select);
    fitComposerModelEmpty(emptyBtn);
    window.dispatchEvent(new Event("agent-models-changed"));
  }

  async function loadConfig(): Promise<StoredConfig | null> {
    return ((await window.agent.getConfig()) as StoredConfig | null) ?? null;
  }

  function paintTabs(): void {
    const models = lastCfg?.models ?? [];
    tabsHost.replaceChildren();
    for (const tab of MODELS_TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = tab.id === activeTab ? "models-tab is-active" : "models-tab";
      btn.role = "tab";
      btn.dataset.modelsTab = tab.id;
      btn.setAttribute("aria-selected", tab.id === activeTab ? "true" : "false");
      const label = document.createElement("span");
      label.textContent = tab.label;
      const badge = document.createElement("span");
      badge.className = "models-tab-count";
      badge.textContent = String(modelsForTab(models, tab.id).length);
      btn.append(label, badge);
      btn.addEventListener("click", () => {
        if (tab.id === activeTab) return;
        activeTab = tab.id;
        tabChosen = true;
        // Filtering only: no config write, no picker repaint, no model switch.
        paintTabs();
        paintList();
        focusActiveTab();
      });
      tabsHost.append(btn);
    }
  }

  /** Keep the keyboard on the category row after a repaint. */
  function focusActiveTab(): void {
    tabsHost.querySelector<HTMLButtonElement>(".models-tab.is-active")?.focus({ preventScroll: true });
  }

  /** ← / → on the models page: walk 生文 / 生图 / 语音 / 生视频 / 其他, wrapping at both ends. */
  function cycleTab(step: number): void {
    const at = MODELS_TABS.findIndex((tab) => tab.id === activeTab);
    if (at < 0) return;
    const next = MODELS_TABS[(at + step + MODELS_TABS.length) % MODELS_TABS.length];
    if (!next || next.id === activeTab) return;
    activeTab = next.id;
    tabChosen = true;
    paintTabs();
    paintList();
    focusActiveTab();
  }

  function paintList(): void {
    const cfg = lastCfg;
    const models = cfg?.models ?? [];
    list.replaceChildren();
    if (!models.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty";
      empty.textContent = "还没有配置模型。添加后，可在输入框旁选择，下一轮对话会使用选中的这一条。";
      list.append(empty);
      return;
    }
    const shown = modelsForTab(models, activeTab);
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty";
      const label = MODELS_TABS.find((row) => row.id === activeTab)?.label ?? "";
      empty.textContent =
        activeTab === "other"
          ? "还没有网搜等辅助模型。点右上角 + 添加。"
          : `还没有「${label}」模型。点右上角 + 添加。`;
      list.append(empty);
      return;
    }
    for (const entry of shown) list.append(modelRow(entry, cfg!));
  }

  async function reload(): Promise<void> {
    const cfg = await loadConfig();
    lastCfg = cfg;
    const models = cfg?.models ?? [];
    count.textContent = `已配置(${models.length})`;
    paintPicker(cfg);
    if (!tabChosen) {
      // First open: land on the tab matching the composer's current category.
      const kind = composerKindOf(cfg);
      activeTab = kind === "tts" ? "speech" : kind;
    }
    paintTabs();
    paintList();
  }

  function modelRow(entry: StoredModel, cfg: StoredConfig): HTMLElement {
    // Composer current is scoped to composerKind; search / ASR stay side currents.
    const kind = modelKindOf(entry);
    const isSearch = kind === "search";
    const isAsrSide = kind === "asr";
    const activeKind = composerKindOf(cfg);
    const chatCurrent =
      isComposerKind(kind) &&
      activeKind === kind &&
      entry.id === inUseId(modelsForComposerKind(cfg.models, kind), cfg.currentModelId);
    const searchCurrent = isSearch
      ? entry.id === inUseId(searchModelsOf(cfg.models), cfg.currentSearchModelId)
      : false;
    const asrCurrent = isAsrSide
      ? entry.id === inUseId(asrModelsOf(cfg.models), cfg.currentAsrModelId)
      : false;
    const current = isSearch ? searchCurrent : isAsrSide ? asrCurrent : chatCurrent;
    const row = document.createElement("article");
    row.className = current ? "mcp-row is-current-model" : "mcp-row";
    const main = document.createElement("div");
    main.className = "mcp-row-main";
    const title = document.createElement("div");
    title.className = "mcp-row-title";
    const heading = document.createElement("span");
    heading.className = "mcp-label";
    heading.textContent = modelRowHeading(modelLabel(entry), kindLabelFromSelect(kindSelect, modelKindOf(entry)));
    const modelId = document.createElement("span");
    modelId.className = "mcp-id";
    modelId.textContent = entry.model;
    title.append(heading, modelId);
    if (current) {
      const badge = document.createElement("span");
      badge.className = "mcp-state is-ok";
      badge.textContent = "当前";
      title.append(badge);
    }
    const summary = document.createElement("p");
    summary.className = "mcp-summary";
    const videoLine =
      kind === "video" ? videoOptionsSummary(entry.video ?? defaultVideoModelOptions(entry.model)) : "";
    const imageLine =
      kind === "image"
        ? imageOptionsSummary(
            entry.image ??
              defaultImageModelOptions(
                parseImagePresetId(entry.imagePreset) ??
                  inferImagePresetFromModel(entry.model) ??
                  DEFAULT_IMAGE_PRESET,
              ),
          )
        : "";
    const ttsLine =
      kind === "tts"
        ? `音色 ${normalizeTts(entry.tts).speaker} · ${normalizeTts(entry.tts).format}`
        : "";
    const speechHost =
      kind === "tts" || kind === "asr" ? "openspeech.bytedance.com" : entry.baseUrl || "未填写 Base URL";
    summary.textContent = [speechHost, videoLine, imageLine, ttsLine].filter(Boolean).join(" · ");
    // The row elides long URLs on narrow windows; keep the full value on hover.
    summary.title = summary.textContent;
    if (isAsrSide && asrCurrent) {
      const badge = document.createElement("span");
      badge.className = "mcp-state is-ok";
      badge.textContent = "当前·听写";
      // Replace generic 「当前」 when ASR is the mic side current.
      const existing = title.querySelector(".mcp-state");
      if (existing) existing.replaceWith(badge);
      else title.append(badge);
    }
    const actions = document.createElement("div");
    actions.className = "mcp-actions";
    const hover = document.createElement("div");
    hover.className = "mcp-actions-hover";
    hover.append(
      textButton("复制", () => {
        void run(async () => {
          const cur = (await loadConfig()) ?? emptyConfig();
          const before = new Set((cur.models ?? []).map((row) => row.id));
          const next = duplicateModel(cur, entry.id);
          await persist(next);
          const copied = next.models?.find((row) => !before.has(row.id));
          if (copied) openForm(copied);
        });
      }),
      textButton("修改", () => openForm(entry)),
      textButton("移除", () => {
        void run(async () => {
          if (editing === entry.id) closeForm();
          await deleteModel(entry.id);
        });
      }, true),
    );
    actions.append(hover);
    if (!current) {
      actions.append(
        textButton("使用", () => {
          void run(async () => {
            await selectModel(entry.id);
          });
        }),
      );
    }
    main.append(title, summary, actions);
    row.append(main);
    return row;
  }

  async function persist(next: StoredConfig): Promise<void> {
    await window.agent.saveConfig(next);
    await reload();
  }

  async function selectModel(id: string): Promise<void> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const models = cur.models ?? [];
    const chosen = models.find((entry) => entry.id === id);
    if (!chosen) throw new Error("找不到这个模型");
    if (modelKindOf(chosen) === "search") {
      // Only web_search's model changes. The composer model stays exactly as it was.
      await persist({ ...cur, models, currentSearchModelId: chosen.id });
      return;
    }
    if (modelKindOf(chosen) === "asr") {
      // Mic side current only — does not switch composerKind.
      await persist({
        ...cur,
        models,
        currentAsrModelId: chosen.id,
      });
      return;
    }
    const kind = modelKindOf(chosen);
    if (!isComposerKind(kind)) throw new Error("请选择 Chat / 生图 / 合成语音 / 生视频 模型");
    const byKind = { ...(cur.currentModelByKind ?? {}), [kind]: chosen.id };
    await persist({
      ...cur,
      models,
      composerKind: kind,
      currentModelByKind: byKind,
      currentModelId: chosen.id,
      baseUrl: chosen.baseUrl,
      model: chosen.model,
      apiKey: chosen.apiKey,
    });
  }

  async function setComposerKind(kind: ComposerKind): Promise<ComposerKind> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const parsed = parseComposerKind(kind);
    const models = cur.models ?? [];
    const pool = modelsForComposerKind(models, parsed);
    const byKind = { ...(cur.currentModelByKind ?? {}) };
    let id = byKind[parsed];
    if (!id || !pool.some((entry) => entry.id === id)) id = pool[0]?.id;
    if (id) byKind[parsed] = id;
    const chosen = pool.find((entry) => entry.id === id);
    await persist({
      ...cur,
      models,
      composerKind: parsed,
      currentModelByKind: byKind,
      currentModelId: chosen?.id,
      baseUrl: chosen?.baseUrl ?? "",
      model: chosen?.model ?? "",
      apiKey: chosen?.apiKey ?? "",
    });
    return parsed;
  }

  async function resetComposerKindToChat(): Promise<void> {
    await setComposerKind("text");
  }

  async function deleteModel(id: string): Promise<void> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const models = (cur.models ?? []).filter((entry) => entry.id !== id);
    const kind = composerKindOf({ ...cur, models });
    const pool = modelsForComposerKind(models, kind);
    const byKind = { ...(cur.currentModelByKind ?? {}) };
    delete byKind[kind];
    for (const key of COMPOSER_KINDS) {
      if (byKind[key] && !models.some((entry) => entry.id === byKind[key])) delete byKind[key];
    }
    const chosen = pool.find((entry) => entry.id === cur.currentModelId) ?? pool[0];
    if (chosen) byKind[kind] = chosen.id;
    await persist({
      ...cur,
      models,
      composerKind: kind,
      currentModelByKind: byKind,
      currentModelId: chosen?.id,
      baseUrl: chosen?.baseUrl ?? "",
      model: chosen?.model ?? "",
      apiKey: chosen?.apiKey ?? "",
      currentSearchModelId: inUseId(searchModelsOf(models), cur.currentSearchModelId),
      currentAsrModelId: inUseId(asrModelsOf(models), cur.currentAsrModelId),
    });
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      note.hidden = true;
    } catch (err) {
      showNote(err);
    }
  }

  // Form errors must show inside the modal: the page note sits behind the backdrop.
  async function runForm(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      formError.hidden = true;
    } catch (err) {
      formError.hidden = false;
      formError.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  button.onclick = () => {
    if (!page.hidden) {
      // Keep an open add/edit form as-is. Closing it here would surprise the user
      // when they reopen the page and find the draft gone.
      host.onClose();
      return;
    }
    note.hidden = true;
    host.onOpen();
    void reload().catch(showNote);
  };

  addBtn.onclick = () => {
    if (page.hidden) {
      note.hidden = true;
      host.onOpen();
      void reload().catch(showNote);
    }
    openForm();
  };

  cancelBtn.onclick = () => closeForm();
  modalClose.addEventListener("click", () => closeForm());
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeForm();
  });
  // Esc fires cancel on a native dialog. Clean up before it closes so focus can
  // return to the button behind the modal.
  modal.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeForm();
  });
  kindSelect.addEventListener("change", syncKindFields);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void runForm(async () => {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const kind = parseModelKind(kindSelect.value);
      let model = modelInput.value.trim();
      let video: VideoModelOptions | undefined;
      let videoByModel: VideoByModel | undefined;
      let tts: TtsModelOptions | undefined;
      let image: ImageModelOptions | undefined;
      let imageByModel: ImageByModel | undefined;
      let imagePreset: ImagePresetId | undefined;
      if (kind === "video") {
        stashActiveVideoTab();
        const packed = normalizeVideoByModel(activeVideoModel, videoDraftByModel, videoDraftByModel[activeVideoModel as keyof VideoByModel]);
        model = packed.model;
        video = packed.video;
        videoByModel = packed.videoByModel;
      }
      if (kind === "image") {
        const activeOptions = readImageForm(activeImagePreset);
        const packed = normalizeImageByModel(
          activeImagePreset,
          { ...imageDraftByModel, [activeImagePreset]: activeOptions },
          activeOptions,
        );
        imagePreset = packed.preset;
        image = packed.image;
        imageByModel = packed.imageByModel;
        model = modelInput.value.trim() || imageModelDraftByPreset[activeImagePreset];
      }
      if (kind === "tts") {
        tts = readTtsFields();
        if (!model) model = "seed-tts-2.0";
      }
      if (kind === "asr" && !model) model = "bigmodel";
      const apiKey = apiKeyInput.value.trim();
      if (!name) throw new Error("请填写显示名");
      const speech = kind === "tts" || kind === "asr";
      if (!speech && !baseUrl) throw new Error("请填写 Base URL");
      // The search API takes no model name, but it cannot work without a key.
      if (kind !== "search" && !model) throw new Error("请填写 Model");
      if (kind === "search" && !apiKey) throw new Error("网搜模型需要填写 API Key");
      if (speech && !apiKey) throw new Error("语音模型需要填写豆包语音专属 API Key");
      const cur = (await loadConfig()) ?? emptyConfig();
      const models = [...(cur.models ?? [])];
      const id = editing ?? newModelId();
      const entry: StoredModel = {
        id,
        name,
        baseUrl,
        model,
        apiKey,
        kind,
        ...(video ? { video, videoByModel } : {}),
        ...(tts ? { tts } : {}),
        ...(image ? { image, imageByModel, imagePreset } : {}),
      };
      const index = models.findIndex((item) => item.id === id);
      if (index >= 0) models[index] = entry;
      else models.push(entry);
      // A new chat model becomes current when none is. A search model never takes over as the chat model.
      const chat = chatModelsOf(models);
      const chosen = chat.find((item) => item.id === cur.currentModelId) ?? (kind === "search" ? chat[0] : entry);
      // Show the saved entry: jump the library list to its tab.
      activeTab = modelsTabOfKind(kind);
      tabChosen = true;
      await persist({
        ...cur,
        models,
        currentModelId: chosen?.id,
        baseUrl: chosen?.baseUrl ?? "",
        model: chosen?.model ?? "",
        apiKey: chosen?.apiKey ?? "",
        currentSearchModelId: inUseId(searchModelsOf(models), cur.currentSearchModelId),
        currentAsrModelId:
          kind === "asr"
            ? inUseId(asrModelsOf(models), cur.currentAsrModelId ?? entry.id)
            : inUseId(asrModelsOf(models), cur.currentAsrModelId),
      });
      closeForm();
    });
  });

  select.addEventListener("change", () => {
    if (painting) return;
    const id = select.value;
    if (!id) return;
    void run(async () => {
      await selectModel(id);
    });
  });

  emptyBtn.addEventListener("click", () => {
    note.hidden = true;
    host.onOpen();
    void reload().catch(showNote);
  });

  attachComposerModelSizing(select);

  return {
    reload: () => reload().catch(showNote),
    isFormOpen: () => modal.open,
    cancelForm: () => {
      if (modal.open) closeForm();
    },
    setComposerKind,
    resetComposerKindToChat,
    composerKind: async () => composerKindOf(await loadConfig()),
    loadConfig,
    cycleTab,
  };
}
