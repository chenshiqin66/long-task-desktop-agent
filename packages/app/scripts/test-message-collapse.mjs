import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_COLLAPSE_LINES,
  MESSAGE_COLLAPSE_LINES,
  MSG_COLLAPSE_TOGGLE_CLASS,
  collapsedMaxHeight,
  hiddenCollapseLines,
  messageCollapseToggleLabel,
  shouldCollapseMessage,
  shouldToggleMessageCollapse,
} from "../dist/src/renderer/messageCollapse.js";

assert.equal(MESSAGE_COLLAPSE_LINES, 5);
assert.equal(ASSISTANT_COLLAPSE_LINES, 30);
assert.equal(MSG_COLLAPSE_TOGGLE_CLASS, "msg-collapse-toggle");

// Five typography lines, plus padding/border when the bubble uses border-box.
assert.equal(collapsedMaxHeight({ lineHeight: 20, paddingY: 16, borderY: 0, boxSizing: "border-box" }), 116);
assert.equal(collapsedMaxHeight({ lineHeight: 20, paddingY: 16, borderY: 0, boxSizing: "content-box" }), 100);
assert.equal(collapsedMaxHeight({ lineHeight: 18.125, paddingY: 2, borderY: 0 }), 18.125 * 5 + 2);
assert.equal(
  collapsedMaxHeight({ lineHeight: 20, paddingY: 0, borderY: 0, boxSizing: "content-box", lines: ASSISTANT_COLLAPSE_LINES }),
  600,
);

// A sixth line overflows; 1px of rounding slack does not.
assert.equal(shouldCollapseMessage(118, 116), true);
assert.equal(shouldCollapseMessage(117, 116), false);
assert.equal(shouldCollapseMessage(116, 116), false);

assert.equal(hiddenCollapseLines(116, 116, 20), 0);
assert.equal(hiddenCollapseLines(117, 116, 20), 0);
assert.equal(hiddenCollapseLines(136, 116, 20), 1);
assert.equal(hiddenCollapseLines(176, 116, 20), 3);
assert.equal(hiddenCollapseLines(800, 600, 20), 10);

assert.equal(messageCollapseToggleLabel({ expanded: true, hiddenLines: 12 }), "收起");
assert.equal(messageCollapseToggleLabel({ expanded: false, hiddenLines: 12 }), "展开全部（还有 12 行）");
assert.equal(messageCollapseToggleLabel({ expanded: false }), "还有更多，点击展开");
assert.equal(messageCollapseToggleLabel({ expanded: false, hiddenLines: 0 }), "还有更多，点击展开");

// Clicks expand only when the bubble is long and not in the sticky one-line fold.
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: false, selecting: false }), true);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: true, interactive: false, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: false, stuck: false, interactive: false, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: true, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: false, selecting: true }), false);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");
assert.match(css, /\.msg-collapse-toggle\s*\{/);
assert.match(css, /\.msg\.assistant \.msg-body\.is-collapsed::after\s*\{/);
assert.match(css, /height:\s*3\.8em/);
assert.match(css, /linear-gradient\(\s*to bottom/);
assert.match(css, /\.msg\.assistant:has\(\.msg-collapse-toggle\) \+ \.msg-time/);
assert.doesNotMatch(css, /mask-image:\s*linear-gradient\(to bottom, #000 calc\(100% - 0\.9em\)/);

console.log("messageCollapse tests ok");
