import { mkdir, readFile, writeFile, readdir, appendFile, access, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { newId, nowIso } from "../ids.js";
import type {
  AudioAttachment,
  AudioMime,
  ImageAttachment,
  ImageMime,
  Message,
  SessionMeta,
  VideoAttachment,
  VideoMime,
} from "../types.js";

/** Session ids must be a single path segment — no separators or traversal. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const IMAGE_MIME_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const IMAGE_REL_RE = /^images\/(?:explain-)?img_[a-f0-9]+\.(png|jpg|webp|gif)$/;

/** Largest decoded image accepted from the renderer after it has resized. */
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_GENERATED_IMAGE_BYTES = 15_000_000;
export const MAX_IMAGES_PER_MESSAGE = 4;

export function extForImageMime(mime: string): string | null {
  return IMAGE_MIME_EXT[mime as ImageMime] ?? null;
}

const VIDEO_MIME_EXT: Record<VideoMime, "mp4" | "webm" | "mov"> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const VIDEO_REL_RE = /^videos\/vid_[a-f0-9]+\.(mp4|webm|mov)$/;

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
/** Generated H3 clips can exceed the user-upload cap. */
export const MAX_GENERATED_VIDEO_BYTES = 80 * 1024 * 1024;
export const MAX_VIDEOS_PER_MESSAGE = 1;

export function extForVideoMime(mime: string): "mp4" | "webm" | "mov" | null {
  return VIDEO_MIME_EXT[mime as VideoMime] ?? null;
}

const AUDIO_MIME_EXT: Record<AudioMime, "mp3" | "wav" | "webm" | "m4a" | "ogg"> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

const AUDIO_REL_RE = /^audios\/aud_[a-f0-9]+\.(mp3|wav|webm|m4a|ogg)$/;

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_GENERATED_AUDIO_BYTES = 40 * 1024 * 1024;
export const MAX_AUDIOS_PER_MESSAGE = 1;

export function extForAudioMime(mime: string): "mp3" | "wav" | "webm" | "m4a" | "ogg" | null {
  return AUDIO_MIME_EXT[mime as AudioMime] ?? null;
}

export function parseAudioMime(raw: string | null | undefined): AudioMime | null {
  if (!raw) return null;
  const base = raw.split(";")[0]!.trim().toLowerCase();
  if (base === "audio/mpeg" || base === "audio/mp3") return "audio/mpeg";
  if (base === "audio/wav" || base === "audio/wave" || base === "audio/x-wav") return "audio/wav";
  if (base === "audio/webm") return "audio/webm";
  if (base === "audio/mp4" || base === "audio/m4a" || base === "audio/x-m4a") return "audio/mp4";
  if (base === "audio/ogg" || base === "audio/opus") return "audio/ogg";
  return null;
}

export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
  }
}

export function sessionDir(workspacePath: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  return join(workspacePath, ".agent", "sessions", sessionId);
}

export class SessionStore {
  constructor(private readonly workspacePath: string) {}

  private sessionsRoot(): string {
    return join(this.workspacePath, ".agent", "sessions");
  }

  async createSession(title?: string): Promise<SessionMeta> {
    const session_id = newId("sess");
    const dir = sessionDir(this.workspacePath, session_id);
    await mkdir(dir, { recursive: true });
    const now = nowIso();
    const meta: SessionMeta = {
      session_id,
      workspace_path: this.workspacePath,
      created_at: now,
      updated_at: now,
      title,
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeFile(join(dir, "messages.jsonl"), "", "utf8");
    await writeFile(join(dir, "trace.jsonl"), "", "utf8");
    await writeFile(join(dir, "context.jsonl"), "", "utf8");
    return meta;
  }

  async getMeta(sessionId: string): Promise<SessionMeta> {
    const path = join(sessionDir(this.workspacePath, sessionId), "meta.json");
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as SessionMeta;
    } catch (err) {
      if (err instanceof Error && /Invalid session id/i.test(err.message)) throw err;
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  async updateMeta(meta: SessionMeta, opts?: { touch?: boolean }): Promise<void> {
    if (opts?.touch !== false) meta.updated_at = nowIso();
    const path = join(sessionDir(this.workspacePath, meta.session_id), "meta.json");
    await writeFile(path, JSON.stringify(meta, null, 2), "utf8");
  }

  async renameSession(
    sessionId: string,
    title: string,
    opts?: { source?: "user" | "auto" },
  ): Promise<SessionMeta> {
    const meta = await this.getMeta(sessionId);
    meta.title = title.trim() || meta.title || "会话";
    meta.title_source = opts?.source ?? "user";
    await this.updateMeta(meta, { touch: false });
    return meta;
  }

  async saveImage(
    sessionId: string,
    mime: ImageMime,
    base64: string,
    opts?: { prefix?: string; maxBytes?: number },
  ): Promise<ImageAttachment> {
    const ext = extForImageMime(mime);
    if (!ext) throw new Error(`Unsupported image type: ${mime}`);
    const prefix = opts?.prefix ?? "";
    if (prefix && !/^[a-z0-9-]+$/i.test(prefix)) throw new Error("Invalid image prefix");
    const cleaned = base64.replace(/\s/g, "");
    const bytes = Buffer.from(cleaned, "base64");
    const limit = opts?.maxBytes ?? MAX_IMAGE_BYTES;
    if (!bytes.length || bytes.length > limit) {
      throw new Error(`Image is empty or larger than ${limit} bytes`);
    }
    const id = newId("img");
    const fileName = `${prefix}${id}.${ext}`;
    const path = `images/${fileName}`;
    const dir = sessionDir(this.workspacePath, sessionId);
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", fileName), bytes);
    return { id, mime, path };
  }

  async readImageForSend(
    sessionId: string,
    relativePath: string,
  ): Promise<{ dataUrl: string; bytes: number }> {
    if (!IMAGE_REL_RE.test(relativePath)) throw new Error("Invalid image path");
    const dir = sessionDir(this.workspacePath, sessionId);
    const imagesDir = resolve(dir, "images") + sep;
    const abs = resolve(dir, relativePath);
    if (!abs.startsWith(imagesDir)) throw new Error("Invalid image path");
    const bytes = await readFile(abs);
    const ext = relativePath.slice(relativePath.lastIndexOf(".") + 1);
    const mime =
      ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/gif";
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
  }

  async readImageDataUrl(sessionId: string, relativePath: string): Promise<string> {
    return (await this.readImageForSend(sessionId, relativePath)).dataUrl;
  }

  async saveVideo(
    sessionId: string,
    mime: VideoMime,
    base64: string,
    opts?: { maxBytes?: number },
  ): Promise<VideoAttachment> {
    const ext = extForVideoMime(mime);
    if (!ext) throw new Error(`Unsupported video type: ${mime}`);
    const cleaned = base64.replace(/\s/g, "");
    const bytes = Buffer.from(cleaned, "base64");
    const limit = opts?.maxBytes ?? MAX_VIDEO_BYTES;
    if (!bytes.length || bytes.length > limit) {
      throw new Error(`Video is empty or larger than ${limit} bytes`);
    }
    const id = newId("vid");
    const fileName = `${id}.${ext}`;
    const path = `videos/${fileName}`;
    const dir = sessionDir(this.workspacePath, sessionId);
    await mkdir(join(dir, "videos"), { recursive: true });
    await writeFile(join(dir, "videos", fileName), bytes);
    return { id, mime, path };
  }

  async readVideoForSend(
    sessionId: string,
    relativePath: string,
  ): Promise<{ dataUrl: string; bytes: number }> {
    if (!VIDEO_REL_RE.test(relativePath)) throw new Error("Invalid video path");
    const dir = sessionDir(this.workspacePath, sessionId);
    const videosDir = resolve(dir, "videos") + sep;
    const abs = resolve(dir, relativePath);
    if (!abs.startsWith(videosDir)) throw new Error("Invalid video path");
    const bytes = await readFile(abs);
    const ext = relativePath.slice(relativePath.lastIndexOf(".") + 1);
    const mime =
      ext === "mp4" ? "video/mp4" : ext === "webm" ? "video/webm" : "video/quicktime";
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
  }

  async readVideoDataUrl(sessionId: string, relativePath: string): Promise<string> {
    return (await this.readVideoForSend(sessionId, relativePath)).dataUrl;
  }

  async saveAudio(
    sessionId: string,
    mime: AudioMime,
    base64: string,
    opts?: { maxBytes?: number },
  ): Promise<AudioAttachment> {
    const ext = extForAudioMime(mime);
    if (!ext) throw new Error(`Unsupported audio type: ${mime}`);
    const cleaned = base64.replace(/\s/g, "");
    const bytes = Buffer.from(cleaned, "base64");
    const limit = opts?.maxBytes ?? MAX_AUDIO_BYTES;
    if (!bytes.length || bytes.length > limit) {
      throw new Error(`Audio is empty or larger than ${limit} bytes`);
    }
    const id = newId("aud");
    const fileName = `${id}.${ext}`;
    const path = `audios/${fileName}`;
    const dir = sessionDir(this.workspacePath, sessionId);
    await mkdir(join(dir, "audios"), { recursive: true });
    await writeFile(join(dir, "audios", fileName), bytes);
    return { id, mime, path };
  }

  async readAudioForSend(
    sessionId: string,
    relativePath: string,
  ): Promise<{ dataUrl: string; bytes: number; buffer: Buffer }> {
    if (!AUDIO_REL_RE.test(relativePath)) throw new Error("Invalid audio path");
    const dir = sessionDir(this.workspacePath, sessionId);
    const audiosDir = resolve(dir, "audios") + sep;
    const abs = resolve(dir, relativePath);
    if (!abs.startsWith(audiosDir)) throw new Error("Invalid audio path");
    const bytes = await readFile(abs);
    const ext = relativePath.slice(relativePath.lastIndexOf(".") + 1);
    const mime: AudioMime =
      ext === "mp3"
        ? "audio/mpeg"
        : ext === "wav"
          ? "audio/wav"
          : ext === "webm"
            ? "audio/webm"
            : ext === "ogg"
              ? "audio/ogg"
              : "audio/mp4";
    return {
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
      bytes: bytes.length,
      buffer: bytes,
    };
  }

  async readAudioDataUrl(sessionId: string, relativePath: string): Promise<string> {
    return (await this.readAudioForSend(sessionId, relativePath)).dataUrl;
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertValidSessionId(sessionId);
    const dir = sessionDir(this.workspacePath, sessionId);
    await rm(dir, { recursive: true, force: true });
  }

  async listSessions(): Promise<SessionMeta[]> {
    const root = this.sessionsRoot();
    try {
      await access(root);
    } catch {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        metas.push(await this.getMeta(e.name));
      } catch {
        // skip corrupt / invalid names
      }
    }
    return metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async appendMessage(msg: Message): Promise<void> {
    await this.getMeta(msg.session_id);
    const path = join(sessionDir(this.workspacePath, msg.session_id), "messages.jsonl");
    await appendFile(path, JSON.stringify(msg) + "\n", "utf8");
    const meta = await this.getMeta(msg.session_id);
    await this.updateMeta(meta);
  }

  async readMessages(sessionId: string): Promise<Message[]> {
    await this.getMeta(sessionId);
    const path = join(sessionDir(this.workspacePath, sessionId), "messages.jsonl");
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Message);
  }
}
