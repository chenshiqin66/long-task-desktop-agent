import assert from "node:assert/strict";
import { escapeAction } from "../dist/src/renderer/escapeKey.js";

const idle = {
  handled: false,
  composing: false,
  dialogOpen: false,
  findOpen: false,
  taskPanelOpen: false,
  viewingRun: false,
};

// nothing open, nothing running
assert.equal(escapeAction(idle), "none");

// the last resort stops the run on screen
assert.equal(escapeAction({ ...idle, viewingRun: true }), "stop");

// open panels close first, find bar before task panel
assert.equal(escapeAction({ ...idle, viewingRun: true, findOpen: true, taskPanelOpen: true }), "close-find");
assert.equal(escapeAction({ ...idle, viewingRun: true, taskPanelOpen: true }), "close-tasks");

// another handler already used this Esc: rename box, skill menu, context menu
assert.equal(escapeAction({ ...idle, viewingRun: true, handled: true }), "none");

// the config dialog closes itself
assert.equal(escapeAction({ ...idle, viewingRun: true, dialogOpen: true }), "none");

// Esc during IME composition cancels the composition only
assert.equal(escapeAction({ ...idle, viewingRun: true, composing: true }), "none");

console.log("escapeKey tests ok");
