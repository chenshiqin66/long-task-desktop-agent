import { describe, it, expect } from "vitest";
import {
  defaultImageByModel,
  defaultImageModelOptions,
  imageOptionsSummary,
  inferImagePresetFromModel,
  mergeImageOptions,
  normalizeImageModelOptions,
  type ImageSizeTier,
} from "../src/config/imageOptions.js";

describe("image model options", () => {
  it("lists per-model defaults", () => {
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-pro")).toMatchObject({
      size: "2K",
      ratio: "auto",
      format: "jpeg",
      background: "opaque",
      watermark: true,
      promptMode: "standard",
    });
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-pro").promptModes).toEqual([
      "standard",
      "fast",
    ]);
    expect(defaultImageModelOptions("Doubao-Seedream-5.5")).toMatchObject({
      format: "png",
      background: "auto",
      promptModes: ["standard"],
    });
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-flash")).toMatchObject({
      format: "jpeg",
      background: "opaque",
    });
    expect(Object.keys(defaultImageByModel())).toEqual([
      "Doubao-Seedream-5.0-pro",
      "Doubao-Seedream-5.5",
      "Doubao-Seedream-5.0-flash",
    ]);
  });

  it("filters choices the model does not support", () => {
    const opts = normalizeImageModelOptions("Doubao-Seedream-5.5", {
      sizes: ["2K"],
      ratios: ["16:9"],
      formats: ["jpeg"],
      backgrounds: ["opaque"],
      watermark: false,
      promptModes: ["fast"],
      size: "2K",
      ratio: "16:9",
      format: "jpeg",
      background: "opaque",
      promptMode: "fast",
    });
    expect(opts.promptModes).toEqual(["standard"]);
    expect(opts.promptMode).toBe("standard");
    expect(opts.watermark).toBe(false);
  });

  it("requires at least one value in every enabled group", () => {
    expect(() =>
      normalizeImageModelOptions("Doubao-Seedream-5.0-pro", {
        sizes: [],
        ratios: ["auto"],
        formats: ["png"],
        backgrounds: ["opaque"],
        watermark: true,
        promptModes: ["standard"],
        size: "2K",
        ratio: "auto",
        format: "png",
        background: "opaque",
        promptMode: "standard",
      }),
    ).toThrow(/尺寸/);
  });

  it("adds png when transparent is enabled and forces png for a transparent default", () => {
    const opts = normalizeImageModelOptions("Doubao-Seedream-5.0-pro", {
      sizes: ["2K"],
      ratios: ["auto"],
      formats: ["jpeg"],
      backgrounds: ["opaque", "transparent"],
      watermark: true,
      promptModes: ["standard"],
      size: "2K",
      ratio: "auto",
      format: "jpeg",
      background: "transparent",
      promptMode: "standard",
    });
    expect(opts.formats).toContain("png");
    expect(opts.format).toBe("png");
  });

  it("merges this turn's values only when the model enables them", () => {
    const base = defaultImageModelOptions("Doubao-Seedream-5.0-pro");
    expect(
      mergeImageOptions(base, {
        size: "1.5K",
        ratio: "16:9",
        format: "png",
        background: "transparent",
        watermark: false,
      }),
    ).toMatchObject({
      size: "1.5K",
      ratio: "16:9",
      format: "png",
      background: "transparent",
      watermark: false,
    });
    expect(
      mergeImageOptions(base, {
        size: "4K" as unknown as ImageSizeTier,
      }),
    ).toMatchObject({ size: "2K" });
  });

  it("summarizes size, ratio, format, fast, transparency, and watermark", () => {
    const base = defaultImageModelOptions("Doubao-Seedream-5.0-pro");
    expect(imageOptionsSummary(base)).toBe("2K · 自动 · jpeg · 水印");
    expect(
      imageOptionsSummary({
        ...base,
        promptMode: "fast",
        background: "transparent",
        format: "png",
        watermark: false,
      }),
    ).toBe("2K · 自动 · png · fast · 透明背景 · 无水印");
  });

  it("infers the preset from a model name", () => {
    expect(inferImagePresetFromModel("doubao-seedream-5-0-pro-260628")).toBe(
      "Doubao-Seedream-5.0-pro",
    );
    expect(inferImagePresetFromModel("doubao-seedream-5-5-261028")).toBe("Doubao-Seedream-5.5");
    expect(inferImagePresetFromModel("doubao-seedream-5-0-flash-260915")).toBe(
      "Doubao-Seedream-5.0-flash",
    );
    expect(inferImagePresetFromModel("ep-20240101")).toBeUndefined();
  });
});
