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
    expect(modelKindOf({ kind: "audio" })).toBe("audio");
    expect(modelKindOf({ kind: "text" })).toBe("text");
  });

  it("labels the four kinds in Chinese", () => {
    expect(MODEL_KIND_LABELS).toEqual({
      text: "生文",
      image: "生图",
      video: "生视频",
      audio: "生音",
    });
    expect(modelKindLabel("image")).toBe("生图");
  });
});