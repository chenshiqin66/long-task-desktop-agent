import type { ImageMime } from "../types.js";
import type { ImageGenRequest, ImageGenResult } from "./types.js";

export function buildImageGenerationBody(
  req: Pick<ImageGenRequest, "model" | "prompt" | "images">,
): { model: string; prompt: string; image?: string | string[] } {
  const body: { model: string; prompt: string; image?: string | string[] } = {
    model: req.model,
    prompt: req.prompt,
  };
  const images = req.images ?? [];
  if (images.length === 1) {
    body.image = images[0]!.dataUrl;
  } else if (images.length > 1) {
    body.image = images.map((image) => image.dataUrl);
  }
  return body;
}

function firstDataItem(body: unknown): { b64_json?: unknown; url?: unknown; mime?: unknown } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object") return undefined;
  return first as { b64_json?: unknown; url?: unknown; mime?: unknown };
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

export function inferImageMimeFromUrl(url: string): ImageMime | undefined {
  const pathOnly = url.split("?")[0]!.split("#")[0]!.toLowerCase();
  if (pathOnly.endsWith(".png")) return "image/png";
  if (pathOnly.endsWith(".jpg") || pathOnly.endsWith(".jpeg")) return "image/jpeg";
  if (pathOnly.endsWith(".webp")) return "image/webp";
  if (pathOnly.endsWith(".gif")) return "image/gif";
  return undefined;
}

export function parseImageGenerationResponse(body: unknown, contentType?: string): ImageGenResult {
  const first = firstDataItem(body);
  if (first && typeof first.b64_json === "string" && first.b64_json.length) {
    const mime =
      parseImageMime(typeof first.mime === "string" ? first.mime : undefined) ??
      parseImageMime(contentType) ??
      "image/png";
    return { mime, base64: first.b64_json };
  }
  throw new Error("No image in response");
}

export function imageUrlFromGenerationResponse(body: unknown): string | undefined {
  const first = firstDataItem(body);
  return first && typeof first.url === "string" && first.url.length ? first.url : undefined;
}
