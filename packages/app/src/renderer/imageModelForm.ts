/**
 * Mirrors `@agent/core` imageOptions for the sandboxed renderer (no Node / package imports).
 * Keep catalogs and rules in sync when the Seedream contract changes.
 */

export const IMAGE_PRESET_IDS = [
  "Doubao-Seedream-5.0-pro",
  "Doubao-Seedream-5.5",
  "Doubao-Seedream-5.0-flash",
] as const;
export type ImagePresetId = (typeof IMAGE_PRESET_IDS)[number];

export const IMAGE_SIZE_TIERS = ["1K", "1.5K", "2K"] as const;
export type ImageSizeTier = (typeof IMAGE_SIZE_TIERS)[number];

export const IMAGE_RATIOS = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"] as const;
export type ImageRatio = (typeof IMAGE_RATIOS)[number];

export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

export const IMAGE_BACKGROUNDS = ["opaque", "transparent", "auto"] as const;
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];

export const IMAGE_PROMPT_MODES = ["standard", "fast"] as const;
export type ImagePromptMode = (typeof IMAGE_PROMPT_MODES)[number];

export interface ImageModelOptions {
  sizes: ImageSizeTier[];
  size: ImageSizeTier;
  ratios: ImageRatio[];
  ratio: ImageRatio;
  formats: ImageOutputFormat[];
  format: ImageOutputFormat;
  backgrounds: ImageBackground[];
  background: ImageBackground;
  watermark: boolean;
  promptModes: ImagePromptMode[];
  promptMode: ImagePromptMode;
}

export type ImageByModel = Record<ImagePresetId, ImageModelOptions>;

export interface ImageModelPreset {
  id: ImagePresetId;
  label: string;
  defaultModel: string;
  blurb: string;
  sizes: readonly ImageSizeTier[];
  ratios: readonly ImageRatio[];
  formats: readonly ImageOutputFormat[];
  defaultFormat: ImageOutputFormat;
  backgrounds: readonly ImageBackground[];
  defaultBackground: ImageBackground;
  promptModes: readonly ImagePromptMode[];
  defaultPromptMode: ImagePromptMode;
}

export const IMAGE_MODEL_PRESETS = [
  {
    id: "Doubao-Seedream-5.0-pro",
    label: "5.0-pro",
    defaultModel: "doubao-seedream-5-0-pro-260628",
    blurb: "旗舰画质，支持 fast 提示词优化；最多 10 张参考图，图层拆分最多 16 层。",
    sizes: IMAGE_SIZE_TIERS,
    ratios: IMAGE_RATIOS,
    formats: ["png", "jpeg"],
    defaultFormat: "jpeg",
    backgrounds: ["opaque", "transparent"],
    defaultBackground: "opaque",
    promptModes: ["standard", "fast"],
    defaultPromptMode: "standard",
  },
  {
    id: "Doubao-Seedream-5.5",
    label: "5.5",
    defaultModel: "doubao-seedream-5-5-261028",
    blurb: "最新一代，默认 PNG 和自动背景；最多 10 张参考图，图层拆分最多 99 层。",
    sizes: IMAGE_SIZE_TIERS,
    ratios: IMAGE_RATIOS,
    formats: ["png", "jpeg"],
    defaultFormat: "png",
    backgrounds: ["auto", "opaque", "transparent"],
    defaultBackground: "auto",
    promptModes: ["standard"],
    defaultPromptMode: "standard",
  },
  {
    id: "Doubao-Seedream-5.0-flash",
    label: "5.0-flash",
    defaultModel: "doubao-seedream-5-0-flash-260915",
    blurb: "速度优先，提示词优化仅 standard；最多 10 张参考图，图层拆分最多 16 层。",
    sizes: IMAGE_SIZE_TIERS,
    ratios: IMAGE_RATIOS,
    formats: ["png", "jpeg"],
    defaultFormat: "jpeg",
    backgrounds: ["opaque", "transparent"],
    defaultBackground: "opaque",
    promptModes: ["standard"],
    defaultPromptMode: "standard",
  },
] as const satisfies readonly ImageModelPreset[];

export const DEFAULT_IMAGE_PRESET: ImagePresetId = "Doubao-Seedream-5.0-pro";

export const IMAGE_SIZE_OPTIONS = [
  { value: "1K", label: "1K" },
  { value: "1.5K", label: "1.5K" },
  { value: "2K", label: "2K" },
] as const;

export const IMAGE_RATIO_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export const IMAGE_FORMAT_OPTIONS = [
  { value: "png", label: "png" },
  { value: "jpeg", label: "jpeg" },
] as const;

export const IMAGE_BACKGROUND_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "opaque", label: "opaque" },
  { value: "transparent", label: "transparent" },
] as const;

export const IMAGE_PROMPT_MODE_OPTIONS = [
  { value: "standard", label: "standard" },
  { value: "fast", label: "fast" },
] as const;

const PRESET_ALIASES: Record<string, ImagePresetId> = {
  "doubao-seedream-5-0-pro": "Doubao-Seedream-5.0-pro",
  "seedream-5-0-pro": "Doubao-Seedream-5.0-pro",
  "doubao-seedream-5-5": "Doubao-Seedream-5.5",
  "seedream-5-5": "Doubao-Seedream-5.5",
  "doubao-seedream-5-0-flash": "Doubao-Seedream-5.0-flash",
  "seedream-5-0-flash": "Doubao-Seedream-5.0-flash",
};

function compactModelKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[._\s]+/g, "-").replace(/-+/g, "-");
}

export function parseImagePresetId(raw: unknown): ImagePresetId | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const key = compactModelKey(raw);
  const alias = PRESET_ALIASES[key];
  if (alias) return alias;
  return IMAGE_PRESET_IDS.find((id) => compactModelKey(id) === key);
}

export function inferImagePresetFromModel(model: string): ImagePresetId | undefined {
  const key = compactModelKey(model);
  if (!key || key.startsWith("ep-")) return undefined;
  if (key.includes("5-0-flash")) return "Doubao-Seedream-5.0-flash";
  if (key.includes("5-0-pro")) return "Doubao-Seedream-5.0-pro";
  if (/(^|-)5-5($|-)/.test(key)) return "Doubao-Seedream-5.5";
  return undefined;
}

export function imagePresetOf(raw: string) {
  const id = parseImagePresetId(raw);
  return id ? IMAGE_MODEL_PRESETS.find((row) => row.id === id) : undefined;
}

export function imagePresetLabel(preset: ImagePresetId): string {
  return imagePresetOf(preset)?.label ?? preset;
}

export function imageModelBlurb(preset: ImagePresetId): string {
  return imagePresetOf(preset)?.blurb ?? "";
}

export function defaultImageModelIds(): Record<ImagePresetId, string> {
  return Object.fromEntries(
    IMAGE_MODEL_PRESETS.map((preset) => [preset.id, preset.defaultModel]),
  ) as Record<ImagePresetId, string>;
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

function parseList<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return uniquePreserve(
    raw.filter(
      (value): value is T =>
        typeof value === "string" && (allowed as readonly string[]).includes(value),
    ),
  );
}

function parseOne<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : undefined;
}

function pickPreferred<T>(enabled: readonly T[], preferred: T | undefined, fallback: readonly T[]): T {
  if (preferred !== undefined && enabled.includes(preferred)) return preferred;
  for (const item of fallback) {
    if (enabled.includes(item)) return item;
  }
  return enabled[0]!;
}

function resolveList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  defaults: readonly T[],
  error: string,
): T[] {
  const parsed = parseList(raw, allowed);
  if (parsed === undefined) return [...defaults];
  if (parsed.length) return parsed;
  if (Array.isArray(raw) && raw.length === 0) throw new Error(error);
  return [...defaults];
}

export function defaultImageModelOptions(preset: ImagePresetId): ImageModelOptions {
  const row = imagePresetOf(preset) ?? IMAGE_MODEL_PRESETS[0];
  return {
    sizes: [...row.sizes],
    size: "2K",
    ratios: [...row.ratios],
    ratio: "auto",
    formats: [...row.formats],
    format: row.defaultFormat,
    backgrounds: [...row.backgrounds],
    background: row.defaultBackground,
    watermark: true,
    promptModes: [...row.promptModes],
    promptMode: row.defaultPromptMode,
  };
}

export function defaultImageByModel(): ImageByModel {
  const out = {} as ImageByModel;
  for (const row of IMAGE_MODEL_PRESETS) {
    out[row.id] = defaultImageModelOptions(row.id);
  }
  return out;
}

export function normalizeImageModelOptions(
  preset: ImagePresetId,
  raw?: Partial<ImageModelOptions> | Record<string, unknown> | null,
): ImageModelOptions {
  const row = imagePresetOf(preset);
  if (!row) throw new Error(`不支持的生图型号 ${preset}`);
  const defaults = defaultImageModelOptions(preset);
  const rawRow = (raw ?? {}) as Record<string, unknown>;

  const sizes = resolveList(rawRow.sizes, IMAGE_SIZE_TIERS, defaults.sizes, "请至少勾选一种尺寸");
  const ratios = resolveList(rawRow.ratios, IMAGE_RATIOS, defaults.ratios, "请至少勾选一种画幅");
  const formats = resolveList(rawRow.formats, row.formats, defaults.formats, "请至少勾选一种输出格式");
  const backgrounds = resolveList(
    rawRow.backgrounds,
    row.backgrounds,
    defaults.backgrounds,
    "请至少勾选一种背景",
  );
  const promptModes = resolveList(
    rawRow.promptModes,
    row.promptModes,
    defaults.promptModes,
    "请至少勾选一种提示词优化",
  );

  const watermark =
    typeof rawRow.watermark === "boolean" ? rawRow.watermark : defaults.watermark;

  const size = pickPreferred(sizes, parseOne(rawRow.size, IMAGE_SIZE_TIERS), [
    defaults.size,
    ...sizes,
  ]);
  const ratio = pickPreferred(ratios, parseOne(rawRow.ratio, IMAGE_RATIOS), [
    defaults.ratio,
    ...ratios,
  ]);
  let format = pickPreferred(formats, parseOne(rawRow.format, row.formats), [
    defaults.format,
    ...formats,
  ]);
  const background = pickPreferred(
    backgrounds,
    parseOne(rawRow.background, row.backgrounds),
    [defaults.background, ...backgrounds],
  );
  const promptMode = pickPreferred(
    promptModes,
    parseOne(rawRow.promptMode, row.promptModes),
    [defaults.promptMode, ...promptModes],
  );

  if (backgrounds.includes("transparent") && !formats.includes("png")) {
    formats.push("png");
  }
  if (background === "transparent") format = "png";

  return {
    sizes,
    size,
    ratios,
    ratio,
    formats,
    format,
    backgrounds,
    background,
    watermark,
    promptModes,
    promptMode,
  };
}

export function normalizeImageByModel(
  activePreset: ImagePresetId,
  imageByModelRaw?: unknown,
  activeImage?: Partial<ImageModelOptions> | null,
): { preset: ImagePresetId; image: ImageModelOptions; imageByModel: ImageByModel } {
  const preset = parseImagePresetId(activePreset) ?? DEFAULT_IMAGE_PRESET;
  const map = defaultImageByModel();
  if (imageByModelRaw && typeof imageByModelRaw === "object") {
    const rawRow = imageByModelRaw as Record<string, unknown>;
    for (const id of IMAGE_PRESET_IDS) {
      const raw = rawRow[id];
      if (raw && typeof raw === "object") {
        try {
          map[id] = normalizeImageModelOptions(id, raw as Partial<ImageModelOptions>);
        } catch {
          map[id] = defaultImageModelOptions(id);
        }
      }
    }
  }
  if (activeImage) {
    try {
      map[preset] = normalizeImageModelOptions(preset, activeImage);
    } catch {
      /* keep the normalized map value */
    }
  }
  return { preset, image: map[preset], imageByModel: map };
}

export function readImageModelOptions(
  preset: ImagePresetId,
  raw: unknown,
): ImageModelOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  try {
    return normalizeImageModelOptions(preset, raw as Record<string, unknown>);
  } catch {
    return defaultImageModelOptions(preset);
  }
}

export function mergeImageOptions(
  base: ImageModelOptions,
  override?: Partial<
    Pick<ImageModelOptions, "size" | "ratio" | "format" | "background" | "watermark" | "promptMode">
  > | null,
): ImageModelOptions {
  const size = override?.size && base.sizes.includes(override.size) ? override.size : base.size;
  const ratio =
    override?.ratio && base.ratios.includes(override.ratio) ? override.ratio : base.ratio;
  let format =
    override?.format && base.formats.includes(override.format) ? override.format : base.format;
  const background =
    override?.background && base.backgrounds.includes(override.background)
      ? override.background
      : base.background;
  const watermark =
    typeof override?.watermark === "boolean" ? override.watermark : base.watermark;
  const promptMode =
    override?.promptMode && base.promptModes.includes(override.promptMode)
      ? override.promptMode
      : base.promptMode;
  if (background === "transparent") format = "png";
  return { ...base, size, ratio, format, background, watermark, promptMode };
}

/** Seedream only accepts transparent with exactly one reference image. */
export function imageBackgroundForTurn(
  options: ImageModelOptions,
  referenceImages: number,
): ImageBackground {
  if (options.background !== "transparent") return options.background;
  if (referenceImages === 1) return "transparent";
  return options.backgrounds.find((value) => value !== "transparent") ?? "opaque";
}

const RATIO_LABELS: Record<ImageRatio, string> = {
  auto: "自动",
  "1:1": "1:1",
  "4:3": "4:3",
  "3:4": "3:4",
  "16:9": "16:9",
  "9:16": "9:16",
};

export function imageOptionsSummary(options: ImageModelOptions): string {
  const parts: string[] = [options.size, RATIO_LABELS[options.ratio], options.format];
  if (options.promptMode === "fast") parts.push("fast");
  if (options.background === "transparent") parts.push("透明背景");
  parts.push(options.watermark ? "水印" : "无水印");
  return parts.join(" · ");
}
