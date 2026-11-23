import { describe, it, expect } from "vitest";
import {
  MODEL_KIND_LABELS,
  modelKindLabel,
  modelKindOf,
  parseModelKind,
} from "../src/config/modelKind.js";

describe("modelKind", () => {
  it("treats a missing or unknown kind as text", () => {
    expect(parseModelKind(undefined)).toBe("text");
    expect(parseModelKind("")).toBe("text");
    expect(parseModelKind("chat")).toBe("text");
    expect(modelKindOf(null)).toBe("text");
    expect(modelKindOf({})).toBe("text");
    expect(modelKindOf({ kind: "image" })).toBe("image");
    expect(modelKindOf({ kind: "video" })).toBe("video");
    expect(modelKindOf({ kind: "tts" })).toBe("tts");
    expect(modelKindOf({ kind: "asr" })).toBe("asr");
    expect(modelKindOf({ kind: "search" })).toBe("search");
    expect(modelKindOf({ kind: "text" })).toBe("text");
  });

  it("maps legacy audio kind to tts", () => {
    expect(parseModelKind("audio")).toBe("tts");
    expect(modelKindOf({ kind: "audio" })).toBe("tts");
  });

  it("labels the kinds in Chinese", () => {
    expect(MODEL_KIND_LABELS).toEqual({
      text: "生文",
      image: "生图",
      video: "生视频",
      tts: "语音合成",
      asr: "语音识别",
      search: "网搜",
    });
    expect(modelKindLabel("tts")).toBe("语音合成");
    expect(modelKindLabel("asr")).toBe("语音识别");
    expect(modelKindLabel("search")).toBe("网搜");
  });
});
