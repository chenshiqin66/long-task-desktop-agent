/** Helpers for copying or saving conversation images and videos. */

export type MediaKind = "image" | "video";

export type CopyImageRequest = {
  dataUrl?: string;
  relativePath?: string;
  sessionId?: string;
  workspace?: string | null;
};

export type SaveMediaRequest = {
  kind: MediaKind;
  defaultName?: string;
  mime?: string;
  dataUrl?: string;
  relativePath?: string;
  sessionId?: string;
  workspace?: string | null;
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** Basename of a session-relative media path, or null if it looks unsafe. */
export function fileNameFromRelativePath(relativePath: string | undefined): string | null {
  if (!relativePath) return null;
  const unified = relativePath.replace(/\\/g, "/").trim();
  if (!unified || unified.includes("..") || unified.startsWith("/")) return null;
  const base = unified.split("/").filter(Boolean).pop() ?? "";
  if (!base || base.startsWith(".") || !SAFE_FILE_NAME.test(base)) return null;
  return base;
}

export function extensionForMediaMime(mime: string | undefined, kind: MediaKind): string {
  if (mime) {
    const base = mime.split(";")[0]!.trim().toLowerCase();
    if (EXT_BY_MIME[base]) return EXT_BY_MIME[base]!;
  }
  return kind === "video" ? "mp4" : "png";
}

export function defaultMediaFileName(opts: {
  relativePath?: string;
  mime?: string;
  kind: MediaKind;
  fallbackName?: string;
}): string {
  const fromPath = fileNameFromRelativePath(opts.relativePath);
  if (fromPath) return fromPath;
  const fallback = fileNameFromRelativePath(opts.fallbackName);
  if (fallback) return fallback;
  return `${opts.kind === "video" ? "video" : "image"}.${extensionForMediaMime(opts.mime, opts.kind)}`;
}

export function saveDialogFilters(
  kind: MediaKind,
  fileName: string,
): Array<{ name: string; extensions: string[] }> {
  const ext = (fileName.split(".").pop() || extensionForMediaMime(undefined, kind)).toLowerCase();
  const name = kind === "video" ? "视频" : "图片";
  return [
    { name, extensions: [ext] },
    { name: "所有文件", extensions: ["*"] },
  ];
}

function decodeBase64(payload: string): Uint8Array | null {
  const cleaned = payload.replace(/\s/g, "");
  if (!cleaned) return null;
  try {
    if (typeof Buffer !== "undefined") {
      const buf = Buffer.from(cleaned, "base64");
      if (!buf.length) return null;
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Split a `data:` URL into mime and bytes. */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (typeof dataUrl !== "string") return null;
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (!trimmed.startsWith("data:") || comma < 0) return null;
  const meta = trimmed.slice(5, comma);
  const payload = trimmed.slice(comma + 1);
  const parts = meta.split(";").map((part) => part.trim()).filter(Boolean);
  const isBase64 = parts.some((part) => part.toLowerCase() === "base64");
  const mimePart = parts.find((part) => part && !part.toLowerCase().startsWith("base64") && !part.toLowerCase().startsWith("charset="));
  const mime = (mimePart || "application/octet-stream").toLowerCase();
  if (isBase64) {
    const bytes = decodeBase64(payload);
    if (!bytes) return null;
    return { mime, bytes };
  }
  try {
    const text = decodeURIComponent(payload);
    const bytes = new TextEncoder().encode(text);
    return { mime, bytes };
  } catch {
    return null;
  }
}
