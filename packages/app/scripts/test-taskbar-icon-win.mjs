// Run with --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { mock } from "node:test";

// koffi itself loads anywhere; it is user32.dll that is missing off Windows, so loading it throws.
let loads = 0;
mock.module("koffi", {
  defaultExport: {
    load(name) {
      loads += 1;
      throw new Error(`cannot load ${name}`);
    },
    struct: () => ({}),
  },
});

const { applyWinTaskbarIcon } = await import("../dist/electron/taskbarIconWin.js");
assert.equal(loads, 0, "importing the module must not load Windows DLLs");

const win = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) };
const platform = process.platform;
try {
  Object.defineProperty(process, "platform", { value: "linux" });
  assert.equal(applyWinTaskbarIcon(win, "rest"), false, "other platforms fall back to setIcon");
  assert.equal(loads, 0, "other platforms never touch the DLLs");

  Object.defineProperty(process, "platform", { value: "win32" });
  assert.equal(applyWinTaskbarIcon(win, "rest"), false, "a DLL that will not load falls back to setIcon");
} finally {
  Object.defineProperty(process, "platform", { value: platform });
}

console.log("taskbarIconWin tests ok");
