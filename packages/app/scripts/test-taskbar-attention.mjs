import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  attentionDelay,
  initialAttention,
  reduceAttention,
  TASKBAR_FLASH_MS,
} from "../dist/electron/taskbarAttention.js";
import { ICON_SIZE, iconPixel, iconPng, SEND_GREEN } from "../dist/electron/taskbarIcon.js";

{
  let state = initialAttention();
  assert.equal(attentionDelay(state), null);
  const started = reduceAttention(state, { type: "need" });
  assert.equal(started.show, "lit");
  assert.equal(attentionDelay(started), TASKBAR_FLASH_MS);
  assert.equal(reduceAttention(started, { type: "need" }), started, "a second prompt must not restart the blink");

  const dim = reduceAttention(started, { type: "tick" });
  assert.equal(dim.show, "dim");
  const lit = reduceAttention(dim, { type: "tick" });
  assert.equal(lit.show, "lit");
  assert.equal(attentionDelay(lit), TASKBAR_FLASH_MS, "blink keeps going until the prompt is cleared");

  const cleared = reduceAttention(lit, { type: "clear" });
  assert.deepEqual(cleared, { pending: false, show: "rest" });
  assert.equal(attentionDelay(cleared), null);
  assert.equal(reduceAttention(cleared, { type: "clear" }), cleared);
  assert.equal(reduceAttention(cleared, { type: "tick" }), cleared);
}

{
  const mid = ICON_SIZE / 2;
  const lit = iconPixel("lit", mid, mid);
  assert.equal(lit.a, 255);
  assert.equal(lit.r, SEND_GREEN.r);
  assert.equal(lit.g, SEND_GREEN.g);
  assert.equal(lit.b, SEND_GREEN.b);

  const dim = iconPixel("dim", mid, mid);
  assert.ok(dim.r < 40 && dim.g < 50 && dim.b < 70, "blink-off frame is the ink mark, not green");

  const rest = iconPixel("rest", mid, mid);
  assert.ok(rest.g > dim.g && rest.g < lit.g, "idle mark is the teal gradient, between ink and send-green");

  assert.equal(iconPixel("lit", 0, 0).a, 0, "rounded icon keeps a transparent corner");

  let minX = ICON_SIZE;
  let maxX = 0;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      if (iconPixel("lit", x, y).a <= 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  assert.ok(minX <= 2, "glyph starts at the icon edge, like WeChat");
  assert.ok(maxX - minX + 1 >= ICON_SIZE * 0.95, "glyph fills the taskbar slot");

  let white = 0;
  let green = 0;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const p = iconPixel("lit", x, y);
      if (p.a > 200 && p.r > 240 && p.g > 240 && p.b > 240) white++;
      if (p.a > 200 && Math.abs(p.r - SEND_GREEN.r) < 8 && Math.abs(p.g - SEND_GREEN.g) < 8) green++;
    }
  }
  assert.ok(white > 40, "lit icon still has the white brand stroke");
  assert.ok(green > 1000, "lit icon is mostly the send-button green");
}

{
  const png = iconPng("lit");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, ICON_SIZE);
  assert.equal(height, ICON_SIZE);
  assert.equal(png[25], 6, "RGBA");

  let offset = 8;
  const parts = [];
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === "IDAT") parts.push(data);
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const row = 1 + ICON_SIZE * 4;
  const mid = Math.floor(ICON_SIZE / 2);
  const i = mid * row + 1 + mid * 4;
  const pixel = iconPixel("lit", mid, mid);
  assert.equal(raw[i], pixel.r);
  assert.equal(raw[i + 1], pixel.g);
  assert.equal(raw[i + 2], pixel.b);
  assert.equal(raw[i + 3], pixel.a);
}

console.log("taskbar attention tests ok");
