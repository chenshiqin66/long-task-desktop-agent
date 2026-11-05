import { mkdir, readFile, writeFile, readdir, appendFile, access, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { ImageAttachment, ImageMime, Message, SessionMeta } from "../types.js";

/** Session ids must be a single path segment — no separators or traversal. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const IMAGE_MIME_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const IMAGE_REL_RE = /^images\/img_[a-f0-9]+\.(png|jpg|webp|gif)$/;

/** Largest decoded image accepted from the renderer after it has resized. */
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_IMAGES_PER_MESSAGE = 4;

export function extForImageMime(mime: string): string | null {
  return IMAGE_MIME_EXT[mime as ImageMime] ?? null;
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

  async updateMeta(meta: SessionMeta): Promise<void> {
    meta.updated_at = nowIso();
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
    await this.updateMeta(meta);
    return meta;
  }

  async saveImage(
    sessionId: string,
    mime: ImageMime,
    base64: string,
  ): Promise<ImageAttachment> {
    const ext = extForImageMime(mime);
    if (!ext) throw new Error(`Unsupported image type: ${mime}`);
    const cleaned = base64.replace(/\s/g, "");
    const bytes = Buffer.from(cleaned, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image is empty or larger than ${MAX_IMAGE_BYTES} bytes`);
    }
    const id = newId("img");
    const path = `images/${id}.${ext}`;
    const dir = sessionDir(this.workspacePath, sessionId);
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", `${id}.${ext}`), bytes);
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
    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at));
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
