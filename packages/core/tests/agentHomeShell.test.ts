import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanAgentHomeShell, migrateRootsShell } from "../src/config/agentHome.js";

describe("agent home shell layout", () => {
  let legacy: string;

  beforeEach(async () => {
    legacy = await mkdtemp(join(tmpdir(), "agent-shell-"));
  });

  afterEach(async () => {
    await rm(legacy, { recursive: true, force: true });
  });

  it("lifts roots/<hash> to <hash> and removes the roots wrapper", async () => {
    const key = "50c29e093372f937";
    const nested = join(legacy, "roots", key);
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "config.json"), '{"ok":true}\n', "utf8");
    await writeFile(join(legacy, "roots", ".legacy-claim"), `{"key":"${key}"}\n`, "utf8");
    await writeFile(join(legacy, "roots", ".memory-layout-cleaned"), "{}\n", "utf8");
    await writeFile(join(legacy, "config.json"), '{"stale":true}\n', "utf8");
    await mkdir(join(legacy, "skills"), { recursive: true });

    migrateRootsShell(legacy);
    cleanAgentHomeShell(legacy);

    expect(await readFile(join(legacy, key, "config.json"), "utf8")).toContain("ok");
    expect(await readFile(join(legacy, ".legacy-claim"), "utf8")).toContain(key);
    await expect(access(join(legacy, "roots"))).rejects.toThrow();
    await expect(access(join(legacy, "config.json"))).rejects.toThrow();
    await expect(access(join(legacy, "skills"))).rejects.toThrow();
  });
});
