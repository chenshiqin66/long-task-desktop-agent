import type { VideoMime } from "../types.js";

export type VideoResolution = "480P" | "768P" | "2K";
export type VideoRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive";

/** Frame / text modes for create-task. `reference` is handled elsewhere and not built here. */
export type VideoFrameMode = "text" | "first_frame" | "last_frame" | "first_last";

export interface VideoGenerationInput {
  model: string;
  prompt: string;
  /** Order matters for first_last: [0]=first_frame, [1]=last_frame. */
  images?: { dataUrl: string }[];
  /** Defaults to text; a single attached image still becomes first_frame for compatibility. */
  mode?: VideoFrameMode;
  resolution?: VideoResolution;
  duration?: number;
  ratio?: VideoRatio;
}

/** Docs suggest 10–30s; keep the low end so the UI stays responsive. */
export const VIDEO_POLL_INTERVAL_MS = 10_000;
/** Overall wait for create → succeed (not including download). */
export const VIDEO_POLL_TIMEOUT_MS = 15 * 60_000;

export interface VideoGenerationBody {
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string }; role?: "first_frame" | "last_frame" | "reference_image" }
  >;
  resolution: VideoResolution;
  duration: number;
  ratio: VideoRatio;
}

/**
 * MiniMax H3 paths are host-rooted under `/v3/...`.
 * OpenAI-compatible Base URL often ends with `/v1` — strip that so create/query still hit `/v3/...`.
 */
export function videoApiRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

const VIDEO_MODEL_ALIASES: Record<string, string> = {
  "minimax h3": "MiniMax-H3",
  "minimax-h3": "MiniMax-H3",
  "minimaxh3": "MiniMax-H3",
  "minimax h3 lite": "MiniMax-H3-Lite",
  "minimax-h3-lite": "MiniMax-H3-Lite",
  "minimaxh3lite": "MiniMax-H3-Lite",
  "minimax h3 max": "MiniMax-H3-Max",
  "minimax-h3-max": "MiniMax-H3-Max",
  "minimaxh3max": "MiniMax-H3-Max",
  "minimax h3 highspeed": "MiniMax-H3-Highspeed",
  "minimax-h3-highspeed": "MiniMax-H3-Highspeed",
  "minimaxh3highspeed": "MiniMax-H3-Highspeed",
};

/**
 * PPIO expects exact ids like `MiniMax-H3-Lite`.
 * Users often paste the marketing label with spaces (`MiniMax H3 Lite`).
 */
export function normalizeVideoModelId(model: string): string {
  const raw = model.trim();
  if (!raw) return raw;
  const key = raw.toLowerCase().replace(/[_]+/g, "-").replace(/\s+/g, " ").trim();
  const compact = key.replace(/[\s-]+/g, "");
  return VIDEO_MODEL_ALIASES[key] ?? VIDEO_MODEL_ALIASES[compact] ?? raw;
}

/** Lite / Highspeed / Max prefer 480P; full H3 starts at 768P. */
export function defaultVideoResolution(model: string): VideoResolution {
  const id = normalizeVideoModelId(model).toLowerCase();
  if (id === "minimax-h3") return "768P";
  return "480P";
}

export function defaultVideoDuration(model: string): number {
  const id = normalizeVideoModelId(model).toLowerCase();
  // MiniMax-H3-Max minimum is 5s; avoid matching the "max" substring inside "minimax".
  if (id.endsWith("-max") || id === "minimax-h3-max") return 5;
  return 4;
}

export type VideoFrameRole = "first_frame" | "last_frame";

/**
 * Map mode + image count to per-image roles.
 * text + 1 image → first_frame (compat); text + 2 images must switch to first_last.
 */
export function frameRolesForMode(
  mode: VideoFrameMode,
  imageCount: number,
): VideoFrameRole[] {
  if (mode === "text") {
    if (imageCount === 0) return [];
    if (imageCount === 1) return ["first_frame"];
    throw new Error("文生视频最多附一张图（将作为首帧）；两张图请改用「首尾帧」模式");
  }
  if (mode === "first_frame") {
    if (imageCount !== 1) throw new Error("首帧模式请恰好附一张图片");
    return ["first_frame"];
  }
  if (mode === "last_frame") {
    if (imageCount !== 1) throw new Error("尾帧模式请恰好附一张图片");
    return ["last_frame"];
  }
  if (mode === "first_last") {
    if (imageCount !== 2) throw new Error("首尾帧模式请按顺序附两张图：第一张首帧，第二张尾帧");
    return ["first_frame", "last_frame"];
  }
  throw new Error("不支持的素材模式");
}

/**
 * PPIO MiniMax H3 create-task body.
 * Text-only: fixed ratio (Lite forbids adaptive for t2v).
 * Frame modes: images get first_frame / last_frame roles; ratio adaptive.
 */
export function buildVideoGenerationBody(req: VideoGenerationInput): VideoGenerationBody {
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error("生视频请先输入提示词");
  if (prompt.length > 7000) throw new Error("提示词过长，最多 7000 字");
  const model = normalizeVideoModelId(req.model);
  if (!model) throw new Error("生视频请填写模型名，例如 MiniMax-H3-Lite");

  const mode: VideoFrameMode = req.mode ?? "text";
  const images = req.images ?? [];
  const roles = frameRolesForMode(mode, images.length);

  const content: VideoGenerationBody["content"] = [{ type: "text", text: prompt }];
  for (let i = 0; i < roles.length; i++) {
    const image = images[i];
    const role = roles[i];
    if (!image?.dataUrl || !role) throw new Error("参考图无效");
    content.push({
      type: "image_url",
      image_url: { url: image.dataUrl },
      role,
    });
  }

  const hasFrames = roles.length > 0;
  const resolution = req.resolution ?? defaultVideoResolution(model);
  const duration = req.duration ?? defaultVideoDuration(model);
  const ratio = req.ratio ?? (hasFrames ? "adaptive" : "16:9");
  if (!hasFrames && ratio === "adaptive") {
    throw new Error("文生视频不能使用 adaptive 画幅");
  }

  return {
    model,
    content,
    resolution,
    duration,
    ratio: hasFrames ? "adaptive" : ratio,
  };
}

export function parseVideoTaskId(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("创建视频任务失败：响应无效");
  const id = (body as { task_id?: unknown }).task_id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  throw new Error("创建视频任务失败：没有返回 task_id");
}

export type VideoTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface VideoTaskSnapshot {
  status: VideoTaskStatus;
  url?: string;
  error?: string;
}

export function parseVideoTaskQuery(body: unknown): VideoTaskSnapshot {
  if (!body || typeof body !== "object") throw new Error("查询视频任务失败：响应无效");
  const task = (body as { task?: unknown }).task;
  if (!task || typeof task !== "object") throw new Error("查询视频任务失败：缺少 task");
  const statusRaw = (task as { status?: unknown }).status;
  const status = typeof statusRaw === "string" ? statusRaw : "";
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new Error(`查询视频任务失败：未知状态 ${status || "(空)"}`);
  }
  if (status === "succeeded") {
    const content = (task as { content?: unknown }).content;
    const url =
      content && typeof content === "object" ? (content as { url?: unknown }).url : undefined;
    if (typeof url !== "string" || !url.trim()) throw new Error("视频已完成，但没有下载地址");
    return { status, url: url.trim() };
  }
  if (status === "failed" || status === "cancelled") {
    const err = (task as { error?: unknown }).error;
    let message = status === "cancelled" ? "视频任务已取消" : "视频生成失败";
    if (err && typeof err === "object") {
      const code = (err as { code?: unknown }).code;
      const msg = (err as { message?: unknown }).message;
      const parts = [typeof code === "string" || typeof code === "number" ? String(code) : "", typeof msg === "string" ? msg : ""]
        .filter(Boolean)
        .join(": ");
      if (parts) message = parts;
    }
    return { status, error: message };
  }
  return { status };
}

export function inferVideoMimeFromUrl(url: string): VideoMime {
  const pathOnly = url.split("?")[0]!.split("#")[0]!.toLowerCase();
  if (pathOnly.endsWith(".webm")) return "video/webm";
  if (pathOnly.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

export function parseVideoMime(contentType?: string | null): VideoMime | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "video/mp4" || mime === "video/webm" || mime === "video/quicktime") return mime;
  return undefined;
}
