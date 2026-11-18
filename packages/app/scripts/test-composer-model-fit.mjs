import assert from "node:assert/strict";
import {
  composerModelFitWidth,
  composerModelLabels,
  shouldOpenComposerModelOnKey,
} from "../dist/src/renderer/composerModelFit.js";

assert.deepEqual(composerModelLabels(["短（生文）", "很长的模型名称（生图）"], "短（生文）", false), ["短（生文）"]);
assert.deepEqual(composerModelLabels(["短（生文）", "很长的模型名称（生图）"], "短（生文）", true), [
  "短（生文）",
  "很长的模型名称（生图）",
]);

assert.equal(composerModelFitWidth(100, 29), 130);
assert.equal(composerModelFitWidth(100, 29, 120), 120);
assert.equal(composerModelFitWidth(10, 29, 120), 40);

assert.equal(shouldOpenComposerModelOnKey("ArrowDown"), true);
assert.equal(shouldOpenComposerModelOnKey(" "), true);
assert.equal(shouldOpenComposerModelOnKey("a"), false);
assert.equal(shouldOpenComposerModelOnKey("ArrowDown", true), true);
assert.equal(shouldOpenComposerModelOnKey("a", true), true);

console.log("composer model fit tests ok");
