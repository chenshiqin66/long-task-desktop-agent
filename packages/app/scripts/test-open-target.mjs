import {
  normalizeOpenTarget,
  decodeBasicEntities,
} from "../dist/electron/openTargetNormalize.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(decodeBasicEntities("a&amp;b") === "a&b", "entities");

const mnt = normalizeOpenTarget(
  "/mnt/c/Users/陈仕勤/Desktop/temp-20261029/shanghai-country-parks.html",
  "win32",
);
assert(mnt.kind === "path", "mnt kind");
assert(
  mnt.value === "C:\\Users\\陈仕勤\\Desktop\\temp-20261029\\shanghai-country-parks.html",
  `mnt path got ${mnt.value}`,
);

const https = normalizeOpenTarget("https://example.com/x", "win32");
assert(https.kind === "url" && https.value === "https://example.com/x", "https");

console.log("openTarget ok");
