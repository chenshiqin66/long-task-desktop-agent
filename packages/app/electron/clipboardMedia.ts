import { clipboard, dialog, nativeImage, type BrowserWindow, type IpcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { SessionStore, assertValidSessionId } from "@agent/core";
import {
  defaultMediaFileName,
  parseDataUrl,
  saveDialogFilters,
  type MediaKind,
  type SaveMediaRequest,
} from "../src/mediaExport.js";

type Deps = {
  getWin: () => BrowserWindow | null;
  getWorkspace: () => string | null;
  assertKnownWorkspace: (raw: string) => Promise<string>;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asWorkspace(value: unknown): string | null | undefined {
  if (value == null) return null;
  return asOptionalString(value);
}

function asCopyPayload(raw: unknown): {
  dataUrl?: string;
  relativePath?: string;
  sessionId?: string;
  workspace?: string | null;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("无法复制图片");
  const o = raw as Record<string, unknown>;
  return {
    dataUrl: asOptionalString(o.dataUrl),
    relativePath: asOptionalString(o.relativePath),
    sessionId: asOptionalString(o.sessionId),
    workspace: asWorkspace(o.workspace),
  };
}

function asSavePayload(raw: unknown): SaveMediaRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("无法保存文件");
  const o = raw as Record<string, unknown>;
  if (o.kind !== "image" && o.kind !== "video") throw new Error("无法保存文件");
  return {
    kind: o.kind,
    defaultName: asOptionalString(o.defaultName),
    mime: asOptionalString(o.mime),
    dataUrl: asOptionalString(o.dataUrl),
    relativePath: asOptionalString(o.relativePath),
    sessionId: asOptionalString(o.sessionId),
    workspace: asWorkspace(o.workspace),
  };
}

async function resolveWorkspace(deps: Deps, raw: string | null | undefined): Promise<string> {
  if (raw) return deps.assertKnownWorkspace(raw);
  const current = deps.getWorkspace();
  if (!current) throw new Error("No workspace selected");
  return current;
}

async function bytesFromStore(
  deps: Deps,
  kind: MediaKind,
  sessionId: string,
  relativePath: string,
  workspace: string | null | undefined,
): Promise<{ mime: string; buffer: Buffer }> {
  assertValidSessionId(sessionId);
  const store = new SessionStore(await resolveWorkspace(deps, workspace));
  const dataUrl =
    kind === "video"
      ? (await store.readVideoForSend(sessionId, relativePath)).dataUrl
      : (await store.readImageForSend(sessionId, relativePath)).dataUrl;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error(kind === "video" ? "无法读取视频" : "无法读取图片");
  return { mime: parsed.mime, buffer: Buffer.from(parsed.bytes) };
}

async function bytesFromPayload(
  deps: Deps,
  kind: MediaKind,
  payload: {
    dataUrl?: string;
    relativePath?: string;
    sessionId?: string;
    workspace?: string | null;
  },
): Promise<{ mime: string; buffer: Buffer; relativePath?: string }> {
  if (payload.sessionId && payload.relativePath) {
    const read = await bytesFromStore(deps, kind, payload.sessionId, payload.relativePath, payload.workspace);
    return { ...read, relativePath: payload.relativePath };
  }
  if (payload.dataUrl) {
    const parsed = parseDataUrl(payload.dataUrl);
    if (!parsed) throw new Error(kind === "video" ? "无法读取视频" : "无法读取图片");
    return { mime: parsed.mime, buffer: Buffer.from(parsed.bytes) };
  }
  throw new Error(kind === "video" ? "没有可保存的视频" : "没有可保存的图片");
}

export function registerClipboardMediaHandlers(ipc: IpcMain, deps: Deps): void {
  ipc.handle("agent:copyImage", async (_event, raw: unknown) => {
    const payload = asCopyPayload(raw);
    const { buffer } = await bytesFromPayload(deps, "image", payload);
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty() && payload.dataUrl) image = nativeImage.createFromDataURL(payload.dataUrl);
    if (image.isEmpty()) throw new Error("无法复制图片");
    clipboard.writeImage(image);
    return { ok: true as const };
  });

  ipc.handle("agent:saveMedia", async (_event, raw: unknown) => {
    const payload = asSavePayload(raw);
    const read = await bytesFromPayload(deps, payload.kind, payload);
    const defaultName = defaultMediaFileName({
      relativePath: read.relativePath,
      fallbackName: payload.defaultName,
      mime: payload.mime ?? read.mime,
      kind: payload.kind,
    });
    const opts = {
      title: payload.kind === "video" ? "保存视频" : "保存图片",
      defaultPath: defaultName,
      filters: saveDialogFilters(payload.kind, defaultName),
    };
    const win = deps.getWin();
    const res = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    win?.focus();
    if (res.canceled || !res.filePath) return { saved: false as const };
    await writeFile(res.filePath, read.buffer);
    return { saved: true as const };
  });
}
