import {
  defaultVideoDuration,
  defaultVideoResolution,
  normalizeVideoModelId,
  type VideoRatio,
  type VideoResolution,
} from "../provider/videoGeneration.js";

/** How this video model expects multimodal input (settings enable set; chat picks one later). */
export const VIDEO_GEN_MODES = ["text", "first_frame", "last_frame", "first_last", "reference"] as const;
export type VideoGenMode = (typeof VIDEO_GEN_MODES)[number];

export const VIDEO_GEN_MODE_LABELS: Record<VideoGenMode, string> = {
  text: "文生视频",
  first_frame: "图生视频 · 首帧",
  last_frame: "图生视频 · 尾帧",
  first_last: "图生视频 · 首尾帧",
  reference: "参考素材生视频",
};

export const VIDEO_RATIOS: readonly VideoRatio[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
  "adaptive",
];

export const VIDEO_MODEL_PRESETS = [
  {
    id: "MiniMax-H3-Lite",
    label: "MiniMax-H3-Lite",
    resolutions: ["480P", "768P"] as const satisfies readonly VideoResolution[],
    durationMin: 4,
    durationMax: 15,
    blurb:
      "轻量低价，完整 H3 能力面，适合试提示词、分镜试错与批量生成。480P ¥0.16/秒 · 768P ¥0.26/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3-Highspeed",
    label: "MiniMax-H3-Highspeed",
    resolutions: ["480P", "768P"] as const satisfies readonly VideoResolution[],
    durationMin: 4,
    durationMax: 15,
    blurb:
      "质量与速度均衡，日常高频出片首选。480P ¥0.26/秒 · 768P ¥0.40/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3-Max",
    label: "MiniMax-H3-Max",
    resolutions: ["480P", "768P"] as const satisfies readonly VideoResolution[],
    durationMin: 5,
    durationMax: 15,
    blurb:
      "多素材扩展档：图 / 视频 / 音频参考组合创作。480P ¥0.33/秒 · 768P ¥0.50/秒；输入图仅前 2 张免费；时长 5–15 秒。价格以派欧云账单为准。",
  },
  {
    id: "MiniMax-H3",
    label: "MiniMax-H3",
    resolutions: ["768P", "2K"] as const satisfies readonly VideoResolution[],
    durationMin: 4,
    durationMax: 15,
    blurb:
      "旗舰画质，支持 2K，适合成片与高品质创作。768P ¥0.50/秒 · 2K ¥0.80/秒；输入图前 5 张免费。价格以派欧云账单为准。",
  },
] as const;

export type VideoModelPresetId = (typeof VIDEO_MODEL_PRESETS)[number]["id"];

export type VideoByModel = Record<VideoModelPresetId, VideoModelOptions>;

/**
 * Enabled option sets for the chat UI, plus preferred singles used until chat overrides.
 * `modes` / `resolutions` / `durations` / `ratios` default to all legal values checked.
 */
export interface VideoModelOptions {
  modes: VideoGenMode[];
  resolutions: VideoResolution[];
  durations: number[];
  ratios: VideoRatio[];
  mode: VideoGenMode;
  resolution: VideoResolution;
  duration: number;
  ratio: VideoRatio;
}

export interface VideoModelConstraints {
  resolutions: readonly VideoResolution[];
  durationMin: number;
  durationMax: number;
  /** Lite reference mode forbids adaptive. */
  adaptiveAllowed: boolean;
}

export function videoPresetOf(model: string): (typeof VIDEO_MODEL_PRESETS)[number] | undefined {
  const id = normalizeVideoModelId(model);
  return VIDEO_MODEL_PRESETS.find((row) => row.id === id);
}

export function videoConstraintsOf(model: string): VideoModelConstraints {
  const preset = videoPresetOf(model);
  const id = normalizeVideoModelId(model);
  if (preset) {
    return {
      resolutions: preset.resolutions,
      durationMin: preset.durationMin,
      durationMax: preset.durationMax,
      adaptiveAllowed: id !== "MiniMax-H3-Lite",
    };
  }
  return {
    resolutions: ["480P", "768P", "2K"],
    durationMin: 4,
    durationMax: 15,
    adaptiveAllowed: true,
  };
}

export function durationChoicesOf(model: string): number[] {
  const { durationMin, durationMax } = videoConstraintsOf(model);
  const out: number[] = [];
  for (let n = durationMin; n <= durationMax; n++) out.push(n);
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

function parseMode(raw: unknown): VideoGenMode | undefined {
  return typeof raw === "string" && (VIDEO_GEN_MODES as readonly string[]).includes(raw)
    ? (raw as VideoGenMode)
    : undefined;
}

function parseResolution(raw: unknown): VideoResolution | undefined {
  return raw === "480P" || raw === "768P" || raw === "2K" ? raw : undefined;
}

function parseRatio(raw: unknown): VideoRatio | undefined {
  return typeof raw === "string" && (VIDEO_RATIOS as readonly string[]).includes(raw)
    ? (raw as VideoRatio)
    : undefined;
}

/** `undefined` = field absent; empty array = user cleared every option. */
function parseModeList(raw: unknown): VideoGenMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return uniquePreserve(raw.map(parseMode).filter((v): v is VideoGenMode => Boolean(v)));
}

function parseResolutionList(raw: unknown): VideoResolution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return uniquePreserve(raw.map(parseResolution).filter((v): v is VideoResolution => Boolean(v)));
}

function parseRatioList(raw: unknown): VideoRatio[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return uniquePreserve(raw.map(parseRatio).filter((v): v is VideoRatio => Boolean(v)));
}

function parseDurationList(raw: unknown, min: number, max: number): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return uniquePreserve(
    raw
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN))
      .filter((n) => n >= min && n <= max),
  ).sort((a, b) => a - b);
}

/** All legal choices checked; preferred singles match previous single-default behavior. */
export function defaultVideoModelOptions(model: string): VideoModelOptions {
  const id = normalizeVideoModelId(model) || "MiniMax-H3-Lite";
  const constraints = videoConstraintsOf(id);
  const resolution = constraints.resolutions.includes(defaultVideoResolution(id))
    ? defaultVideoResolution(id)
    : constraints.resolutions[0]!;
  const duration = Math.min(
    Math.max(defaultVideoDuration(id), constraints.durationMin),
    constraints.durationMax,
  );
  return {
    modes: [...VIDEO_GEN_MODES],
    resolutions: [...constraints.resolutions],
    durations: durationChoicesOf(id),
    ratios: [...VIDEO_RATIOS],
    mode: "text",
    resolution,
    duration,
    ratio: "16:9",
  };
}

/**
 * Normalize stored / form video options against the chosen model.
 * Accepts legacy single-value objects and expands them to full enabled sets.
 */
export function normalizeVideoModelOptions(
  model: string,
  raw?: Partial<VideoModelOptions> | Record<string, unknown> | null,
): VideoModelOptions {
  const id = normalizeVideoModelId(model);
  if (!id) throw new Error("生视频请填写模型名，例如 MiniMax-H3-Lite");
  const constraints = videoConstraintsOf(id);
  const defaults = defaultVideoModelOptions(id);
  const row = (raw ?? {}) as Record<string, unknown>;

  const modesRaw = parseModeList(row.modes);
  const modes =
    modesRaw ??
    (parseMode(row.mode) ? [...VIDEO_GEN_MODES] : undefined) ??
    defaults.modes;
  if (!modes.length) throw new Error("请至少勾选一种素材模式");

  const resolutionsRaw = parseResolutionList(row.resolutions);
  const resolutions = (
    resolutionsRaw ??
    (parseResolution(row.resolution) ? [...constraints.resolutions] : undefined) ??
    defaults.resolutions
  ).filter((r) => constraints.resolutions.includes(r));
  if (!resolutions.length) {
    throw new Error(`${id} 请至少勾选一种分辨率（${constraints.resolutions.join("、")}）`);
  }

  const durationsRaw = parseDurationList(
    row.durations,
    constraints.durationMin,
    constraints.durationMax,
  );
  const durations =
    durationsRaw ??
    (typeof row.duration === "number" && Number.isFinite(row.duration)
      ? durationChoicesOf(id)
      : undefined) ??
    defaults.durations;
  if (!durations.length) {
    throw new Error(
      `${id} 请至少勾选一个时长（${constraints.durationMin}–${constraints.durationMax} 秒）`,
    );
  }

  const ratiosRaw = parseRatioList(row.ratios);
  const ratios =
    ratiosRaw ?? (parseRatio(row.ratio) ? [...VIDEO_RATIOS] : undefined) ?? defaults.ratios;
  if (!ratios.length) throw new Error("请至少勾选一种画幅");

  if (modes.includes("text")) {
    const fixed = ratios.filter((r) => r !== "adaptive");
    if (!fixed.length) throw new Error("已启用文生视频时，请至少勾选一种非 adaptive 画幅");
  }
  if (modes.includes("reference") && !constraints.adaptiveAllowed) {
    const fixed = ratios.filter((r) => r !== "adaptive");
    if (!fixed.length) {
      throw new Error("MiniMax-H3-Lite 参考素材模式需要至少一种非 adaptive 画幅");
    }
  }

  const mode = pickPreferred<VideoGenMode>(modes, parseMode(row.mode), [
    "text",
    "first_frame",
    "last_frame",
    "first_last",
    "reference",
  ]);
  const resolution = pickPreferred<VideoResolution>(resolutions, parseResolution(row.resolution), [
    defaults.resolution,
    ...constraints.resolutions,
  ]);
  const durationPreferred =
    typeof row.duration === "number" && Number.isFinite(row.duration)
      ? Math.round(row.duration)
      : defaults.duration;
  const duration = pickPreferred<number>(durations, durationPreferred, [
    defaults.duration,
    ...durations,
  ]);
  const ratio = pickPreferred<VideoRatio>(ratios, parseRatio(row.ratio), [
    "16:9",
    ...VIDEO_RATIOS,
  ]);

  return {
    modes,
    resolutions,
    durations,
    ratios,
    mode,
    resolution,
    duration,
    ratio,
  };
}

export function defaultVideoByModel(): VideoByModel {
  const out = {} as VideoByModel;
  for (const preset of VIDEO_MODEL_PRESETS) {
    out[preset.id] = defaultVideoModelOptions(preset.id);
  }
  return out;
}

/** Merge stored per-model maps + legacy single `video` into a full four-preset map. */
export function normalizeVideoByModel(
  activeModel: string,
  videoByModelRaw?: unknown,
  activeVideo?: Partial<VideoModelOptions> | null,
): { model: VideoModelPresetId; video: VideoModelOptions; videoByModel: VideoByModel } {
  const active = normalizeVideoModelId(activeModel) || "MiniMax-H3-Lite";
  const model = (
    VIDEO_MODEL_PRESETS.some((row) => row.id === active) ? active : "MiniMax-H3-Lite"
  ) as VideoModelPresetId;
  const map = defaultVideoByModel();
  if (videoByModelRaw && typeof videoByModelRaw === "object") {
    const row = videoByModelRaw as Record<string, unknown>;
    for (const preset of VIDEO_MODEL_PRESETS) {
      const raw = row[preset.id];
      if (raw && typeof raw === "object") {
        try {
          map[preset.id] = normalizeVideoModelOptions(preset.id, raw as Partial<VideoModelOptions>);
        } catch {
          map[preset.id] = defaultVideoModelOptions(preset.id);
        }
      }
    }
  }
  if (activeVideo) {
    try {
      map[model] = normalizeVideoModelOptions(model, activeVideo);
    } catch {
      /* keep map default / previous */
    }
  }
  return { model, video: map[model], videoByModel: map };
}

export function readVideoModelOptions(
  model: string,
  raw: unknown,
): VideoModelOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  try {
    return normalizeVideoModelOptions(model, raw as Record<string, unknown>);
  } catch {
    return defaultVideoModelOptions(model);
  }
}

/** Ratio actually sent on create, given attachments / mode. */
export function effectiveVideoRatio(
  options: VideoModelOptions,
  hasFrameImage: boolean,
): VideoRatio {
  if (
    hasFrameImage ||
    options.mode === "first_frame" ||
    options.mode === "last_frame" ||
    options.mode === "first_last"
  ) {
    return "adaptive";
  }
  return options.ratio;
}
