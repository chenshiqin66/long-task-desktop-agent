import type { ImageMime } from "../types.js";
import type {
  ImageModelOptions,
  ImageOutputFormat,
  ImageRatio,
  ImageSizeTier,
} from "../config/imageOptions.js";
import type { ImageGenRequest, ImageGenResult } from "./types.js";

type ImageSizeMatrix = Record<ImageSizeTier, Record<Exclude<ImageRatio, "auto">, string>>;

const IMAGE_SIZE_MATRIX: ImageSizeMatrix = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1280x720",
    "9:16": "720x1280",
  },
  "1.5K": {
    "1:1": "1536x1536",
    "4:3": "1728x1296",
    "3:4": "1296x1728",
    "16:9": "1920x1080",
    "9:16": "1080x1920",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
  },
};

export function resolveImageSize(options: Pick<ImageModelOptions, "size" | "ratio">): string {
  if (options.ratio === "auto") return options.size;
  return IMAGE_SIZE_MATRIX[options.size][options.ratio];
}

export function buildImageGenerationBody(
  req: Pick<
    ImageGenRequest,
    "model" | "prompt" | "images" | "size" | "outputFormat" | "background" | "watermark" | "promptMode"
  >,
): {
  model: string;
  prompt: string;
  image?: string | string[];
  size?: string;
  output_format?: ImageOutputFormat;
  background?: string;
  watermark?: boolean;
  optimize_prompt_options?: { mode: string };
} {
  const body: {
    model: string;
    prompt: string;
    image?: string | string[];
    size?: string;
    output_format?: ImageOutputFormat;
    background?: string;
    watermark?: boolean;
    optimize_prompt_options?: { mode: string };
  } = {
    model: req.model,
    prompt: req.prompt,
  };
  const images = req.images ?? [];
  if (images.length === 1) {
    body.image = images[0]!.dataUrl;
  } else if (images.length > 1) {
    body.image = images.map((image) => image.dataUrl);
  }
  if (req.size) body.size = req.size;
  if (req.outputFormat) body.output_format = req.outputFormat;
  if (req.background) body.background = req.background;
  if (typeof req.watermark === "boolean") body.watermark = req.watermark;
  if (req.promptMode) body.optimize_prompt_options = { mode: req.promptMode };
  return body;
}

function firstDataItem(
  body: unknown,
): { b64_json?: unknown; url?: unknown; mime?: unknown; output_format?: unknown } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object") return undefined;
  return first as { b64_json?: unknown; url?: unknown; mime?: unknown; output_format?: unknown };
}

export function parseImageMime(value?: string | null): ImageMime | undefined {
  if (!value) return undefined;
  const mime = value.split(";")[0]!.trim().toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif") {
    return mime;
  }
  if (mime === "image/jpg") return "image/jpeg";
  return undefined;
}

export function parseImageFormat(value?: string | null): ImageMime | undefined {
  if (!value) return undefined;
  const format = value.trim().toLowerCase();
  if (format === "png") return "image/png";
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  return undefined;
}

export function inferImageMimeFromUrl(url: string): ImageMime | undefined {
  const pathOnly = url.split("?")[0]!.split("#")[0].toLowerCase();
  if (pathOnly.endsWith(".png")) return "image/png";
  if (pathOnly.endsWith(".jpg") || pathOnly.endsWith(".jpeg")) return "image/jpeg";
  if (pathOnly.endsWith(".webp")) return "image/webp";
  if (pathOnly.endsWith(".gif")) return "image/gif";
  return undefined;
}

export function parseImageGenerationResponse(
  body: unknown,
  contentType?: string,
  fallbackFormat?: ImageOutputFormat,
): ImageGenResult {
  const first = firstDataItem(body);
  if (first && typeof first.b64_json === "string" && first.b64_json.length) {
    const mime =
      parseImageMime(typeof first.mime === "string" ? first.mime : undefined) ??
      parseImageFormat(typeof first.output_format === "string" ? first.output_format : undefined) ??
      parseImageMime(contentType) ??
      parseImageFormat(fallbackFormat) ??
      "image/png";
    return { mime, base64: first.b64_json };
  }
  throw new Error("No image in response");
}

export function imageUrlFromGenerationResponse(body: unknown): string | undefined {
  const first = firstDataItem(body);
  return first && typeof first.url === "string" && first.url.length ? first.url : undefined;
}
