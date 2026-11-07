import koffi from "koffi";
import type { BrowserWindow } from "electron";

import type { TaskbarIconKind } from "./taskbarAttention.js";
import { ICON_SIZE, iconRgba } from "./taskbarIcon.js";

/**
 * Electron's setIcon always submits SM_CXSMICON (16px at 96 DPI, scaled with
 * DPI). Windows 11 draws that small icon in the taskbar, so the glyph stays
 * smaller than WeChat, which is a normal taskbar icon (~24px logical).
 * A 256px ICON_SMALL is what the shell scales into that full slot.
 * https://learn.microsoft.com/en-us/answers/questions/712281
 */
const HICON_SIZE = 256;
const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const kernel32 = koffi.load("kernel32.dll");

const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32_t",
  biWidth: "int32_t",
  biHeight: "int32_t",
  biPlanes: "uint16_t",
  biBitCount: "uint16_t",
  biCompression: "uint32_t",
  biSizeImage: "uint32_t",
  biXPelsPerMeter: "int32_t",
  biYPelsPerMeter: "int32_t",
  biClrUsed: "uint32_t",
  biClrImportant: "uint32_t",
});

const ICONINFO = koffi.struct("ICONINFO", {
  fIcon: "int",
  xHotspot: "uint32_t",
  yHotspot: "uint32_t",
  hbmMask: "intptr",
  hbmColor: "intptr",
});

const SendMessageW = user32.func(
  "intptr __stdcall SendMessageW(intptr hWnd, uint32_t Msg, uintptr_t wParam, intptr lParam)",
);
const GetDC = user32.func("intptr __stdcall GetDC(intptr hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(intptr hWnd, intptr hDC)");
const CreateDIBSection = gdi32.func(
  "intptr __stdcall CreateDIBSection(intptr hdc, const BITMAPINFOHEADER *pbmi, uint32_t usage, _Out_ void **ppvBits, intptr hSection, uint32_t offset)",
);
const CreateBitmap = gdi32.func(
  "intptr __stdcall CreateBitmap(int nWidth, int nHeight, uint32_t nPlanes, uint32_t nBitCount, const uint8_t *lpBits)",
);
const CreateIconIndirect = user32.func("intptr __stdcall CreateIconIndirect(const ICONINFO *piconinfo)");
const DeleteObject = gdi32.func("int __stdcall DeleteObject(intptr ho)");
const RtlMoveMemory = kernel32.func(
  "void __stdcall RtlMoveMemory(void *Destination, const uint8_t *Source, uintptr_t Length)",
);

let failed = false;
const handles = new Map<TaskbarIconKind, bigint>();

function hwndOf(win: BrowserWindow): bigint {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

/** 128px RGBA stretched to a 256px bottom-up premultiplied BGRA DIB. */
function hiconPixels(kind: TaskbarIconKind): Buffer {
  const src = iconRgba(kind);
  const scale = HICON_SIZE / ICON_SIZE;
  const out = Buffer.alloc(HICON_SIZE * HICON_SIZE * 4);
  for (let y = 0; y < HICON_SIZE; y++) {
    const sy = Math.min(ICON_SIZE - 1, Math.floor(y / scale));
    const dstRow = (HICON_SIZE - 1 - y) * HICON_SIZE * 4;
    const srcRow = sy * ICON_SIZE * 4;
    for (let x = 0; x < HICON_SIZE; x++) {
      const sx = Math.min(ICON_SIZE - 1, Math.floor(x / scale));
      const s = srcRow + sx * 4;
      const d = dstRow + x * 4;
      const a = src[s + 3] ?? 0;
      out[d] = Math.round(((src[s + 2] ?? 0) * a) / 255);
      out[d + 1] = Math.round(((src[s + 1] ?? 0) * a) / 255);
      out[d + 2] = Math.round(((src[s] ?? 0) * a) / 255);
      out[d + 3] = a;
    }
  }
  return out;
}

function createHicon(kind: TaskbarIconKind): bigint {
  const pixels = hiconPixels(kind);
  const hdc = GetDC(0n) as bigint;
  try {
    const header = {
      biSize: 40,
      biWidth: HICON_SIZE,
      biHeight: HICON_SIZE,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: pixels.length,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const bits: unknown[] = [null];
    const color = CreateDIBSection(hdc, header, 0, bits, 0n, 0) as bigint;
    if (!color) throw new Error("CreateDIBSection failed");
    const maskBits = Buffer.alloc(HICON_SIZE * HICON_SIZE);
    const mask = CreateBitmap(HICON_SIZE, HICON_SIZE, 1, 1, maskBits) as bigint;
    if (!mask) {
      DeleteObject(color);
      throw new Error("CreateBitmap failed");
    }
    try {
      RtlMoveMemory(bits[0], pixels, pixels.length);
      const icon = CreateIconIndirect({
        fIcon: 1,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: mask,
        hbmColor: color,
      }) as bigint;
      if (!icon) throw new Error("CreateIconIndirect failed");
      return icon;
    } finally {
      DeleteObject(color);
      DeleteObject(mask);
    }
  } finally {
    ReleaseDC(0n, hdc);
  }
}

function iconHandle(kind: TaskbarIconKind): bigint {
  const cached = handles.get(kind);
  if (cached) return cached;
  const created = createHicon(kind);
  handles.set(kind, created);
  return created;
}

/** Replace the taskbar glyph. False means the caller should use setIcon. */
export function applyWinTaskbarIcon(win: BrowserWindow, kind: TaskbarIconKind): boolean {
  if (failed || process.platform !== "win32" || win.isDestroyed()) return false;
  try {
    const hwnd = hwndOf(win);
    const icon = iconHandle(kind);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, icon);
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, icon);
    return true;
  } catch (err) {
    failed = true;
    console.error("taskbar icon", err);
    return false;
  }
}
