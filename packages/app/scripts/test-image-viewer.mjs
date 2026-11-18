import assert from "node:assert/strict";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  neighborIndex,
  panAfterZoom,
  stepZoom,
} from "../dist/src/renderer/imageViewer.js";

assert.equal(clampZoom(0), ZOOM_MIN);
assert.equal(clampZoom(100), ZOOM_MAX);
assert.equal(clampZoom(1), 1);

assert.equal(stepZoom(1, 1) > 1, true);
assert.equal(stepZoom(1, -1) < 1, true);
assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
assert.equal(stepZoom(stepZoom(1, 1), -1), 1);

assert.equal(neighborIndex(0, -1, 3), null);
assert.equal(neighborIndex(2, 1, 3), null);
assert.equal(neighborIndex(1, -1, 3), 0);
assert.equal(neighborIndex(1, 1, 3), 2);
assert.equal(neighborIndex(0, 1, 1), null);
assert.equal(neighborIndex(0, 1, 0), null);

const still = panAfterZoom(10, -4, 1, 2, 10, -4);
assert.equal(still.x, 10);
assert.equal(still.y, -4);

const reset = panAfterZoom(40, 20, 2, 1, 8, 6);
assert.equal(reset.x, 0);
assert.equal(reset.y, 0);

console.log("imageViewer tests ok");
