import { rm } from "node:fs/promises";

/** Windows may keep a lock briefly after bash/taskkill; retry EBUSY/EPERM. */
export async function rmWorkspace(dir: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw last;
}
