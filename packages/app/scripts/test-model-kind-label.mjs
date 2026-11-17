import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_KIND_LABELS, MODEL_KINDS, modelKindLabel } from "@agent/core";
import { composerModelOptionText, modelRowHeading } from "../dist/src/renderer/models.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");

assert.equal(modelRowHeading("画图", modelKindLabel("image")), "画图 · 生图");
assert.equal(composerModelOptionText("画图", MODEL_KIND_LABELS.image), "画图（生图）");
assert.equal(modelRowHeading("对话", modelKindLabel("text")), "对话 · 生文");
assert.equal(composerModelOptionText("短片", modelKindLabel("video")), "短片（生视频）");
assert.equal(composerModelOptionText("配音", MODEL_KIND_LABELS.audio), "配音（生音）");

for (const kind of MODEL_KINDS) {
  const match = new RegExp(`<option value="${kind}">([^<]+)</option>`).exec(html);
  assert.equal(match?.[1], MODEL_KIND_LABELS[kind]);
}

console.log("model kind label tests ok");
