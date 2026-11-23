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

type ModelKind = "text" | "image" | "video" | "tts" | "asr" | "search";

const MODEL_KINDS: readonly ModelKind[] = ["text", "image", "video", "tts", "asr", "search"];

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
};

type StoredConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: StoredModel[];
  currentModelId?: string;
  /** web_search's model. Separate from currentModelId: both are in use at the same time. */
  currentSearchModelId?: string;
  /** Mic dictation's ASR model. Separate from currentModelId. */
  currentAsrModelId?: string;
  [key: string]: unknown;
};

export type KindedModel = { id: string; kind?: unknown };

/** Models the composer picker lists. Search models are left out: they only serve web_search. */
export function chatModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) !== "search");
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
} {
  const list = page.querySelector("#models-list") as HTMLElement;
  const note = page.querySelector("#models-note") as HTMLElement;
  const count = page.querySelector("#models-count") as HTMLElement;
  const addBtn = page.querySelector("#models-add") as HTMLButtonElement;
  const form = page.querySelector("#models-form") as HTMLFormElement;
  const nameInput = page.querySelector("#model-name") as HTMLInputElement;
  const kindSelect = page.querySelector("#model-kind") as HTMLSelectElement;
  const baseUrlInput = page.querySelector("#model-baseUrl") as HTMLInputElement;
  const modelField = page.querySelector("#model-model-field") as HTMLElement;
  const modelInput = page.querySelector("#model-model") as HTMLInputElement;
  const apiKeyInput = page.querySelector("#model-apiKey") as HTMLInputElement;
  const cancelBtn = page.querySelector("#models-cancel") as HTMLButtonElement;
  const kindHint = page.querySelector("#model-kind-hint") as HTMLElement | null;
  const videoBaseUrlHint = page.querySelector("#model-video-baseurl-hint") as HTMLElement | null;
  const speechBaseUrlHint = page.querySelector("#model-speech-baseurl-hint") as HTMLElement | null;
  const ttsOptions = page.querySelector("#model-tts-options") as HTMLElement | null;
  const ttsSpeaker = page.querySelector("#model-tts-speaker") as HTMLInputElement | null;
  const ttsFormat = page.querySelector("#model-tts-format") as HTMLSelectElement | null;
  const ttsSampleRate = page.querySelector("#model-tts-sample-rate") as HTMLInputElement | null;
  const videoOptions = page.querySelector("#model-video-options") as HTMLElement;
  const videoTabsHost = page.querySelector("#model-video-tabs") as HTMLElement;
  const videoModesHost = page.querySelector("#model-video-modes") as HTMLElement;
  const videoResolutionsHost = page.querySelector("#model-video-resolutions") as HTMLElement;
  const videoDurationInput = page.querySelector("#model-video-duration") as HTMLInputElement;
  const videoDurationMinLabel = page.querySelector("#model-video-duration-min") as HTMLElement;
  const videoDurationValue = page.querySelector("#model-video-duration-value") as HTMLElement;
  const videoBlurb = page.querySelector("#model-video-blurb") as HTMLElement;
  const videoRatiosHost = page.querySelector("#model-video-ratios") as HTMLElement;

  let editing: string | null = null;
  let painting = false;
  let activeVideoModel = "MiniMax-H3-Lite";
  let videoDraftByModel: VideoByModel = defaultVideoByModel();

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

  videoDurationInput.addEventListener("input", () => {
    const { min, max } = durationBounds(activeVideoModel);
    const rangeMax = clampTo(Number(videoDurationInput.value), min, max);
    if (String(rangeMax) !== videoDurationInput.value) videoDurationInput.value = String(rangeMax);
    placeDurationLabels(min, rangeMax);
  });

  /** Search / video / speech kinds need stronger field hints than the empty defaults. */
  function syncKindFields(): void {
    const kind = parseModelKind(kindSelect.value);
    const search = kind === "search";
    const video = kind === "video";
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
      : video
        ? "https://api.ppio.com"
        : speech
          ? "（可选）方舟 Plan 地址仅作占位"
          : "";
    modelField.hidden = video;
    videoOptions.hidden = !video;
    if (ttsOptions) ttsOptions.hidden = !tts;
    if (video) {
      if (!baseUrlInput.value.trim()) baseUrlInput.value = "https://api.ppio.com";
      loadVideoDraft();
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

  function closeForm(): void {
    editing = null;
    form.hidden = true;
    form.reset();
    syncKindFields();
  }

  function openForm(entry?: StoredModel): void {
    editing = entry?.id ?? null;
    nameInput.value = entry?.name ?? "";
    kindSelect.value = modelKindOf(entry);
    syncKindFields();
    baseUrlInput.value = entry?.baseUrl ?? "";
    modelInput.value = entry?.model ?? "";
    apiKeyInput.value = entry?.apiKey ?? "";
    if (modelKindOf(entry) === "video") {
      loadVideoDraft(entry);
    }
    if (modelKindOf(entry) === "tts") {
      paintTtsFields(entry);
    } else {
      paintTtsFields();
    }
    form.hidden = false;
    nameInput.focus();
  }

  function paintPicker(cfg: StoredConfig | null): void {
    // Search models never appear here: they only serve web_search and have their own "use" in the models page.
    const models = chatModelsOf(cfg?.models);
    const currentId = inUseId(models, cfg?.currentModelId) ?? "";
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
        const kind = modelKindOf(entry);
        option.dataset.kind = kind;
        option.textContent = composerModelOptionText(modelLabel(entry), kindLabelFromSelect(kindSelect, kind));
        select.append(option);
      }
      select.value = models.some((entry) => entry.id === currentId) ? currentId : models[0]!.id;
      select.hidden = false;
      select.disabled = false;
      emptyBtn.hidden = true;
    }
    painting = false;
    fitComposerModelSelect(select);
    fitComposerModelEmpty(emptyBtn);
    window.dispatchEvent(new Event("agent-models-changed"));
  }

  async function loadConfig(): Promise<StoredConfig | null> {
    return ((await window.agent.getConfig()) as StoredConfig | null) ?? null;
  }

  async function reload(): Promise<void> {
    const cfg = await loadConfig();
    const models = cfg?.models ?? [];
    count.textContent = `已配置(${models.length})`;
    paintPicker(cfg);
    list.replaceChildren();
    if (!models.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty";
      empty.textContent = "还没有配置模型。添加后，可在输入框旁选择，下一轮对话会使用选中的这一条。";
      list.append(empty);
      return;
    }
    for (const entry of models) list.append(modelRow(entry, cfg!));
  }

  function modelRow(entry: StoredModel, cfg: StoredConfig): HTMLElement {
    // Search and ASR each have a side "current" besides the chat model.
    const kind = modelKindOf(entry);
    const isSearch = kind === "search";
    const isAsrSide = kind === "asr";
    const chatCurrent = entry.id === inUseId(chatModelsOf(cfg.models), cfg.currentModelId);
    const searchCurrent = isSearch
      ? entry.id === inUseId(searchModelsOf(cfg.models), cfg.currentSearchModelId)
      : false;
    const asrCurrent = isAsrSide
      ? entry.id === inUseId(asrModelsOf(cfg.models), cfg.currentAsrModelId)
      : false;
    const current = isSearch ? searchCurrent : isAsrSide ? asrCurrent || chatCurrent : chatCurrent;
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
    const ttsLine =
      kind === "tts"
        ? `音色 ${normalizeTts(entry.tts).speaker} · ${normalizeTts(entry.tts).format}`
        : "";
    const speechHost =
      kind === "tts" || kind === "asr" ? "openspeech.bytedance.com" : entry.baseUrl || "未填写 Base URL";
    summary.textContent = [speechHost, videoLine, ttsLine].filter(Boolean).join(" · ");
    if (isAsrSide && asrCurrent) {
      const badge = document.createElement("span");
      badge.className = "mcp-state is-ok";
      badge.textContent = chatCurrent ? "当前·对话/听写" : "当前·听写";
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
      // Only web_search's model changes. The chat model stays exactly as it was.
      await persist({ ...cur, models, currentSearchModelId: chosen.id });
      return;
    }
    if (modelKindOf(chosen) === "asr") {
      // Mic side current. Also becomes the chat model when used from the list (upload ASR).
      await persist({
        ...cur,
        models,
        currentAsrModelId: chosen.id,
        currentModelId: chosen.id,
        baseUrl: chosen.baseUrl,
        model: chosen.model,
        apiKey: chosen.apiKey,
      });
      return;
    }
    await persist({
      ...cur,
      models,
      currentModelId: chosen.id,
      baseUrl: chosen.baseUrl,
      model: chosen.model,
      apiKey: chosen.apiKey,
    });
  }

  async function deleteModel(id: string): Promise<void> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const models = (cur.models ?? []).filter((entry) => entry.id !== id);
    // The chat model and the search model are picked from their own pools.
    const chat = chatModelsOf(models);
    const chosen = chat.find((entry) => entry.id === cur.currentModelId) ?? chat[0];
    await persist({
      ...cur,
      models,
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
  kindSelect.addEventListener("change", syncKindFields);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void run(async () => {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const kind = parseModelKind(kindSelect.value);
      let model = modelInput.value.trim();
      let video: VideoModelOptions | undefined;
      let videoByModel: VideoByModel | undefined;
      let tts: TtsModelOptions | undefined;
      if (kind === "video") {
        stashActiveVideoTab();
        const packed = normalizeVideoByModel(activeVideoModel, videoDraftByModel, videoDraftByModel[activeVideoModel as keyof VideoByModel]);
        model = packed.model;
        video = packed.video;
        videoByModel = packed.videoByModel;
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
      };
      const index = models.findIndex((item) => item.id === id);
      if (index >= 0) models[index] = entry;
      else models.push(entry);
      // A new chat model becomes current when none is. A search model never takes over as the chat model.
      const chat = chatModelsOf(models);
      const chosen = chat.find((item) => item.id === cur.currentModelId) ?? (kind === "search" ? chat[0] : entry);
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
    isFormOpen: () => !form.hidden,
    cancelForm: () => {
      if (!form.hidden) closeForm();
    },
  };
}
