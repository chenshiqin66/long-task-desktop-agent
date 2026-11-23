import assert from "node:assert/strict";
import {
  IMAGE_MODEL_PRESETS,
  defaultImageModelOptions,
  imageOptionsSummary,
  inferImagePresetFromModel,
  mergeImageOptions,
  normalizeImageModelOptions,
} from "../dist/src/renderer/imageModelForm.js";

assert.equal(IMAGE_MODEL_PRESETS.length, 3);
assert.equal(defaultImageModelOptions("Doubao-Seedream-5.5").format, "png");
assert.equal(defaultImageModelOptions("Doubao-Seedream-5.5").background, "auto");
assert.equal(
  imageOptionsSummary(defaultImageModelOptions("Doubao-Seedream-5.0-pro")),
  "2K · 自动 · jpeg · 水印",
);
assert.equal(
  inferImagePresetFromModel("doubao-seedream-5-0-flash-260915"),
  "Doubao-Seedream-5.0-flash",
);
assert.deepEqual(
  mergeImageOptions(defaultImageModelOptions("Doubao-Seedream-5.0-pro"), {
    size: "1K",
    ratio: "1:1",
  }),
  { ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"), size: "1K", ratio: "1:1" },
);
assert.throws(
  () =>
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
  /尺寸/,
);
console.log("image model form tests ok");
