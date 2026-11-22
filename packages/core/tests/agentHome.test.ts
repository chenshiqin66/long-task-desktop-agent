import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentHome, legacyAgentHome } from "../src/config/agentHome.js";
import { getDefaultConfigPath, saveStoredConfig, loadStoredConfig } from "../src/config/loadConfig.js";

describe("agentHome", () => {
  const prev = process.env.LONG_TASK_AGENT_HOME;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-home-"));
    process.env.LONG_TASK_AGENT_HOME = dir;
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.LONG_TASK_AGENT_HOME;
    else process.env.LONG_TASK_AGENT_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it("LONG_TASK_AGENT_HOME overrides the default location", () => {
    expect(getAgentHome()).toBe(dir);
    expect(getDefaultConfigPath()).toBe(join(dir, "config.json"));
    expect(legacyAgentHome().endsWith(".long-task-agent")).toBe(true);
  });

  it("writes config.json.bak before replacing config.json", async () => {
    const path = join(dir, "config.json");
    await saveStoredConfig(
      { baseUrl: "https://a.example/v1", model: "m1", apiKey: "k1", models: [] },
      path,
    );
    await saveStoredConfig(
      { baseUrl: "https://b.example/v1", model: "m2", apiKey: "k2", models: [] },
      path,
    );
    const bak = await readFile(`${path}.bak`, "utf8");
    const cur = await loadStoredConfig(path);
    expect(JSON.parse(bak).apiKey).toBe("k1");
    expect(cur?.apiKey).toBe("k2");
  });
});

describe("agentHome legacy claim", () => {
  it("detects this monorepo as the desktop-agent root", async () => {
    const { detectDesktopAgentRoot } = await import("../src/config/agentHome.js");
    const root = detectDesktopAgentRoot();
    expect(root).toBeTruthy();
    const pkg = JSON.parse(await readFile(join(root!, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("long-task-desktop-agent");
  });
});
