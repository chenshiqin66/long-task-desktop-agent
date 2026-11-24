import assert from "node:assert/strict";
import {
  defaultMediaFileName,
  extensionForMediaMime,
  fileNameFromRelativePath,
  parseDataUrl,
  saveDialogFilters,
} from "../dist/src/mediaExport.js";

assert.equal(fileNameFromRelativePath("images/img_ab12cd.png"), "img_ab12cd.png");
assert.equal(fileNameFromRelativePath("videos/vid_ffee.mp4"), "vid_ffee.mp4");
assert.equal(fileNameFromRelativePath("images/explain-img_aa.gif"), "explain-img_aa.gif");
assert.equal(fileNameFromRelativePath("images/../../meta.json"), null);
assert.equal(fileNameFromRelativePath("/tmp/x.png"), null);
assert.equal(fileNameFromRelativePath(""), null);

assert.equal(extensionForMediaMime("image/jpeg", "image"), "jpg");
assert.equal(extensionForMediaMime("video/quicktime", "video"), "mov");
assert.equal(extensionForMediaMime(undefined, "image"), "png");
assert.equal(extensionForMediaMime(undefined, "video"), "mp4");

assert.equal(defaultMediaFileName({ kind: "image", relativePath: "images/img_ab12cd.png" }), "img_ab12cd.png");
assert.equal(defaultMediaFileName({ kind: "video", relativePath: "videos/vid_ffee.mp4" }), "vid_ffee.mp4");
assert.equal(defaultMediaFileName({ kind: "image", mime: "image/jpeg" }), "image.jpg");
assert.equal(defaultMediaFileName({ kind: "video", mime: "video/webm" }), "video.webm");
assert.equal(defaultMediaFileName({ kind: "image", fallbackName: "photo.webp" }), "photo.webp");
assert.equal(defaultMediaFileName({ kind: "image", relativePath: "images/../x.png" }), "image.png");

const filters = saveDialogFilters("image", "img_ab12cd.png");
assert.equal(filters[0]?.extensions[0], "png");
assert.equal(filters[0]?.name, "图片");
assert.equal(saveDialogFilters("video", "clip.mp4")[0]?.name, "视频");

const parsed = parseDataUrl("data:image/png;base64,AQI=");
assert.ok(parsed);
assert.equal(parsed.mime, "image/png");
assert.deepEqual(Array.from(parsed.bytes), [1, 2]);

assert.equal(parseDataUrl("not a data url"), null);
assert.equal(parseDataUrl("data:image/png;base64,"), null);

const plain = parseDataUrl("data:text/plain,hello%20ok");
assert.ok(plain);
assert.equal(plain.mime, "text/plain");
assert.equal(new TextDecoder().decode(plain.bytes), "hello ok");

console.log("mediaExport tests ok");
