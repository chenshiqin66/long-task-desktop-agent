import { readInstructionFiles } from "./instructions.js";
import { renderInstructionFiles, renderMemoryContext } from "./prompt.js";
import type { MemoryStore } from "./store.js";

export interface RuntimeMemory {
  store: MemoryStore;
  /** Read at the start of every turn, so flipping the switch applies from the next turn. */
  autoMemory(): Promise<boolean>;
}

export interface TurnMemory {
  /** Instruction files and notes for the parent, right after the system prompt. */
  block: string;
  /** Instruction files only, appended to a worker subagent's system prompt. */
  workerInstructions: string;
}

export const EMPTY_TURN_MEMORY: TurnMemory = { block: "", workerInstructions: "" };

/** A memory folder that cannot be read leaves this turn without notes. The turn still runs. */
export async function snapshotTurnMemory(memory: RuntimeMemory, now = new Date()): Promise<TurnMemory> {
  const [files, entries, autoMemory] = await Promise.all([
    readInstructionFiles({ home: memory.store.home, workspacePath: memory.store.workspacePath }),
    memory.store.list().then(
      (listing) => listing.entries,
      () => [],
    ),
    memory.autoMemory().catch(() => true),
  ]);
  return {
    block: renderMemoryContext(files, entries, { autoMemory, now }),
    workerInstructions: renderInstructionFiles(files),
  };
}
