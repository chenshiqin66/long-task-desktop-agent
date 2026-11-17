export const MODEL_KINDS = ["text", "image", "video", "audio"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const MODEL_KIND_LABELS: Record<ModelKind, string> = {
  text: "生文",
  image: "生图",
  video: "生视频",
  audio: "生音",
};

export function parseModelKind(raw: unknown): ModelKind {
  return typeof raw === "string" && (MODEL_KINDS as readonly string[]).includes(raw)
    ? (raw as ModelKind)
    : "text";
}

export function modelKindOf(entry: { kind?: unknown } | null | undefined): ModelKind {
  return parseModelKind(entry?.kind);
}

export function modelKindLabel(kind: ModelKind): string {
  return MODEL_KIND_LABELS[kind];
}