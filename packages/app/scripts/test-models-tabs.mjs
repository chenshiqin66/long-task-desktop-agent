import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS_TABS, modelsForTab, modelsTabOfKind } from "../dist/src/renderer/models.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");

// Tab order and labels follow the library's generation-target grouping.
assert.deepEqual(
  MODELS_TABS.map((tab) => tab.id),
  ["text", "image", "speech", "video", "other"],
);
assert.deepEqual(
  MODELS_TABS.map((tab) => tab.label),
  ["生文", "生图", "语音", "生视频", "其他"],
);

// Kind → tab: speech covers TTS and ASR; search lands in the extensible "other" tab.
assert.equal(modelsTabOfKind("text"), "text");
assert.equal(modelsTabOfKind("image"), "image");
assert.equal(modelsTabOfKind("tts"), "speech");
assert.equal(modelsTabOfKind("asr"), "speech");
assert.equal(modelsTabOfKind("video"), "video");
assert.equal(modelsTabOfKind("search"), "other");

const pool = [
  { id: "chat", kind: "text" },
  { id: "draw", kind: "image" },
  { id: "say", kind: "tts" },
  { id: "hear", kind: "asr" },
  { id: "clip", kind: "video" },
  { id: "web", kind: "search" },
  { id: "legacy" }, // missing kind defaults to text
  { id: "old-audio", kind: "audio" }, // legacy audio reads as tts
];
assert.deepEqual(modelsForTab(pool, "text").map((m) => m.id), ["chat", "legacy"]);
assert.deepEqual(modelsForTab(pool, "image").map((m) => m.id), ["draw"]);
assert.deepEqual(modelsForTab(pool, "speech").map((m) => m.id), ["say", "hear", "old-audio"]);
assert.deepEqual(modelsForTab(pool, "video").map((m) => m.id), ["clip"]);
assert.deepEqual(modelsForTab(pool, "other").map((m) => m.id), ["web"]);
assert.deepEqual(modelsForTab(undefined, "text"), []);
assert.deepEqual(modelsForTab([], "other"), []);

// Every model lands in exactly one tab — nothing hides between tabs.
const covered = MODELS_TABS.reduce((n, tab) => n + modelsForTab(pool, tab.id).length, 0);
assert.equal(covered, pool.length);

// The page hosts the tab strip; the add/edit form stays untouched.
assert.match(html, /id="models-tabs"[^>]*role="tablist"/);
assert.match(html, /id="models-form"/);

const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");
// Current cards (no 「使用」 button) must not leave an in-flow actions column
// that wraps and pads the card with a blank band.
assert.match(css, /\.mcp-row\.is-current-model \{[^}]*position:\s*relative/s);
assert.match(css, /\.mcp-row\.is-current-model \.mcp-actions \{[^}]*position:\s*absolute/s);

// API Key can be revealed in place; it stays a password field by default.
assert.match(html, /id="model-apiKey"[^>]*type="password"/);
assert.match(html, /<button(?=[^>]*type="button")(?=[^>]*id="model-apiKey-toggle")(?=[^>]*aria-label="显示 API Key")[^>]*>/);
assert.match(html, /class="field-secret"/);
assert.match(css, /\.field-secret-toggle/);

// Compact segmented tab bar: one short row, no UA button chrome, no vertical stretch.
assert.match(css, /\.models-tabs \{[^}]*flex-wrap:\s*nowrap/s);
assert.match(css, /\.models-tabs \{[^}]*flex:\s*0 0 auto/s);
assert.match(css, /\.models-tab \{[^}]*appearance:\s*none/s);
assert.match(css, /\.models-tab \{[^}]*min-height:\s*0/s);

// Model cards stay content-sized one-line rows; hidden hover actions do not take layout space.
assert.match(css, /#models-page \.models-list \.mcp-row-main \{[^}]*flex-wrap:\s*nowrap/s);
assert.match(css, /#models-page \.models-list \.mcp-actions-hover \{[^}]*width:\s*0/s);
assert.match(css, /#models-page \.models-list \.mcp-row:hover \.mcp-actions-hover[^{]*\{[^}]*width:\s*auto/s);
// Revealed in flow, the button labels must stay on one line.
assert.match(css, /#models-page \.models-list \.mcp-actions \.mcp-btn \{[^}]*white-space:\s*nowrap/s);
// Current cards keep the actions cluster in flow so the revealed group sits on
// the right edge instead of overlaying the summary.
assert.match(css, /#models-page \.models-list \.mcp-row\.is-current-model \.mcp-actions \{[^}]*position:\s*static/s);

console.log("models tabs tests ok");
