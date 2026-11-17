import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LockTimeoutError, replaceFile, withDirLock } from "../src/store/fileLock.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("fileLock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-lock-"));
  });

  afterEach(async () => {
    await rmWorkspace(dir);
  });

  it("replaces a file and leaves no temporary file behind", async () => {
    const path = join(dir, "note.json");
    await replaceFile(path, "first");
    await replaceFile(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
    expect(await readdir(dir)).toEqual(["note.json"]);
  });

  it("runs one caller at a time", async () => {
    const path = join(dir, "count.txt");
    await writeFile(path, "0", "utf8");
    const bump = () =>
      withDirLock(dir, "Test", async () => {
        const n = Number(await readFile(path, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await writeFile(path, String(n + 1), "utf8");
      });
    await Promise.all(Array.from({ length: 8 }, bump));
    expect(await readFile(path, "utf8")).toBe("8");
  });

  it("does not run the callback again when the callback itself fails with EEXIST", async () => {
    let runs = 0;
    const failure = Object.assign(new Error("file exists"), { code: "EEXIST" });
    await expect(
      withDirLock(dir, "Test", async () => {
        runs += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(runs).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("takes over a lock left behind by a crashed process", async () => {
    const lock = join(dir, ".lock");
    await writeFile(lock, "999999 0\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withDirLock(dir, "Test", async () => "ran")).toBe("ran");
  });

  it("gives up with LockTimeoutError while another holder keeps the lock", async () => {
    await writeFile(join(dir, ".lock"), `${process.pid} ${Date.now()}\n`, "utf8");
    const attempt = withDirLock(dir, "Memory", async () => "ran", { waitMs: 100 });
    await expect(attempt).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(attempt).rejects.toThrow("Memory lock timed out");
  });
});
