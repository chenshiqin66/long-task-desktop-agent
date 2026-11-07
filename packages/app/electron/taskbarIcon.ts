import { deflateSync } from "node:zlib";

import type { TaskbarIconKind } from "./taskbarAttention.js";

/** Send button, `--accent` / `#14b8a6`. The lit taskbar frame is this flat color. */
export const SEND_GREEN = { r: 0x14, g: 0xb8, b: 0xa6 } as const;
/** Darker end of the sidebar mark gradient, `--accent-ink`. */
const ACCENT_INK = { r: 0x0b, g: 0x7c, b: 0x74 } as const;
/** Blink-off frame, `--ink`, so the green frame reads as a flash. */
const INK = { r: 0x1a, g: 0x23, b: 0x32 } as const;

export const ICON_SIZE = 128;

export interface IconPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function plateColor(kind: TaskbarIconKind, x: number, y: number): { r: number; g: number; b: number } {
  if (kind === "lit") return SEND_GREEN;
  if (kind === "dim") return INK;
  const t = (x + y) / (2 * (ICON_SIZE - 1));
  return {
    r: lerp(SEND_GREEN.r, ACCENT_INK.r, t),
    g: lerp(SEND_GREEN.g, ACCENT_INK.g, t),
    b: lerp(SEND_GREEN.b, ACCENT_INK.b, t),
  };
}

/** Signed distance to a rounded box centered on the origin. */
function sdRoundBox(px: number, py: number, half: number, radius: number): number {
  const dx = Math.abs(px) - (half - radius);
  const dy = Math.abs(py) - (half - radius);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
}

/**
 * The taskbar slot is the same size for every app. WeChat fills that slot;
 * a transparent margin makes the glyph look smaller inside it.
 * 1px inset keeps the antialiased edge from clipping.
 */
const PLATE_HALF = ICON_SIZE / 2 - 1;
const PLATE_RADIUS = ICON_SIZE * 0.22;

/**
 * Sidebar brand mark: a square ring rotated 45°, with the local right edge
 * missing (CSS `border-right-color: transparent`). Returns 0..1 coverage.
 * Sized off the plate so the mark scales with the full-bleed tile.
 */
function chevron(px: number, py: number): number {
  const c = Math.cos(Math.PI / 4);
  const lx = c * (px + py);
  const ly = c * (py - px);
  const half = PLATE_HALF * 0.5;
  const stroke = PLATE_HALF * 0.18;
  const ax = Math.abs(lx);
  const ay = Math.abs(ly);
  if (ax > half || ay > half) return 0;
  if (lx > half - stroke) return 0;
  const outside = ax < half - stroke && ay < half - stroke;
  return outside ? 0 : 1;
}

export function iconPixel(kind: TaskbarIconKind, x: number, y: number): IconPixel {
  const half = PLATE_HALF;
  const radius = PLATE_RADIUS;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const samples = 2;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples - ICON_SIZE / 2;
      const py = y + (sy + 0.5) / samples - ICON_SIZE / 2;
      const cover = Math.min(1, Math.max(0, 0.5 - sdRoundBox(px, py, half, radius)));
      if (cover <= 0) continue;
      const col = plateColor(kind, x, y);
      const mark = chevron(px, py);
      r += (mark ? 255 : col.r) * cover;
      g += (mark ? 255 : col.g) * cover;
      b += (mark ? 255 : col.b) * cover;
      a += cover;
    }
  }
  const n = samples * samples;
  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
    a: Math.round((a / n) * 255),
  };
}

export function iconRgba(kind: TaskbarIconKind): Buffer {
  const rgba = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  let i = 0;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const p = iconPixel(kind, x, y);
      rgba[i++] = p.r;
      rgba[i++] = p.g;
      rgba[i++] = p.b;
      rgba[i++] = p.a;
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function iconPng(kind: TaskbarIconKind): Buffer {
  const rgba = iconRgba(kind);
  const raw = Buffer.alloc(ICON_SIZE * (1 + ICON_SIZE * 4));
  for (let y = 0; y < ICON_SIZE; y++) {
    const row = y * (1 + ICON_SIZE * 4);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * ICON_SIZE * 4, (y + 1) * ICON_SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ICON_SIZE, 0);
  ihdr.writeUInt32BE(ICON_SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
