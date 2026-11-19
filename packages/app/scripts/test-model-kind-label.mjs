import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_KIND_LABELS, MODEL_KINDS, modelKindLabel } from "@agent/core";
import {
  chatModelsOf,
  composerModelOptionText,
  inUseId,
  modelRowHeading,
  searchModelsOf,
} from "../dist/src/renderer/models.js";

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

assert.equal(modelRowHeading("搜索", modelKindLabel("search")), "搜索 · 网搜");
assert.match(html, /id="model-kind-hint"/);

// The composer picker lists chat models only. Search models are in use alongside the chat model.
const pool = [
  { id: "web-a", kind: "search" },
  { id: "chat" },
  { id: "draw", kind: "image" },
  { id: "web-b", kind: "search" },
];
assert.deepEqual(chatModelsOf(pool).map((m) => m.id), ["chat", "draw"]);
assert.deepEqual(searchModelsOf(pool).map((m) => m.id), ["web-a", "web-b"]);
assert.equal(inUseId(chatModelsOf(pool), "web-a"), "chat", "a search id never selects a chat model");
assert.equal(inUseId(chatModelsOf(pool), "draw"), "draw");
assert.equal(inUseId(searchModelsOf(pool), "web-b"), "web-b");
assert.equal(inUseId(searchModelsOf(pool), "chat"), "web-a", "a chat id never selects a search model");
assert.equal(inUseId(searchModelsOf([{ id: "chat" }]), "x"), undefined);

console.log("model kind label tests ok");
