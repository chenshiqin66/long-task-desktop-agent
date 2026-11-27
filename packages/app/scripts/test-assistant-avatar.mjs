import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");

// The robot sits on the first visible reply, not only on a tight user+time+answer chain.
assert.match(css, /#main \.turn > \.msg\.assistant:not\(\.is-blank\)::before/);
assert.match(css, /#main \.turn > \.tool-group::after/);

// A hidden empty assistant left in front of a tool group must not steal the avatar.
assert.match(
  css,
  /#main \.turn > \.tool-group ~ \.msg\.assistant:not\(\.is-blank\)::before/,
);
assert.match(
  css,
  /#main \.turn > \.msg\.assistant:not\(\.is-blank\) ~ \.tool-group::after/,
);

// The face is the inline robot SVG, not an external asset that copy-static could drop.
assert.match(css, /data:image\/svg\+xml/);
assert.match(css, /M12 4v4/);
assert.match(css, /#e7f4f0/);

console.log("assistant avatar tests ok");
