import { describe, it, expect } from "vitest";
import { asrFormatFromMime, buildTtsHttpBody } from "../src/provider/volcSpeech.js";

describe("volcSpeech helpers", () => {
  it("buildTtsHttpBody fills defaults and rejects empty text", () => {
    expect(() => buildTtsHttpBody({ text: "  " })).toThrow("语音合成请先输入文本");
    expect(buildTtsHttpBody({ text: "你好" })).toEqual({
      req_params: {
        text: "你好",
        speaker: "zh_female_vv_uranus_bigtts",
        audio_params: { format: "mp3", sample_rate: 24000 },
      },
    });
    expect(buildTtsHttpBody({ text: "hi", speaker: "custom", format: "wav", sampleRate: 16000 })).toEqual({
      req_params: {
        text: "hi",
        speaker: "custom",
        audio_params: { format: "wav", sample_rate: 16000 },
      },
    });
  });

  it("asrFormatFromMime maps openspeech-supported types", () => {
    expect(asrFormatFromMime("audio/mpeg")).toBe("mp3");
    expect(asrFormatFromMime("audio/wav")).toBe("wav");
    expect(asrFormatFromMime("audio/ogg")).toBe("ogg");
    expect(() => asrFormatFromMime("audio/webm")).toThrow("暂只支持");
  });
});
