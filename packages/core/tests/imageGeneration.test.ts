import { describe, it, expect } from "vitest";
import { buildImageGenerationBody, parseImageGenerationResponse } from "../src/provider/imageGeneration.js";

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
});
