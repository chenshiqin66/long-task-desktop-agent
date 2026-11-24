import assert from "node:assert/strict";
import {
  MESSAGE_COLLAPSE_LINES,
  collapsedMaxHeight,
  shouldCollapseMessage,
  shouldToggleMessageCollapse,
} from "../dist/src/renderer/messageCollapse.js";

assert.equal(MESSAGE_COLLAPSE_LINES, 5);

// Five typography lines, plus padding/border when the bubble uses border-box.
assert.equal(collapsedMaxHeight({ lineHeight: 20, paddingY: 16, borderY: 0, boxSizing: "border-box" }), 116);
assert.equal(collapsedMaxHeight({ lineHeight: 20, paddingY: 16, borderY: 0, boxSizing: "content-box" }), 100);
assert.equal(collapsedMaxHeight({ lineHeight: 18.125, paddingY: 2, borderY: 0 }), 18.125 * 5 + 2);

// A sixth line overflows; 1px of rounding slack does not.
assert.equal(shouldCollapseMessage(118, 116), true);
assert.equal(shouldCollapseMessage(117, 116), false);
assert.equal(shouldCollapseMessage(116, 116), false);

// Clicks expand only when the bubble is long and not in the sticky one-line fold.
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: false, selecting: false }), true);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: true, interactive: false, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: false, stuck: false, interactive: false, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: true, selecting: false }), false);
assert.equal(shouldToggleMessageCollapse({ long: true, stuck: false, interactive: false, selecting: true }), false);

console.log("messageCollapse tests ok");