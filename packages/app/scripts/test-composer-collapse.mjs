import assert from "node:assert/strict";
import { composerCollapsed } from "../dist/src/renderer/composerCollapse.js";

const base = { started: true, focused: false, hasDraft: false, held: false };
const folded = (over) => composerCollapsed({ ...base, ...over });

// A started session with nothing going on folds to one row.
assert.equal(folded({}), true);

// A session that has not started keeps its box open, with or without focus.
assert.equal(folded({ started: false }), false);
assert.equal(folded({ started: false, focused: true }), false);

// Focus, a draft (text or an image), or the app waiting on the box keeps it open.
assert.equal(folded({ focused: true }), false);
assert.equal(folded({ hasDraft: true }), false);
assert.equal(folded({ held: true }), false);

// Leaving the box with nothing typed folds it again.
assert.equal(folded({ focused: false, hasDraft: false, held: false }), true);

console.log("composer collapse tests passed");
