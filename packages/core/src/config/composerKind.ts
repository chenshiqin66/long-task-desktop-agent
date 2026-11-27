import type { ModelKind } from "./modelKind.js";

/** Composer primary category. ASR and search stay bypasses, not tabs. */
export const COMPOSER_KINDS = ["text", "image", "tts", "video"] as const;
export type ComposerKind = (typeof COMPOSER_KINDS)[number];

export const COMPOSER_KIND_LABELS: Record<ComposerKind, string> = {
  text: "Do-it",
  image: "生图",
  tts: "合成语音",
  video: "生视频",
};

export const COMPOSER_SEND_LABELS: Record<ComposerKind, string> = {
  text: "发送",
  image: "生成图片",
  tts: "合成语音",
  video: "生成视频",
};

export const COMPOSER_PLACEHOLDERS: Record<ComposerKind, string> = {
  text: "向CSQ-Agent发送消息...",
  image: "描述要生成的图片…",
  tts: "输入要朗读的文本…",
  video: "描述要生成的视频…",
};

export function parseComposerKind(raw: unknown): ComposerKind {
  return typeof raw === "string" && (COMPOSER_KINDS as readonly string[]).includes(raw)
    ? (raw as ComposerKind)
    : "text";
}

export function isComposerKind(kind: ModelKind): kind is ComposerKind {
  return (COMPOSER_KINDS as readonly string[]).includes(kind);
}

export type CurrentModelByKind = Partial<Record<ComposerKind, string>>;

export function readCurrentModelByKind(raw: unknown): CurrentModelByKind {
  if (!raw || typeof raw !== "object") return {};
  const row = raw as Record<string, unknown>;
  const out: CurrentModelByKind = {};
  for (const kind of COMPOSER_KINDS) {
    const id = row[kind];
    if (typeof id === "string" && id.trim()) out[kind] = id.trim();
  }
  return out;
}
