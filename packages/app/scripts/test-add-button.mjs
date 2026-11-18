import assert from "node:assert/strict";
import { ADD_ICON_PATHS } from "../dist/src/renderer/addButton.js";

assert.equal(ADD_ICON_PATHS.length, 3);
assert.match(ADD_ICON_PATHS[0], /M256 512a32 32/);
assert.match(ADD_ICON_PATHS[1], /M480 288a32 32/);
assert.match(ADD_ICON_PATHS[2], /M512 0a512 512 0 1 0 512 512/);

console.log("addButton tests ok");
