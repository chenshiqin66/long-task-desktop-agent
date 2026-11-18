import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { LlmProvider } from "../provider/types.js";
import { sessionRunKey } from "../runtime/sessionRuntimePool.js";
import { LockTimeoutError, replaceFile } from "../store/fileLock.js";
import { SessionStore, sessionDir } from "../store/sessionStore.js";
import type { Message } from "../types.js";
import type { MemoryScope } from "./entry.js";
import {
  buildExtractRequest,
  cursorAdvances,
  fitTranscript,
  isEvidence,
  judgeOps,
  parseExtractOutput,
  rangeAfterCursor,
  transcriptLines,
  type ExtractOp,
  type ExtractOutcome,
  type ExtractRange,
} from "./extract.js";
import { readInstructionFiles } from "./instructions.js";
import { MemoryStore, type JournalOp } from "./store.js";

export const MEMORY_CURSOR_FILE = "memory-cursor.json";
export const MEMORY_EXTRACT_LOG = "memory-extract.jsonl";

export interface MemorySavedItem {
  scope: MemoryScope;
  name: string;
  op: JournalOp;
  journal_id: string;
}

export interface MemorySavedEvent {
  type: "memory_saved";
  workspace: string;
  session_id: string;
  items: MemorySavedItem[];
}

export interface ExtractorSettings {
  autoMemory: boolean;
  provider: LlmProvider | null;
  model: string;
  /** Configured keys and MCP credentials. A note holding one is rejected. */
  secrets: string[];
}

export interface ExtractJob {
  workspace: string;
  sessionId: string;
  settings: ExtractorSettings;
  home?: string;
  now?: Date;
  signal?: AbortSignal;
  lockWaitMs?: number;
}

export interface ExtractReport {
  outcome: ExtractOutcome;
  saved: MemorySavedItem[];
  /** The model's raw text, when it replied. */
  output?: string;
}

type LoggedVerdict =
  | { op: unknown; result: "applied"; journal_id: string }
  | { op: unknown; result: "rejected"; reason: string };

export async function readCursor(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MEMORY_CURSOR_FILE), "utf8")) as { last_message_id?: unknown };
    return typeof parsed.last_message_id === "string" ? parsed.last_message_id : null;
  } catch {
    return null;
  }
}

async function callModel(
  provider: LlmProvider,
  job: ExtractJob,
  store: MemoryStore,
  messages: readonly Message[],
  range: ExtractRange,
) {
  const [instructions, listing] = await Promise.all([
    readInstructionFiles({ home: store.home, workspacePath: job.workspace }),
    store.list(),
  ]);
  const request = buildExtractRequest({
    now: job.now ?? new Date(),
    instructions,
    existing: listing.entries,
    transcript: fitTranscript(transcriptLines(messages, range)),
  });
  let output = "";
  const stream = provider.chatStream({
    model: job.settings.model,
    tools: [],
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    ...(job.signal ? { signal: job.signal } : {}),
  });
  for await (const chunk of stream) {
    if (chunk.type === "error") throw new Error(chunk.error ?? "model error");
    if (chunk.type === "text" && chunk.text) output += chunk.text;
  }
  return { request, output, existing: listing.entries };
}

function applyOp(store: MemoryStore, op: ExtractOp, job: ExtractJob) {
  const source = { workspace: job.workspace, session: job.sessionId, message: op.evidence[0]! };
  return op.op === "upsert"
    ? store.upsert(
        { scope: op.scope, name: op.name, type: op.type, description: op.description, body: op.body },
        { actor: "extractor", origin: "extracted", secrets: job.settings.secrets, source },
      )
    : store.remove(op.scope, op.name, { actor: "extractor", source });
}

/**
 * One pass over the messages after the cursor. It writes only into a session
 * directory that still exists, so a deleted session is not brought back. The
 * cursor moves after the notes and the log line, and only for outcomes that
 * should not be retried.
 */
export async function extractOnce(job: ExtractJob): Promise<ExtractReport> {
  const sessions = new SessionStore(job.workspace);
  let messages: Message[];
  try {
    await sessions.getMeta(job.sessionId);
    messages = await sessions.readMessages(job.sessionId);
  } catch {
    return { outcome: "session_gone", saved: [] };
  }
  const dir = sessionDir(job.workspace, job.sessionId);
  const range = rangeAfterCursor(messages, await readCursor(dir));
  if (range.start >= range.end) return { outcome: "no_evidence", saved: [] };
  const lastId = messages[range.end - 1]!.id;
  const log = {
    id: newId("memx"),
    at: nowIso(),
    model: job.settings.model,
    range: { from: messages[range.start]!.id, to: lastId },
  };

  const finish = async (report: ExtractReport, extra: Record<string, unknown> = {}): Promise<ExtractReport> => {
    await appendFile(
      join(dir, MEMORY_EXTRACT_LOG),
      `${JSON.stringify({ ...log, outcome: report.outcome, ...extra })}\n`,
      "utf8",
    ).catch(() => undefined);
    if (cursorAdvances(report.outcome)) {
      await replaceFile(
        join(dir, MEMORY_CURSOR_FILE),
        `${JSON.stringify({ last_message_id: lastId, updated_at: nowIso() })}\n`,
      ).catch(() => undefined);
    }
    return report;
  };

  if (!job.settings.autoMemory) return finish({ outcome: "disabled", saved: [] });
  const evidenceIds = new Set(messages.slice(range.start, range.end).filter(isEvidence).map((message) => message.id));
  if (!evidenceIds.size) return finish({ outcome: "no_evidence", saved: [] });
  if (!job.settings.provider || !job.settings.model) {
    return finish({ outcome: "no_text_model", saved: [] });
  }

  const store = new MemoryStore({
    workspacePath: job.workspace,
    ...(job.home ? { home: job.home } : {}),
    ...(job.lockWaitMs !== undefined ? { lockWaitMs: job.lockWaitMs } : {}),
  });
  let reply: Awaited<ReturnType<typeof callModel>>;
  try {
    reply = await callModel(job.settings.provider, job, store, messages, range);
  } catch (err) {
    return finish({ outcome: job.signal?.aborted ? "cancelled" : "request_failed", saved: [] }, { error: String(err) });
  }
  const { request, output, existing } = reply;
  const parsed = parseExtractOutput(output);
  if (!parsed.ok) return finish({ outcome: "bad_output", saved: [], output }, { request, output });

  const saved: MemorySavedItem[] = [];
  const verdicts: LoggedVerdict[] = [];
  try {
    for (const verdict of judgeOps(parsed.ops, { evidenceIds, existing, secrets: job.settings.secrets })) {
      if (verdict.verdict === "reject") {
        verdicts.push({ op: verdict.raw, result: "rejected", reason: verdict.reason });
        continue;
      }
      const result = await applyOp(store, verdict.op, job);
      if (!result.ok) {
        verdicts.push({ op: verdict.op, result: "rejected", reason: result.error });
        continue;
      }
      verdicts.push({ op: verdict.op, result: "applied", journal_id: result.value.id });
      saved.push({ scope: verdict.op.scope, name: verdict.op.name, op: result.value.op, journal_id: result.value.id });
    }
  } catch (err) {
    const outcome: ExtractOutcome = err instanceof LockTimeoutError ? "lock_timeout" : "write_failed";
    return finish({ outcome, saved, output }, { request, output, verdicts, error: String(err) });
  }
  return finish({ outcome: "model_replied", saved, output }, { request, output, verdicts });
}

export interface MemoryExtractorDeps {
  /** Read when each pass starts, so a new key or a flipped switch applies to the next pass. */
  settings(): Promise<ExtractorSettings>;
  onSaved(event: MemorySavedEvent): void;
  home?: string;
  /** Called after every pass. Tests use it to see the order. */
  onReport?(job: { workspace: string; sessionId: string }, report: ExtractReport): void;
}

/**
 * One pass at a time across all sessions, outside the five-run limit. A
 * session already waiting is not queued twice: when its pass starts it reads
 * every message after the cursor, turns that ended while it waited included.
 */
export class MemoryExtractor {
  private readonly deps: MemoryExtractorDeps;
  private readonly queue: Array<{ key: string; workspace: string; sessionId: string }> = [];
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: MemoryExtractorDeps) {
    this.deps = deps;
  }

  enqueue(job: { workspace: string; sessionId: string }): void {
    if (this.closed) return;
    const key = sessionRunKey(job.workspace, job.sessionId);
    if (this.queue.some((waiting) => waiting.key === key)) return;
    this.queue.push({ key, workspace: job.workspace, sessionId: job.sessionId });
    this.pump();
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Drops waiting passes and cancels the running one. Cursors stay, so the next launch picks up. */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    this.abort?.abort();
    await this.running;
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    this.running = this.runOne(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async runOne(job: { workspace: string; sessionId: string }): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    try {
      const settings = await this.deps.settings();
      const report = await extractOnce({
        workspace: job.workspace,
        sessionId: job.sessionId,
        settings,
        signal: abort.signal,
        ...(this.deps.home ? { home: this.deps.home } : {}),
      });
      if (report.saved.length) {
        this.deps.onSaved({ type: "memory_saved", workspace: job.workspace, session_id: job.sessionId, items: report.saved });
      }
      this.deps.onReport?.(job, report);
    } catch {
      // The cursor stays where it was; the next completed turn retries.
    } finally {
      this.abort = null;
    }
  }
}
