import assert from "node:assert/strict";
import { escapeAction } from "../dist/src/renderer/escapeKey.js";

const idle = {
  handled: false,
  composing: false,
  dialogOpen: false,
  workbenchOpen: false,
  findOpen: false,
  taskPanelOpen: false,
  libraryFormOpen: false,
  libraryOpen: false,
  viewingRun: false,
};

// nothing open, nothing running
assert.equal(escapeAction(idle), "none");

// the last resort stops the run on screen
assert.equal(escapeAction({ ...idle, viewingRun: true }), "stop");

// the workbench covers the window, so it closes before the find bar and before stopping
assert.equal(
  escapeAction({
    ...idle,
    viewingRun: true,
    workbenchOpen: true,
    findOpen: true,
    taskPanelOpen: true,
    libraryFormOpen: true,
    libraryOpen: true,
  }),
  "close-workbench",
);

// open panels close first: find → tasks → in-page 取消 form → library page → stop
assert.equal(escapeAction({ ...idle, viewingRun: true, findOpen: true, taskPanelOpen: true }), "close-find");
assert.equal(escapeAction({ ...idle, viewingRun: true, taskPanelOpen: true }), "close-tasks");
assert.equal(
  escapeAction({ ...idle, viewingRun: true, libraryFormOpen: true, libraryOpen: true }),
  "close-library-form",
);
assert.equal(escapeAction({ ...idle, libraryFormOpen: true, libraryOpen: true }), "close-library-form");
assert.equal(escapeAction({ ...idle, viewingRun: true, libraryOpen: true }), "close-library");
assert.equal(escapeAction({ ...idle, libraryOpen: true }), "close-library");

// another handler already used this Esc: rename box, skill menu, context menu
assert.equal(escapeAction({ ...idle, viewingRun: true, handled: true }), "none");

// the config dialog closes itself
assert.equal(escapeAction({ ...idle, viewingRun: true, dialogOpen: true }), "none");

// Esc during IME composition cancels the composition only
assert.equal(escapeAction({ ...idle, viewingRun: true, composing: true }), "none");

console.log("escapeKey tests ok");
