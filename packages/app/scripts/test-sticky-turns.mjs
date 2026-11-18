import assert from "node:assert/strict";
import { shouldReleaseStuck } from "../dist/src/renderer/stickyTurns.js";

const edge = 100;
const one = 32;

// A later bubble releases after the bar moves down by about a line.
assert.equal(shouldReleaseStuck({ top: edge + Math.max(one, 16) + 1, edge, one, scrollTop: 240 }), true);
assert.equal(shouldReleaseStuck({ top: edge, edge, one, scrollTop: 240 }), false);

// The first bubble stays at the viewport top, so arriving at the start must release it.
assert.equal(shouldReleaseStuck({ top: edge, edge, one, scrollTop: 0 }), true);
assert.equal(shouldReleaseStuck({ top: edge + 2, edge, one, scrollTop: 1 }), true);
assert.equal(shouldReleaseStuck({ top: edge, edge, one, scrollTop: 80 }), false);
assert.equal(shouldReleaseStuck({ top: edge + 20, edge, one, scrollTop: 0 }), false);

console.log("stickyTurns tests ok");
