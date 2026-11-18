import type { IpcMain } from "electron";
import { shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INSTRUCTION_FILE_NAME,
  LockTimeoutError,
  MemoryExtractor,
  MemoryStore,
  OpenAICompatibleProvider,
  autoMemoryOf,
  errorCode,
  isMemoryScope,
  loadStoredConfig,
  readInstructionFiles,
  textModelForMemory,
} from "@agent/core";
import type {
  AgentConfig,
  InstructionFiles,
  JournalOp,
  McpPool,
  MemoryActor,
  MemoryEntry,
  MemoryResult,
  MemorySavedEvent,
  MemoryScope,
  RuntimeMemory,
  UnreadableMemory,
} from "@agent/core";

const LOCKED = "记忆目录正被另一处修改，稍后再试";

export interface MemoryJournalRow {
  id: string;
  at: string;
  scope: MemoryScope;
  name: string;
  op: JournalOp;
  actor: MemoryActor;
  /** A later restore line undid this change. */
  undone: boolean;
}

export interface MemoryPageData {
  autoMemory: boolean;
  /** The sidebar workspace, or null when none is selected. */
  workspace: string | null;
  projectRoot: string | null;
  dirs: { user: string; project: string | null };
  instructions: InstructionFiles;
  entries: MemoryEntry[];
  unreadable: UnreadableMemory[];
  /** Newest first. The text before and after each change stays in the main process. */
  journal: MemoryJournalRow[];
}

export type MemoryActionResult = { ok: true } | { ok: false; error: string };

export interface MemoryIpcDeps {
  mcp: McpPool;
  config(): Promise<AgentConfig>;
  /** A sidebar workspace, or null for none. Throws for any other path. */
  workspace(raw: unknown): Promise<string | null>;
  setAutoMemory(on: boolean): Promise<void>;
}

/** Keys from the config and credential-like MCP values. A note holding one is rejected. */
export function memorySecrets(config: AgentConfig, mcp: McpPool): string[] {
  return [config.apiKey, config.searchApiKey ?? "", ...mcp.credentialValues()].filter((value) => value.length > 0);
}

/** What a session runtime reads at the start of each turn. */
export function runtimeMemory(workspace: string): RuntimeMemory {
  return {
    store: new MemoryStore({ workspacePath: workspace }),
    autoMemory: async () => autoMemoryOf(await loadStoredConfig()),
  };
}

/** Settings are read when each pass starts, so a new key or a flipped switch applies to the next pass. */
export function createMemoryExtractor(
  deps: Pick<MemoryIpcDeps, "mcp" | "config">,
  send: (event: MemorySavedEvent) => void,
): MemoryExtractor {
  return new MemoryExtractor({
    settings: async () => {
      const [config, stored] = await Promise.all([deps.config(), loadStoredConfig()]);
      const text = textModelForMemory(stored);
      return {
        autoMemory: autoMemoryOf(stored),
        provider: text ? new OpenAICompatibleProvider({ baseUrl: text.baseUrl, apiKey: text.apiKey }) : null,
        model: text?.model ?? "",
        secrets: memorySecrets(config, deps.mcp),
      };
    },
    onSaved: send,
  });
}

function asScope(value: unknown): MemoryScope {
  if (!isMemoryScope(value)) throw new Error("作用域无效");
  return value;
}

function asText(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what}无效`);
  return value;
}

/** A lock timeout becomes a message for the page. Other errors reach the page as a rejected call. */
async function settle(run: () => Promise<MemoryResult<unknown>>): Promise<MemoryActionResult> {
  try {
    const result = await run();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    if (err instanceof LockTimeoutError) return { ok: false, error: LOCKED };
    throw err;
  }
}

export function registerMemoryHandlers(ipc: IpcMain, deps: MemoryIpcDeps): void {
  const storeFor = async (raw: unknown): Promise<MemoryStore> =>
    new MemoryStore({ workspacePath: await deps.workspace(raw) });

  ipc.handle("agent:memoryLoad", async (_event, raw: unknown): Promise<MemoryPageData> => {
    const store = await storeFor(raw);
    const [listing, journal, instructions, stored, project, userDir, projectDir] = await Promise.all([
      store.list(),
      store.journal(),
      readInstructionFiles({ home: store.home, workspacePath: store.workspacePath }),
      loadStoredConfig(),
      store.projectInfo(),
      store.dir("user"),
      store.dir("project"),
    ]);
    const undone = new Set(journal.flatMap((row) => (row.undoes ? [row.undoes] : [])));
    return {
      autoMemory: autoMemoryOf(stored),
      workspace: store.workspacePath,
      projectRoot: project?.root ?? null,
      dirs: { user: userDir ?? "", project: projectDir },
      instructions,
      entries: listing.entries,
      unreadable: listing.unreadable,
      journal: journal.map((row) => ({
        id: row.id,
        at: row.at,
        scope: row.scope,
        name: row.name,
        op: row.op,
        actor: row.actor,
        undone: undone.has(row.id),
      })),
    };
  });

  ipc.handle("agent:memorySave", async (_event, raw: unknown, scope: unknown, name: unknown, change: unknown) => {
    const store = await storeFor(raw);
    const fields = change && typeof change === "object" ? (change as Record<string, unknown>) : {};
    const secrets = memorySecrets(await deps.config(), deps.mcp);
    return settle(() =>
      store.edit(
        asScope(scope),
        asText(name, "名字"),
        { description: asText(fields.description, "描述"), body: asText(fields.body, "正文") },
        { secrets },
      ),
    );
  });

  ipc.handle("agent:memoryDelete", async (_event, raw: unknown, scope: unknown, name: unknown) => {
    const store = await storeFor(raw);
    return settle(() => store.remove(asScope(scope), asText(name, "名字"), { actor: "user" }));
  });

  ipc.handle("agent:memoryUndo", async (_event, raw: unknown, scope: unknown, journalId: unknown) => {
    const store = await storeFor(raw);
    return settle(() => store.undo(asScope(scope), asText(journalId, "变更记录")));
  });

  ipc.handle("agent:memoryOpenDir", async (_event, raw: unknown, scope: unknown) => {
    const store = await storeFor(raw);
    const dir = await store.ensureDir(asScope(scope));
    if (!dir) throw new Error("没有选中工作区");
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  ipc.handle("agent:memoryRevealInstructions", async (_event, raw: unknown, scope: unknown) => {
    const store = await storeFor(raw);
    const base = asScope(scope) === "user" ? store.home : store.workspacePath;
    if (!base) throw new Error("没有选中工作区");
    const path = join(base, INSTRUCTION_FILE_NAME);
    await mkdir(base, { recursive: true });
    await writeFile(path, "", { encoding: "utf8", flag: "wx" }).catch((err: unknown) => {
      if (errorCode(err) !== "EEXIST") throw err;
    });
    shell.showItemInFolder(path);
  });

  ipc.handle("agent:setAutoMemory", async (_event, on: unknown) => {
    if (typeof on !== "boolean") throw new Error("开关无效");
    await deps.setAutoMemory(on);
  });
}
