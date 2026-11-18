import assert from "node:assert/strict";
import {
  ROBOT_ICON_PATHS,
  ROBOT_ICON_VIEWBOX,
  SLIDE_RIGHT_ICON_PATHS,
  SLIDE_RIGHT_ICON_VIEWBOX,
} from "../dist/src/renderer/explainIcons.js";

assert.equal(ROBOT_ICON_VIEWBOX, "0 0 1069 1024");
assert.equal(SLIDE_RIGHT_ICON_VIEWBOX, "0 0 1024 1024");
assert.equal(ROBOT_ICON_PATHS.length, 7);
assert.equal(SLIDE_RIGHT_ICON_PATHS.length, 5);
assert.match(ROBOT_ICON_PATHS[0].d, /M534\.755556 1001\.244444/);
assert.match(SLIDE_RIGHT_ICON_PATHS[3].d, /M609\.991111 522\.666667/);
assert.equal(SLIDE_RIGHT_ICON_PATHS[0].opacity, ".2");
assert.equal(SLIDE_RIGHT_ICON_PATHS[3].fill, "#FFFFFF");
for (const entry of ROBOT_ICON_PATHS) assert.equal(entry.fill, "#14b8a6");

console.log("explain icons tests ok");
