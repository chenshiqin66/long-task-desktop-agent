import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditMessage, WireTool } from "../context/auditContext.js";
import { sessionDir } from "./sessionStore.js";

/**
 * Append-only outbound context. One tools row per distinct schema, then one
 * request row per model call. Image pixels stay in the session images folder.
 */
export class ContextStore {
  private readonly knownTools = new Map<string, Set<string>>();

  constructor(private readonly workspacePath: string) {}

  async readRaw(sessionId: string): Promise<string> {
    try {
      return await readFile(join(sessionDir(this.workspacePath, sessionId), "context.jsonl"), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "";
      throw err;
    }
  }

  async appendRequest(opts: {
    sessionId: string;
    id: string;
    turnId: string;
    model: string;
    toolsSha256: string;
    tools: WireTool[];
    messages: AuditMessage[];
  }): Promise<void> {
    const known = await this.knownToolHashes(opts.sessionId);
    const path = join(sessionDir(this.workspacePath, opts.sessionId), "context.jsonl");
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

  private async knownToolHashes(sessionId: string): Promise<Set<string>> {
    const cached = this.knownTools.get(sessionId);
    if (cached) return cached;
    const found = new Set<string>();
    try {
      const raw = await readFile(join(sessionDir(this.workspacePath, sessionId), "context.jsonl"), "utf8");
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
