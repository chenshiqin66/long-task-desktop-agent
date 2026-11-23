import { describe, it, expect } from "vitest";
import {
  buildImageGenerationBody,
  parseImageGenerationResponse,
  resolveImageSize,
} from "../src/provider/imageGeneration.js";

describe("image generation helpers", () => {
  it("builds a body with model, prompt, and optional reference images", () => {
    expect(buildImageGenerationBody({ model: "draw", prompt: "一只猫" })).toEqual({
      model: "draw",
      prompt: "一只猫",
    });
    expect(
      buildImageGenerationBody({
        model: "draw",
        prompt: "一只猫",
        images: [{ dataUrl: "data:image/png;base64,AAA" }],
      }),
    ).toEqual({
      model: "draw",
      prompt: "一只猫",
      image: "data:image/png;base64,AAA",
    });
    expect(
      buildImageGenerationBody({
        model: "draw",
        prompt: "一只猫",
        images: [
          { dataUrl: "data:image/png;base64,AAA" },
          { dataUrl: "data:image/png;base64,BBB" },
        ],
      }),
    ).toEqual({
      model: "draw",
      prompt: "一只猫",
      image: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
    });
  });

  it("reads b64_json from the first data item", () => {
    const result = parseImageGenerationResponse({
      data: [{ b64_json: "AAA", url: "https://example.com/x.png" }],
    });
    expect(result).toEqual({ mime: "image/png", base64: "AAA" });
  });

  it("throws a short error when the response has no image data", () => {
    expect(() => parseImageGenerationResponse({})).toThrow(/no image/i);
  });

  it("adds Seedream request options", () => {
    expect(
      buildImageGenerationBody({
        model: "draw",
        prompt: "一只猫",
        size: "2560x1440",
        outputFormat: "jpeg",
        background: "opaque",
        watermark: true,
        promptMode: "fast",
      }),
    ).toEqual({
      model: "draw",
      prompt: "一只猫",
      size: "2560x1440",
      output_format: "jpeg",
      background: "opaque",
      watermark: true,
      optimize_prompt_options: { mode: "fast" },
    });
  });

  it("maps size tiers and ratios to pixel sizes", () => {
    expect(resolveImageSize({ size: "2K", ratio: "auto" })).toBe("2K");
    expect(resolveImageSize({ size: "2K", ratio: "16:9" })).toBe("2560x1440");
    expect(resolveImageSize({ size: "2K", ratio: "1:1" })).toBe("2048x2048");
    expect(resolveImageSize({ size: "1.5K", ratio: "9:16" })).toBe("1080x1920");
    expect(resolveImageSize({ size: "1K", ratio: "4:3" })).toBe("1152x864");
  });

  it("reads output_format when the response has no mime", () => {
    expect(
      parseImageGenerationResponse({ data: [{ b64_json: "AAA", output_format: "jpeg" }] }),
    ).toEqual({ mime: "image/jpeg", base64: "AAA" });
    expect(
      parseImageGenerationResponse({ data: [{ b64_json: "AAA", output_format: "png" }] }),
    ).toEqual({ mime: "image/png", base64: "AAA" });
    expect(
      parseImageGenerationResponse({ data: [{ b64_json: "AAA" }] }, undefined, "jpeg"),
    ).toEqual({ mime: "image/jpeg", base64: "AAA" });
  });
});
