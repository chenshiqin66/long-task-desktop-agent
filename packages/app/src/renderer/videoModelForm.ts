/**
 * Mirrors `@agent/core` videoOptions for the sandboxed renderer (no Node / package imports).
 * Keep catalogs and rules in sync when the PPIO H3 contract changes.
 */

export type VideoResolution = "480P" | "768P" | "2K";
export type VideoRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive";
export type VideoGenMode = "text" | "first_frame" | "last_frame" | "first_last" | "reference";

export type VideoModelOptions = {
  modes: VideoGenMode[];
  resolutions: VideoResolution[];
  durations: number[];
  ratios: VideoRatio[];
  mode: VideoGenMode;
  resolution: VideoResolution;
  duration: number;
  ratio: VideoRatio;
};

export const VIDEO_MODEL_PRESETS = [
  {
    id: "MiniMax-H3-Lite",
    resolutions: ["480P", "768P"] as const,
    durationMin: 4,
    durationMax: 15,
    blurb:
      "轻量低价，完整 H3 能力面，适合试提示词、分镜试错与批量生成。480P ¥0.16/秒 · 768P ¥0.26/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3-Highspeed",
    resolutions: ["480P", "768P"] as const,
    durationMin: 4,
    durationMax: 15,
    blurb:
      "质量与速度均衡，日常高频出片首选。480P ¥0.26/秒 · 768P ¥0.40/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3-Max",
    resolutions: ["480P", "768P"] as const,
    durationMin: 5,
    durationMax: 15,
    blurb:
      "多素材扩展档：图 / 视频 / 音频参考组合创作。480P ¥0.33/秒 · 768P ¥0.50/秒；输入图仅前 2 张免费；时长 5–15 秒。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3",
    resolutions: ["768P", "2K"] as const,
    durationMin: 4,
    durationMax: 15,
    blurb:
      "旗舰画质，支持 2K，适合成片与高品质创作。768P ¥0.50/秒 · 2K ¥0.80/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
] as const;

export const VIDEO_GEN_MODE_OPTIONS: ReadonlyArray<{ value: VideoGenMode; label: string }> = [
  { value: "text", label: "文生视频" },
  { value: "first_frame", label: "图生视频 · 首帧" },
  { value: "last_frame", label: "图生视频 · 尾帧" },
  { value: "first_last", label: "图生视频 · 首尾帧" },
  { value: "reference", label: "参考素材生视频" },
];

export const VIDEO_RATIO_OPTIONS: ReadonlyArray<{ value: VideoRatio; label: string }> = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "21:9", label: "21:9" },
  { value: "adaptive", label: "adaptive" },
];

const ALIASES: Record<string, string> = {
  "minimax h3": "MiniMax-H3",
  "minimax-h3": "MiniMax-H3",
  "minimax h3 lite": "MiniMax-H3-Lite",
  "minimax-h3-lite": "MiniMax-H3-Lite",
  "minimax h3 max": "MiniMax-H3-Max",
  "minimax-h3-max": "MiniMax-H3-Max",
  "minimax h3 highspeed": "MiniMax-H3-Highspeed",
  "minimax-h3-highspeed": "MiniMax-H3-Highspeed",
};

export function normalizeVideoModelId(model: string): string {
  const raw = model.trim();
  if (!raw) return raw;
  const key = raw.toLowerCase().replace(/[_]+/g, "-").replace(/\s+/g, " ").trim();
  const compact = key.replace(/[\s-]+/g, "");
  const byCompact: Record<string, string> = {
    minimaxh3: "MiniMax-H3",
    minimaxh3lite: "MiniMax-H3-Lite",
    minimaxh3max: "MiniMax-H3-Max",
    minimaxh3highspeed: "MiniMax-H3-Highspeed",
  };
  return ALIASES[key] ?? byCompact[compact] ?? raw;
}

export function videoPresetOf(model: string) {
  const id = normalizeVideoModelId(model);
  return VIDEO_MODEL_PRESETS.find((row) => row.id === id);
}

export function durationChoicesOf(model: string): number[] {
  const preset = videoPresetOf(model) ?? VIDEO_MODEL_PRESETS[0]!;
  const out: number[] = [];
  for (let n = preset.durationMin; n <= preset.durationMax; n++) out.push(n);
  return out;
}

function uniquePreserve<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function pickPreferred<T>(enabled: readonly T[], preferred: T | undefined, fallback: readonly T[]): T {
  if (preferred !== undefined && enabled.includes(preferred)) return preferred;
  for (const item of fallback) {
    if (enabled.includes(item)) return item;
  }
  return enabled[0]!;
}

export function defaultVideoModelOptions(model: string): VideoModelOptions {
  const id = normalizeVideoModelId(model) || "MiniMax-H3-Lite";
  const preset = videoPresetOf(id) ?? VIDEO_MODEL_PRESETS[0]!;
  const resolution = id === "MiniMax-H3" ? "768P" : "480P";
  const preferredResolution = (preset.resolutions as readonly string[]).includes(resolution)
    ? (resolution as VideoResolution)
    : preset.resolutions[0]!;
  return {
    modes: VIDEO_GEN_MODE_OPTIONS.map((row) => row.value),
    resolutions: [...preset.resolutions],
    durations: durationChoicesOf(id),
    ratios: VIDEO_RATIO_OPTIONS.map((row) => row.value),
    mode: "text",
    resolution: preferredResolution,
    duration: preset.durationMin,
    ratio: "16:9",
  };
}

export type VideoByModel = Record<(typeof VIDEO_MODEL_PRESETS)[number]["id"], VideoModelOptions>;

export function defaultVideoByModel(): VideoByModel {
  const out = {} as VideoByModel;
  for (const preset of VIDEO_MODEL_PRESETS) {
    out[preset.id] = defaultVideoModelOptions(preset.id);
  }
  return out;
}

export function videoTabLabel(modelId: string): string {
  switch (normalizeVideoModelId(modelId)) {
    case "MiniMax-H3-Lite":
      return "Lite";
    case "MiniMax-H3-Highspeed":
      return "Highspeed";
    case "MiniMax-H3-Max":
      return "Max";
    case "MiniMax-H3":
      return "H3";
    default:
      return modelId;
  }
}

export function videoModelBlurb(modelId: string): string {
  return videoPresetOf(modelId)?.blurb ?? "";
}

export function normalizeVideoByModel(
  activeModel: string,
  videoByModelRaw?: Partial<Record<string, VideoModelOptions>> | null,
  activeVideo?: Partial<VideoModelOptions> | null,
): { model: string; video: VideoModelOptions; videoByModel: VideoByModel } {
  const active = normalizeVideoModelId(activeModel) || "MiniMax-H3-Lite";
  const model = VIDEO_MODEL_PRESETS.some((row) => row.id === active) ? active : "MiniMax-H3-Lite";
  const map = defaultVideoByModel();
  if (videoByModelRaw) {
    for (const preset of VIDEO_MODEL_PRESETS) {
      const raw = videoByModelRaw[preset.id];
      if (raw) {
        try {
          map[preset.id] = normalizeVideoModelOptions(preset.id, raw);
        } catch {
          map[preset.id] = defaultVideoModelOptions(preset.id);
        }
      }
    }
  }
  if (activeVideo) {
    try {
      map[model as keyof VideoByModel] = normalizeVideoModelOptions(model, activeVideo);
    } catch {
      /* keep */
    }
  }
  return { model, video: map[model as keyof VideoByModel], videoByModel: map };
}

export function normalizeVideoModelOptions(
  model: string,
  raw?: Partial<VideoModelOptions> | null,
): VideoModelOptions {
  const id = normalizeVideoModelId(model);
  if (!id) throw new Error("请选择生视频模型");
  const preset = videoPresetOf(id);
  if (!preset) throw new Error(`不支持的模型 ${id}，请选择列表中的 MiniMax H3 型号`);
  const defaults = defaultVideoModelOptions(id);

  const modes = uniquePreserve(raw?.modes?.length ? raw.modes : defaults.modes).filter((m) =>
    VIDEO_GEN_MODE_OPTIONS.some((row) => row.value === m),
  );
  if (!modes.length) throw new Error("请至少勾选一种素材模式");

  const resolutions = uniquePreserve(raw?.resolutions?.length ? raw.resolutions : defaults.resolutions).filter(
    (r) => (preset.resolutions as readonly string[]).includes(r),
  );
  if (!resolutions.length) {
    throw new Error(`${id} 请至少勾选一种分辨率（${preset.resolutions.join("、")}）`);
  }

  const durations = uniquePreserve(raw?.durations?.length ? raw.durations : defaults.durations)
    .map((n) => Math.round(n))
    .filter((n) => n >= preset.durationMin && n <= preset.durationMax)
    .sort((a, b) => a - b);
  if (!durations.length) {
    throw new Error(`${id} 请至少勾选一个时长（${preset.durationMin}–${preset.durationMax} 秒）`);
  }

  const ratios = uniquePreserve(raw?.ratios?.length ? raw.ratios : defaults.ratios).filter((r) =>
    VIDEO_RATIO_OPTIONS.some((row) => row.value === r),
  );
  if (!ratios.length) throw new Error("请至少勾选一种画幅");
  if (modes.includes("text") && !ratios.some((r) => r !== "adaptive")) {
    throw new Error("已启用文生视频时，请至少勾选一种非 adaptive 画幅");
  }
  if (modes.includes("reference") && id === "MiniMax-H3-Lite" && !ratios.some((r) => r !== "adaptive")) {
    throw new Error("MiniMax-H3-Lite 参考素材模式需要至少一种非 adaptive 画幅");
  }

  return {
    modes,
    resolutions,
    durations,
    ratios,
    mode: pickPreferred(modes, raw?.mode, ["text", "first_frame", "last_frame", "first_last", "reference"]),
    resolution: pickPreferred(resolutions, raw?.resolution, [defaults.resolution, ...preset.resolutions]),
    duration: pickPreferred(durations, raw?.duration, [defaults.duration, ...durations]),
    ratio: pickPreferred(ratios, raw?.ratio, ["16:9", ...VIDEO_RATIO_OPTIONS.map((row) => row.value)]),
  };
}

export function fillSelect(
  select: HTMLSelectElement,
  options: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
): void {
  select.replaceChildren();
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.append(el);
  }
  select.value = options.some((row) => row.value === selected) ? selected : options[0]?.value ?? "";
}

function syncDefaultRadios(host: HTMLElement): void {
  const checks = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const radios = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const enabled = new Set(checks.filter((input) => input.checked).map((input) => input.value));
  for (const radio of radios) {
    radio.disabled = !enabled.has(radio.value);
  }
  let current = radios.find((radio) => radio.checked && !radio.disabled);
  if (!current) {
    const fallback = radios.find((radio) => !radio.disabled);
    if (fallback) {
      fallback.checked = true;
      fallback.disabled = false;
      const check = checks.find((input) => input.value === fallback.value);
      if (check) check.checked = true;
      current = fallback;
    }
  }
  for (const node of Array.from(host.querySelectorAll(".video-check"))) {
    const label = node as HTMLElement;
    const radio = label.querySelector("input[type=\"radio\"]") as HTMLInputElement | null;
    label.classList.toggle("is-default", Boolean(current && radio?.value === current.value && radio.checked));
  }
}

/** Checkbox = available; radio = default among checked. */
export function paintCheckGroup(
  host: HTMLElement,
  name: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  checked: ReadonlySet<string>,
  preferred: string,
  opts?: { minOne?: boolean },
): void {
  host.replaceChildren();
  const defaultName = `${name}-default`;
  const preferredValue = checked.has(preferred)
    ? preferred
    : options.find((row) => checked.has(row.value))?.value ?? options[0]?.value ?? "";
  for (const option of options) {
    const label = document.createElement("label");
    label.className = "video-check";
    const enable = document.createElement("input");
    enable.type = "checkbox";
    enable.name = name;
    enable.value = option.value;
    enable.checked = checked.has(option.value);
    enable.title = "启用（聊天可选）";
    enable.addEventListener("change", () => {
      if (!enable.checked && opts?.minOne) {
        const stillChecked = host.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]:checked',
        ).length;
        if (stillChecked === 0) {
          enable.checked = true;
          return;
        }
      }
      if (!enable.checked) {
        const radio = label.querySelector<HTMLInputElement>('input[type="radio"]');
        if (radio?.checked) radio.checked = false;
      } else {
        // First enable in an empty group becomes default.
        const anyDefault = host.querySelector<HTMLInputElement>(
          `input[type="radio"]:checked:not(:disabled)`,
        );
        if (!anyDefault) {
          const radio = label.querySelector<HTMLInputElement>('input[type="radio"]');
          if (radio) radio.checked = true;
        }
      }
      syncDefaultRadios(host);
    });
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = defaultName;
    radio.value = option.value;
    radio.checked = option.value === preferredValue;
    radio.title = "设为默认";
    radio.addEventListener("change", () => {
      if (radio.checked) {
        enable.checked = true;
        syncDefaultRadios(host);
      }
    });
    const text = document.createElement("span");
    text.className = "video-check-label";
    text.textContent = option.label;
    label.append(enable, radio, text);
    host.append(label);
  }
  syncDefaultRadios(host);
}

export function readCheckGroup(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(
    (input) => input.value,
  );
}

export function readCheckGroupDefault(host: HTMLElement): string | undefined {
  const selected = host.querySelector<HTMLInputElement>('input[type="radio"]:checked:not(:disabled)');
  if (selected) return selected.value;
  return readCheckGroup(host)[0];
}

export function videoOptionsSummary(video: VideoModelOptions | undefined): string {
  if (!video) return "";
  const mode = VIDEO_GEN_MODE_OPTIONS.find((row) => row.value === video.mode)?.label ?? video.mode;
  const modeCount = video.modes?.length ?? 0;
  const resCount = video.resolutions?.length ?? 0;
  const durCount = video.durations?.length ?? 0;
  const ratioCount = video.ratios?.length ?? 0;
  if (modeCount || resCount || durCount || ratioCount) {
    return `默认 ${mode} · ${video.resolution} · ${video.duration}s · ${video.ratio}（可选 ${modeCount}/${resCount}/${durCount}/${ratioCount}）`;
  }
  return `${video.resolution} · ${video.duration}s · ${video.ratio} · ${mode}`;
}
