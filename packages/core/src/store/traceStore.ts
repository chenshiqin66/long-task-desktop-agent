import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { TraceEvent } from "../types.js";
import { sessionDir } from "./sessionStore.js";

export class TraceStore {
  constructor(private readonly workspacePath: string) {}

  async append(
    event: Omit<TraceEvent, "id" | "timestamp"> & {
      id?: string;
      timestamp?: string;
    },
  ): Promise<TraceEvent> {
    const full: TraceEvent = {
      ...event,
      id: event.id ?? newId("trace"),
      timestamp: event.timestamp ?? nowIso(),
    };
    const path = join(sessionDir(this.workspacePath, full.session_id), "trace.jsonl");
    await appendFile(path, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async read(sessionId: string): Promise<TraceEvent[]> {
    const path = join(sessionDir(this.workspacePath, sessionId), "trace.jsonl");
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEvent);
  }
}
