import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoMemoryOf, loadStoredConfig, saveStoredConfig } from "../src/config/loadConfig.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("autoMemory config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-memcfg-"));
  });

  afterEach(async () => {
    await rmWorkspace(dir);
  });

  it("treats a missing value as on and keeps an explicit false", async () => {
    expect(autoMemoryOf(null)).toBe(true);
    expect(autoMemoryOf({ baseUrl: "b", model: "m", apiKey: "k" })).toBe(true);
    const path = join(dir, "config.json");
    await saveStoredConfig({ baseUrl: "b", model: "m", apiKey: "k", autoMemory: false }, path);
    expect(autoMemoryOf(await loadStoredConfig(path))).toBe(false);
  });
});