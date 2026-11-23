/**
 * Mic ASR: renderer captures PCM, main process holds the openspeech WebSocket + API key.
 */
import type { IpcMain, WebContents } from "electron";
import { MicAsrSession, asrModelOf, type StoredConfig } from "@agent/core";

type MicSession = {
  asr: MicAsrSession;
  sender: WebContents;
};

let active: MicSession | null = null;

function send(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

function stopActive(): void {
  if (!active) return;
  try {
    active.asr.finish();
  } catch {
    /* ignore */
  }
  try {
    active.asr.close();
  } catch {
    /* ignore */
  }
  active = null;
}

export function registerSpeechHandlers(
  ipcMain: IpcMain,
  readConfig: () => Promise<StoredConfig | null>,
): void {
  ipcMain.handle("agent:asrMicStart", async (event) => {
    stopActive();
    const stored = await readConfig();
    const model = asrModelOf(stored);
    if (!model) throw new Error("还没有配置语音识别模型，请先在「模型」页添加");
    if (!model.apiKey.trim()) throw new Error("语音识别模型还没有填写 API Key（需豆包语音专属 Key）");

    const sender = event.sender;
    const asr = new MicAsrSession(model.apiKey, {
      onPartial: (text) => send(sender, "agent:asr-partial", text),
      onFinal: (text) => send(sender, "agent:asr-final", text),
      onError: (message) => send(sender, "agent:asr-error", message),
      onClose: () => {
        if (active?.asr === asr) active = null;
        send(sender, "agent:asr-closed", null);
      },
    });
    await asr.start();
    active = { asr, sender };
    return { ok: true as const };
  });

  ipcMain.handle("agent:asrMicChunk", async (_event, raw: unknown) => {
    if (!active) return;
    let bytes: Uint8Array | null = null;
    if (raw instanceof Uint8Array) bytes = raw;
    else if (Buffer.isBuffer(raw)) bytes = raw;
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) {
      const view = raw as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (!bytes?.length) return;
    active.asr.sendPcm(bytes);
  });

  ipcMain.handle("agent:asrMicStop", async () => {
    stopActive();
  });
}
