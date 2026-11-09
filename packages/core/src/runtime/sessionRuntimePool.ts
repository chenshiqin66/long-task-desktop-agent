import { AgentError } from "./errors.js";

/** How many sessions may be inside `submit` or a deferred subagent at once. */
export const MAX_CONCURRENT_RUNS = 5;

export function sessionRunKey(workspace: string, sessionId: string): string {
  const dir = workspace.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return `${dir}\0${sessionId}`;
}

/**
 * One turn on one session. The pool keeps the object while that turn or a
 * deferred subagent is still using it, then drops it.
 */
export interface PooledRuntime {
  readonly isTurnRunning: boolean;
  hasDeferredWork(): boolean;
  submit(sessionId: string, text: string, images?: unknown): Promise<void>;
  cancel(): void;
  watchSession(sessionId: string | null): Promise<void>;
  stopDeferred(): Promise<void>;
  setIdleListener?(listener: (() => void) | null): void;
}

type Slot<T extends PooledRuntime> = {
  workspace: string;
  sessionId: string;
  configKey: string;
  runtime?: T;
  opening?: Promise<T>;
};

/**
 * Sessions run on separate runtime objects. The cap is live objects, not
 * how many session rows the sidebar can show.
 */
export class SessionRuntimePool<T extends PooledRuntime> {
  private readonly slots = new Map<string, Slot<T>>();

  constructor(
    private readonly open: (workspace: string, sessionId: string) => Promise<T> | T,
    /** The slot was dropped because the turn and its deferred subagents are both done. */
    private readonly onReleased?: (workspace: string, sessionId: string) => void,
  ) {}

  get size(): number {
    return this.slots.size;
  }

  get(workspace: string, sessionId: string): T | undefined {
    return this.slots.get(sessionRunKey(workspace, sessionId))?.runtime;
  }

  entries(): Array<{ workspace: string; sessionId: string; runtime: T }> {
    const out: Array<{ workspace: string; sessionId: string; runtime: T }> = [];
    for (const slot of this.slots.values()) {
      if (slot.runtime) out.push({ workspace: slot.workspace, sessionId: slot.sessionId, runtime: slot.runtime });
    }
    return out;
  }

  async submit(
    workspace: string,
    sessionId: string,
    text: string,
    images: unknown,
    configKey: string,
  ): Promise<void> {
    const key = sessionRunKey(workspace, sessionId);
    const runtime = await this.acquire(workspace, sessionId, configKey);
    try {
      await runtime.submit(sessionId, text, images);
    } finally {
      this.releaseIfIdle(key);
    }
  }

  /**
   * Open this session's inbox wake without stealing another session's object.
   * At the cap, leave the inbox queued instead of starting a sixth run.
   */
  async watch(workspace: string, sessionId: string, configKey: string): Promise<boolean> {
    const key = sessionRunKey(workspace, sessionId);
    const existing = this.slots.get(key);
    if (!existing && this.slots.size >= MAX_CONCURRENT_RUNS) return false;
    const runtime = await this.acquire(workspace, sessionId, configKey);
    try {
      await runtime.watchSession(sessionId);
    } finally {
      this.releaseIfIdle(key);
    }
    return true;
  }

  cancel(workspace: string, sessionId: string): void {
    this.slots.get(sessionRunKey(workspace, sessionId))?.runtime?.cancel();
  }

  /** Remove the slot. Caller stops the runtime first when work is still in flight. */
  forget(workspace: string, sessionId: string): T | undefined {
    const key = sessionRunKey(workspace, sessionId);
    const slot = this.slots.get(key);
    this.slots.delete(key);
    slot?.runtime?.setIdleListener?.(null);
    if (slot) this.onReleased?.(slot.workspace, slot.sessionId);
    return slot?.runtime;
  }

  async discardWorkspace(workspace: string): Promise<void> {
    const dir = workspace.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    const prefix = `${dir}\0`;
    const doomed = [...this.slots.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [, slot] of doomed) {
      slot.runtime?.cancel();
      await slot.runtime?.stopDeferred();
      slot.runtime?.setIdleListener?.(null);
    }
    for (const [key, slot] of doomed) {
      this.slots.delete(key);
      this.onReleased?.(slot.workspace, slot.sessionId);
    }
  }

  clear(): void {
    for (const slot of this.slots.values()) slot.runtime?.setIdleListener?.(null);
    this.slots.clear();
  }

  private acquire(workspace: string, sessionId: string, configKey: string): Promise<T> {
    const key = sessionRunKey(workspace, sessionId);
    const existing = this.slots.get(key);
    if (existing?.runtime) {
      const idle = !existing.runtime.isTurnRunning && !existing.runtime.hasDeferredWork();
      if (existing.configKey === configKey || !idle) return Promise.resolve(existing.runtime);
      existing.runtime.setIdleListener?.(null);
      this.slots.delete(key);
    } else if (existing?.opening) {
      return existing.opening;
    }

    if (this.slots.size >= MAX_CONCURRENT_RUNS) {
      return Promise.reject(new AgentError("已有 5 个会话在执行", "busy"));
    }

    const slot: Slot<T> = { workspace, sessionId, configKey };
    let opened: T | Promise<T>;
    try {
      opened = this.open(workspace, sessionId);
    } catch (err) {
      return Promise.reject(err);
    }
    if (opened instanceof Promise) {
      const opening = opened.then((runtime) => {
        slot.runtime = runtime;
        slot.opening = undefined;
        runtime.setIdleListener?.(() => this.releaseIfIdle(key));
        return runtime;
      });
      slot.opening = opening;
      this.slots.set(key, slot);
      return opening.catch((err: unknown) => {
        if (this.slots.get(key) === slot && !slot.runtime) this.slots.delete(key);
        throw err;
      });
    }
    slot.runtime = opened;
    this.slots.set(key, slot);
    opened.setIdleListener?.(() => this.releaseIfIdle(key));
    return Promise.resolve(opened);
  }

  private releaseIfIdle(key: string): void {
    const slot = this.slots.get(key);
    if (!slot?.runtime) return;
    if (slot.runtime.isTurnRunning || slot.runtime.hasDeferredWork()) return;
    slot.runtime.setIdleListener?.(null);
    this.slots.delete(key);
    this.onReleased?.(slot.workspace, slot.sessionId);
  }
}
