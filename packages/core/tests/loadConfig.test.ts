import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  getDefaultConfigPath,
  loadStoredConfig,
  saveStoredConfig,
  toAgentConfig,
} from "../src/config/loadConfig.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips config outside workspace .agent", async () => {
    const path = join(dir, "config.json");
    await saveStoredConfig(
      {
        baseUrl: "https://api.example.com/v1",
        model: "gpt-x",
        apiKey: "sk-secret",
        maxSteps: 50,
      },
      path,
    );
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("sk-secret");
    expect(path.includes(`${join(".agent")}`)).toBe(false);
    const loaded = await loadStoredConfig(path);
    expect(loaded?.model).toBe("gpt-x");
    const agent = toAgentConfig(loaded!);
    expect(agent.maxSteps).toBe(50);
    expect(agent.bashTimeoutMs).toBe(60_000);
    expect(agent.apiKey).toBe("sk-secret");
  });

  it("returns null when config file missing", async () => {
    const loaded = await loadStoredConfig(join(dir, "missing.json"));
    expect(loaded).toBeNull();
  });

  it("loads config even when file has UTF-8 BOM", async () => {
    const path = join(dir, "bom-config.json");
    const body = JSON.stringify({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      apiKey: "sk-test",
    });
    await writeFile(path, `\uFEFF${body}`, "utf8");
    const loaded = await loadStoredConfig(path);
    expect(loaded?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(loaded?.model).toBe("deepseek-flash");
  });

  it("default path is under homedir/.long-task-agent, not workspace .agent", () => {
    const p = getDefaultConfigPath();
    expect(p).toBe(join(homedir(), ".long-task-agent", "config.json"));
    expect(p.includes("/.agent/")).toBe(false);
  });

  it("saveStoredConfig sets config file mode 0o600 and directory 0o700 on POSIX", async () => {
    if (process.platform === "win32") return;
    const path = join(dir, "secure", "config.json");
    await saveStoredConfig(
      { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" },
      path,
    );
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(dirname(path))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

});
