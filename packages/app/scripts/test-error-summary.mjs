import assert from "node:assert/strict";
import { errorSummary } from "../dist/src/renderer/errorSummary.js";

// The case that prompted this: an HTTP error whose body is JSON.
const quota =
  'HTTP 429: {"error":{"message":"Token Plan quota has been exceeded (request_id: 94c1ae437aa0cd51-20261118194426492)","type":"invalid_request_error","param":null,"code":"429"},"request_id":"94c1ae437aa0cd51-20261118194426492"}';
assert.equal(errorSummary(quota), "错误 · HTTP 429 · Token Plan quota has been exceeded");

// A flat {"message": …} body, and a string error.
assert.equal(errorSummary('HTTP 500: {"message":"upstream down"}'), "错误 · HTTP 500 · upstream down");
assert.equal(errorSummary('HTTP 401: {"error":"invalid key"}'), "错误 · HTTP 401 · invalid key");

// Not JSON: keep the text. Not HTTP: no status part.
assert.equal(errorSummary("HTTP 502: Bad Gateway"), "错误 · HTTP 502 · Bad Gateway");
assert.equal(errorSummary("fetch failed"), "错误 · fetch failed");
assert.equal(
  errorSummary("TypeError: fetch failed (POST https://api.openai.com/v1/chat/completions)"),
  "错误 · 连不上模型接口 · https://api.openai.com/v1/chat/completions",
);
assert.equal(errorSummary("HTTP 400: {broken"), "错误 · HTTP 400 · {broken");

// Empty and long input stay one short line.
assert.equal(errorSummary(""), "错误");
assert.equal(errorSummary("   "), "错误");
const long = errorSummary(`x ${"很长".repeat(100)}`);
assert.ok(long.length <= "错误 · ".length + 81, long);
assert.ok(long.endsWith("…"));
assert.ok(!errorSummary("line one\nline two").includes("\n"));

console.log("errorSummary tests ok");
