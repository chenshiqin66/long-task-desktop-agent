import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLTIP_SUPPRESS, shouldSuppressTooltip } from "../dist/src/renderer/tooltip.js";

assert.deepEqual([...TOOLTIP_SUPPRESS], ["#composer", ".store-tab"]);

function el(matches) {
  return {
    closest(sel) {
      return matches.includes(sel) ? {} : null;
    },
  };
}

assert.equal(shouldSuppressTooltip(el([".store-tab"])), true);
assert.equal(shouldSuppressTooltip(el(["#composer"])), true);
assert.equal(shouldSuppressTooltip(el([".store-tab", "#composer"])), true);
assert.equal(shouldSuppressTooltip(el([])), false);
// Other controls with useful tips must still be allowed to show one.
assert.equal(shouldSuppressTooltip(el([".btn-image"])), false);
assert.equal(shouldSuppressTooltip(el(["#btn-mic"])), false);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");
const mainSrc = readFileSync(join(root, "src/renderer/main.ts"), "utf8");
const tipSrc = readFileSync(join(root, "src/renderer/tooltip.ts"), "utf8");

const tabsBlock = html.match(/id="store-tabs"[\s\S]*?<\/div>/);
assert.ok(tabsBlock, "store-tabs markup is missing");
assert.match(tabsBlock[0], /data-store-tab="meta"/);
assert.match(tabsBlock[0], /data-store-tab="messages"/);
assert.match(tabsBlock[0], /data-store-tab="trace"/);
assert.match(tabsBlock[0], /data-store-tab="context"/);
assert.doesNotMatch(tabsBlock[0], /\stitle=/);
assert.doesNotMatch(tabsBlock[0], /data-tip=/);

// The four tabs must keep their labels and switching hooks.
assert.match(html, /class="view-tab-label">meta</);
assert.match(html, /class="view-tab-label">messages</);
assert.match(html, /class="view-tab-label">trace</);
assert.match(html, /class="view-tab-label">context</);
assert.match(mainSrc, /function setStoreTabLabel/);
assert.match(mainSrc, /setMainView\(btn\.dataset\.storeTab\)/);
assert.match(mainSrc, /`\$\{part\} \(\$\{count\}\)`/);

// Labels update the visible text only; they must not rehang a repeating toast.
const setter = mainSrc.match(/function setStoreTabLabel\([\s\S]*?\n\}/);
assert.ok(setter, "setStoreTabLabel is missing");
assert.doesNotMatch(setter[0], /tab\.title\s*=/);
assert.match(setter[0], /removeAttribute\("title"\)/);
assert.match(setter[0], /removeAttribute\("data-tip"\)/);

// Shared tooltip machinery stays in place for other controls.
assert.match(tipSrc, /shouldSuppressTooltip/);
assert.match(tipSrc, /className = "app-tip"/);
assert.match(html, /data-tip="上传图片"/);
assert.match(html, /data-tip="语音输入"/);

console.log("store tab tooltip tests ok");
