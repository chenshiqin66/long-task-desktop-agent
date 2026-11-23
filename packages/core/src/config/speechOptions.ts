/** TTS options stored on a StoredModel when kind is tts. */
export interface TtsModelOptions {
  /** Volcengine speaker id. */
  speaker: string;
  format: "mp3" | "wav";
  sampleRate: number;
}

export const DEFAULT_TTS_SPEAKER = "zh_female_vv_uranus_bigtts";

export function defaultTtsModelOptions(): TtsModelOptions {
  return {
    speaker: DEFAULT_TTS_SPEAKER,
    format: "mp3",
    sampleRate: 24000,
  };
}

export function normalizeTtsModelOptions(raw?: Partial<TtsModelOptions> | null): TtsModelOptions {
  const defaults = defaultTtsModelOptions();
  const speaker =
    typeof raw?.speaker === "string" && raw.speaker.trim() ? raw.speaker.trim() : defaults.speaker;
  const format = raw?.format === "wav" ? "wav" : "mp3";
  const sampleRate =
    typeof raw?.sampleRate === "number" && Number.isFinite(raw.sampleRate) && raw.sampleRate > 0
      ? Math.round(raw.sampleRate)
      : defaults.sampleRate;
  return { speaker, format, sampleRate };
}

export function readTtsModelOptions(raw: unknown): TtsModelOptions {
  if (!raw || typeof raw !== "object") return defaultTtsModelOptions();
  return normalizeTtsModelOptions(raw as Partial<TtsModelOptions>);
}

/** Official openspeech hosts; user Base URL on ark plan is ignored at call time. */
export const VOLC_TTS_HTTP_URL = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";
export const VOLC_ASR_NOSTREAM_URL = "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream";
export const VOLC_ASR_ASYNC_URL = "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async";

export const VOLC_TTS_RESOURCE_ID = "seed-tts-2.0";
export const VOLC_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration";
