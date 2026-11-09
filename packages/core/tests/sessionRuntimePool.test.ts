import { describe, expect, it } from "vitest";
import { AgentError } from "../src/runtime/errors.js";
import { MAX_CONCURRENT_RUNS, SessionRuntimePool, type PooledRuntime } from "../src/runtime/sessionRuntimePool.js";

class FakeRuntime implements PooledRuntime {
  isTurnRunning = false;
  deferred = false;
  watched: string | null = null;
  cancelled = false;
  submits: string[] = [];
  private finishSubmit: (() => void) | null = null;
  private idleListener: (() => void) | null = null;

  hasDeferredWork(): boolean {
    return this.deferred;
  }

  submit(sessionId: string): Promise<void> {
    if (this.isTurnRunning) throw new AgentError("A turn is already running", "busy");
    this.isTurnRunning = true;
    this.submits.push(sessionId);
    return new Promise((resolve) => {
      this.finishSubmit = () => {
        this.isTurnRunning = false;
        resolve();
      };
    });
  }

  finish(): void {
    this.finishSubmit?.();
    this.finishSubmit = null;
  }

  cancel(): void {
    this.cancelled = true;
    this.finish();
  }

  watchSession(sessionId: string | null): Promise<void> {
    this.watched = sessionId;
    return Promise.resolve();
  }

  stopDeferred(): Promise<void> {
    this.deferred = false;
    return Promise.resolve();
  }

  setIdleListener(listener: (() => void) | null): void {
    this.idleListener = listener;
  }

  becomeIdle(): void {
    this.deferred = false;
    this.isTurnRunning = false;
    this.idleListener?.();
  }
}

function pool(): { pool: SessionRuntimePool<FakeRuntime>; made: FakeRuntime[] } {
  const made: FakeRuntime[] = [];
  return {
    made,
    pool: new SessionRuntimePool((_workspace, _sessionId) => {
      const runtime = new FakeRuntime();
      made.push(runtime);
      return runtime;
    }),
  };
}

describe("SessionRuntimePool", () => {
  it("runs two sessions at once and keeps a third submit on the same session busy", async () => {
    const { pool: runs, made } = pool();
    const first = runs.submit("C:\\work", "sess-a", "one", undefined, "cfg");
    const second = runs.submit("C:/work", "sess-b", "two", undefined, "cfg");
    await Promise.resolve();
    expect(made).toHaveLength(2);
    expect(made[0]!.isTurnRunning).toBe(true);
    expect(made[1]!.isTurnRunning).toBe(true);
    await expect(runs.submit("c:\\work", "sess-a", "again", undefined, "cfg")).rejects.toMatchObject({
      code: "busy",
    });
    expect(made).toHaveLength(2);
    made[0]!.finish();
    made[1]!.finish();
    await first;
    await second;
    expect(runs.size).toBe(0);
  });

  it("rejects the sixth live session", async () => {
    const { pool: runs, made } = pool();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      pending.push(runs.submit("D:\\repo", `sess-${i}`, "go", undefined, "cfg"));
    }
    await Promise.resolve();
    await expect(runs.submit("D:\\repo", "sess-extra", "go", undefined, "cfg")).rejects.toMatchObject({
      code: "busy",
      message: "已有 5 个会话在执行",
    });
    expect(made).toHaveLength(MAX_CONCURRENT_RUNS);
    for (const runtime of made) runtime.finish();
    await Promise.all(pending);
  });

  it("keeps the object while a deferred subagent is still running", async () => {
    const { pool: runs, made } = pool();
    const pending = runs.submit("/repo", "sess-a", "go", undefined, "cfg");
    await Promise.resolve();
    made[0]!.deferred = true;
    made[0]!.finish();
    await pending;
    expect(runs.size).toBe(1);
    expect(runs.get("/repo", "sess-a")).toBe(made[0]);
  });

  it("does not replace a running object when the config key changes", async () => {
    const { pool: runs, made } = pool();
    const pending = runs.submit("/repo", "sess-a", "go", undefined, "old");
    await Promise.resolve();
    const again = runs.submit("/repo", "sess-a", "next", undefined, "new");
    await Promise.resolve();
    expect(made).toHaveLength(1);
    await expect(again).rejects.toMatchObject({ code: "busy" });
    made[0]!.finish();
    await pending;
  });

  it("builds a new object for the next send after the previous one went idle", async () => {
    const { pool: runs, made } = pool();
    const pending = runs.submit("/repo", "sess-a", "go", undefined, "old");
    await Promise.resolve();
    made[0]!.finish();
    await pending;
    const next = runs.submit("/repo", "sess-a", "again", undefined, "new");
    await Promise.resolve();
    expect(made).toHaveLength(2);
    expect(made[1]!.watched).toBe(null);
    made[1]!.finish();
    await next;
  });

  it("watches only that session and refuses to start a sixth wake", async () => {
    const { pool: runs, made } = pool();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      pending.push(runs.submit("/repo", `sess-${i}`, "go", undefined, "cfg"));
    }
    await Promise.resolve();
    await expect(runs.watch("/repo", "sess-extra", "cfg")).resolves.toBe(false);
    expect(made).toHaveLength(MAX_CONCURRENT_RUNS);
    const watched = runs.watch("/repo", "sess-0", "cfg");
    await Promise.resolve();
    expect(made[0]!.watched).toBe("sess-0");
    for (const runtime of made) runtime.finish();
    await Promise.all(pending);
    await watched;
  });

  it("tells the caller when the slot is actually free, and not while a subagent still runs", async () => {
    const released: string[] = [];
    const made: FakeRuntime[] = [];
    const runs = new SessionRuntimePool<FakeRuntime>(
      () => {
        const runtime = new FakeRuntime();
        made.push(runtime);
        return runtime;
      },
      (_workspace, sessionId) => released.push(sessionId),
    );
    const pending = runs.submit("/repo", "sess-a", "go", undefined, "cfg");
    await Promise.resolve();
    made[0]!.deferred = true;
    made[0]!.finish();
    await pending;
    expect(runs.size).toBe(1);
    expect(released).toEqual([]);
    made[0]!.becomeIdle();
    expect(runs.size).toBe(0);
    expect(released).toEqual(["sess-a"]);
  });

  it("cancel stops only the named session", async () => {
    const { pool: runs, made } = pool();
    const first = runs.submit("/repo", "sess-a", "go", undefined, "cfg");
    const second = runs.submit("/other", "sess-b", "go", undefined, "cfg");
    await Promise.resolve();
    runs.cancel("/repo", "sess-a");
    await first;
    expect(made[0]!.cancelled).toBe(true);
    expect(made[1]!.cancelled).toBe(false);
    expect(made[1]!.isTurnRunning).toBe(true);
    made[1]!.finish();
    await second;
  });
});
