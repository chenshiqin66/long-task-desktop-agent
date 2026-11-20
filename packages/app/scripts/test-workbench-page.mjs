import assert from "node:assert/strict";
import { savedWorkbenchPage } from "../dist/src/renderer/workbench.js";

// Known pages come back as they were saved.
assert.equal(savedWorkbenchPage(() => "browser"), "browser");
assert.equal(savedWorkbenchPage(() => "folders"), "folders");

// Nothing saved, a page this build does not have, or storage that throws: the first menu item.
assert.equal(savedWorkbenchPage(() => null), "folders");
assert.equal(savedWorkbenchPage(() => ""), "folders");
assert.equal(savedWorkbenchPage(() => "notes"), "folders");
assert.equal(savedWorkbenchPage(() => "Browser"), "folders");
assert.equal(
  savedWorkbenchPage(() => {
    throw new Error("storage is blocked");
  }),
  "folders",
);

console.log("workbench page tests passed");
