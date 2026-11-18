import assert from "node:assert/strict";
import {
  COMPOSER_INPUT_MAX,
  COMPOSER_INPUT_MIN,
  composerResizeHeight,
} from "../dist/src/renderer/composerResize.js";

assert.equal(COMPOSER_INPUT_MIN, 43);
assert.equal(COMPOSER_INPUT_MAX, 108);

assert.equal(composerResizeHeight(60, 200, 180), 80);
assert.equal(composerResizeHeight(60, 200, 220), 43);
assert.equal(composerResizeHeight(60, 200, 100), 108);
assert.equal(composerResizeHeight(43, 200, 200), 43);

console.log("composer resize tests ok");
