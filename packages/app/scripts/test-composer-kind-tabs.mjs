import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");
const tabs = html.match(/id="composer-kind"[\s\S]*?<\/div>/);
assert.ok(tabs, "composer-kind tablist is missing");
const block = tabs[0];

const textTab = block.match(/<button[^>]*data-kind="text"[^>]*>[\s\S]*?<\/button>/);
assert.ok(textTab, "text kind tab is missing");
assert.match(textTab[0], />Do-it<\/button>/);
assert.match(textTab[0], /aria-label="Do-it"/);
assert.match(textTab[0], /title="Do-it"/);
assert.doesNotMatch(textTab[0], />Chat</);
assert.match(textTab[0], /data-kind="text"/);

assert.match(block, /data-kind="image"[^>]*>图<\/button>/);
assert.match(block, /data-kind="tts"[^>]*>语音<\/button>/);
assert.match(block, /data-kind="video"[^>]*>视频<\/button>/);

console.log("composer kind tab tests ok");
