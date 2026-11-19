import assert from "node:assert/strict";
import {
  THINKING_FALLBACK,
  THINKING_FRAMES,
  thinkingLabel,
  thinkingText,
} from "../dist/src/renderer/thinkingHint.js";

// The phase text loses its trailing dots; the animation draws them.
assert.equal(thinkingLabel("思考中……"), "思考中");
assert.equal(thinkingLabel("执行工具…"), "执行工具");
assert.equal(thinkingLabel("运行中..."), "运行中");
assert.equal(thinkingLabel("等待确认权限…"), "等待确认权限");
assert.equal(thinkingLabel("已请求停止"), "已请求停止");
// No phase yet: still say something.
assert.equal(thinkingLabel(""), THINKING_FALLBACK);
assert.equal(thinkingLabel(undefined), THINKING_FALLBACK);
assert.equal(thinkingLabel("……"), THINKING_FALLBACK);

// 思考中 → 思考中… → 思考中…… → around again.
assert.equal(THINKING_FRAMES, 3);
assert.equal(thinkingText("思考中", 0), "思考中");
assert.equal(thinkingText("思考中", 1), "思考中…");
assert.equal(thinkingText("思考中", 2), "思考中……");
assert.equal(thinkingText("思考中", 3), "思考中");
assert.equal(thinkingText("思考中", -1), "思考中……");

console.log("thinkingHint tests ok");
