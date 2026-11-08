import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { ImageAttachment, ImageMime, Message, SubmittedImage, TraceEvent } from "../types.js";
import type { AuditMessage, WireTool } from "../context/auditContext.js";
import { SessionStore, sessionDir } from "./sessionStore.js";

const META = "explain-meta.json";
const MESSAGES = "explain-messages.jsonl";
const TRACE = "explain-trace.jsonl";
const CONTEXT = "explain-context.jsonl";

export interface ExplainMeta {
  open: boolean;
}

/**
 * Explain files live beside the main session files. Names differ; the directory does not.
 * This store never writes meta.json, messages.jsonl, trace.jsonl, or context.jsonl.
 */
export class ExplainStore {
  private readonly sessions: SessionStore;
  private readonly knownTools = new Map<string, Set<string>>();

  constructor(private readonly workspacePath: string) {
    this.sessions = new SessionStore(workspacePath);
  }

  async getOpen(sessionId: string): Promise<boolean> {
    await this.sessions.getMeta(sessionId);
    try {
      const raw = await readFile(this.file(sessionId, META), "utf8");
      const parsed = JSON.parse(raw) as { open?: unknown };
      return parsed.open === true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
  }

  async setOpen(sessionId: string, open: boolean): Promise<void> {
    await this.sessions.getMeta(sessionId);
    const body: ExplainMeta = { open };
    await writeFile(this.file(sessionId, META), JSON.stringify(body, null, 2), "utf8");
  }

  async readMessages(sessionId: string): Promise<Message[]> {
    await this.sessions.getMeta(sessionId);
    let raw = "";
    try {
      raw = await readFile(this.file(sessionId, MESSAGES), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Message);
  }

  async appendMessage(msg: Message): Promise<void> {
    await this.sessions.getMeta(msg.session_id);
    await appendFile(this.file(msg.session_id, MESSAGES), JSON.stringify(msg) + "\n", "utf8");
  }

  async appendTrace(
    event: Omit<TraceEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
  ): Promise<TraceEvent> {
    const full: TraceEvent = {
      ...event,
      id: event.id ?? newId("trace"),
      timestamp: event.timestamp ?? nowIso(),
    };
    await appendFile(this.file(full.session_id, TRACE), JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async appendContext(opts: {
    sessionId: string;
    id: string;
    turnId: string;
    model: string;
    toolsSha256: string;
    tools: WireTool[];
    messages: AuditMessage[];
  }): Promise<void> {
    const known = await this.knownToolHashes(opts.sessionId);
    const path = this.file(opts.sessionId, CONTEXT);
    if (!known.has(opts.toolsSha256)) {
      await appendFile(
        path,
        JSON.stringify({ type: "tools", sha256: opts.toolsSha256, tools: opts.tools }) + "\n",
        "utf8",
      );
      known.add(opts.toolsSha256);
    }
    await appendFile(
      path,
      JSON.stringify({
        type: "request",
        id: opts.id,
        turn_id: opts.turnId,
        model: opts.model,
        tools_sha256: opts.toolsSha256,
        messages: opts.messages,
      }) + "\n",
      "utf8",
    );
  }

  async saveImage(sessionId: string, image: SubmittedImage): Promise<ImageAttachment> {
    return this.sessions.saveImage(sessionId, image.mime as ImageMime, image.base64, {
      prefix: "explain-",
    });
  }

  readImageForSend(
    sessionId: string,
    relativePath: string,
  ): Promise<{ dataUrl: string; bytes: number }> {
    return this.sessions.readImageForSend(sessionId, relativePath);
  }

  readImageDataUrl(sessionId: string, relativePath: string): Promise<string> {
    return this.sessions.readImageDataUrl(sessionId, relativePath);
  }

  private file(sessionId: string, name: string): string {
    return join(sessionDir(this.workspacePath, sessionId), name);
  }

  private async knownToolHashes(sessionId: string): Promise<Set<string>> {
    const cached = this.knownTools.get(sessionId);
    if (cached) return cached;
    const found = new Set<string>();
    try {
      const raw = await readFile(this.file(sessionId, CONTEXT), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { type?: string; sha256?: string };
        if (row.type === "tools" && typeof row.sha256 === "string") found.add(row.sha256);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    this.knownTools.set(sessionId, found);
    return found;
  }
}
