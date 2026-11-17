import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const LOCK_WAIT_MS = 5_000;
export const STALE_LOCK_MS = 15_000;
const POLL_MS = 15;

export class LockTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} lock timed out`);
    this.name = "LockTimeoutError";
  }
}

export function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

async function tryLock(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
    throw err;
  }
  await handle.close();
  return true;
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

/**
 * Runs fn while holding `{dir}/.lock`. Only taking the lock is retried, so an
 * EEXIST thrown by fn is not mistaken for a held lock. A lock older than
 * STALE_LOCK_MS was left by a process that died and is removed.
 */
export async function withDirLock<T>(
  dir: string,
  label: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const started = Date.now();
  while (!(await tryLock(lockPath))) {
    if (Date.now() - started > waitMs) throw new LockTimeoutError(label);
    if (await isStale(lockPath)) {
      await rm(lockPath, { force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/** Writes a temporary file next to path, then renames it over path. */
export async function replaceFile(path: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    try {
      await rename(tmp, path);
    } catch (err) {
      const code = errorCode(err);
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw err;
      await rm(path, { force: true });
      await rename(tmp, path);
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
