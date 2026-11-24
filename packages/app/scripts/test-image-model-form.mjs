import assert from "node:assert/strict";
import {
  IMAGE_MODEL_PRESETS,
  defaultImageModelOptions,
  imageBackgroundForTurn,
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

const transparent = {
  ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
  background: "transparent",
  format: "png",
};
assert.equal(imageBackgroundForTurn(transparent, 1), "transparent");
assert.equal(imageBackgroundForTurn(transparent, 0), "opaque");
assert.equal(imageBackgroundForTurn(transparent, 2), "opaque");

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");
for (const id of [
  "model-image-options",
  "model-image-tabs",
  "model-image-blurb",
  "model-image-sizes",
  "model-image-ratios",
  "model-image-formats",
  "model-image-backgrounds",
  "model-image-watermark",
  "model-image-prompt-modes",
  "model-image-prompt-note",
  "model-image-baseurl-hint",
  "composer-image-chip",
  "composer-image-summary",
  "composer-image-pop",
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
console.log("image model form tests ok");
