import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { StoredConfig } from "./types.js";
import type { AgentConfig } from "../types.js";
import { DEFAULT_AGENT_CONFIG } from "../types.js";

export function getDefaultConfigPath(): string {
  return join(homedir(), ".long-task-agent", "config.json");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function loadStoredConfig(
  path = getDefaultConfigPath(),
): Promise<StoredConfig | null> {
  try {
    // Windows editors / PowerShell -Encoding utf8 often write a UTF-8 BOM;
    // Node JSON.parse then fails and the app silently falls back to OpenAI defaults.
    return JSON.parse(stripBom(await readFile(path, "utf8"))) as StoredConfig;
  } catch {
    return null;
  }
}

export async function saveStoredConfig(
  cfg: StoredConfig,
  path = getDefaultConfigPath(),
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {
    /* best-effort on platforms that ignore mode */
  });
  await writeFile(path, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export function toAgentConfig(stored: StoredConfig): AgentConfig {
  return {
    // Trim: prompt()/hand-edited JSON often leave leading spaces that break fetch URLs.
    baseUrl: stored.baseUrl.trim(),
    model: stored.model.trim(),
    apiKey: stored.apiKey.trim(),
    bashTimeoutMs: stored.bashTimeoutMs ?? DEFAULT_AGENT_CONFIG.bashTimeoutMs,
    maxSteps: stored.maxSteps ?? DEFAULT_AGENT_CONFIG.maxSteps,
    contextCharLimit: stored.contextCharLimit ?? DEFAULT_AGENT_CONFIG.contextCharLimit,
    maxToolOutputChars:
      stored.maxToolOutputChars ?? DEFAULT_AGENT_CONFIG.maxToolOutputChars,
    maxReadChars: stored.maxReadChars ?? DEFAULT_AGENT_CONFIG.maxReadChars,
    maxSearchResults: stored.maxSearchResults ?? DEFAULT_AGENT_CONFIG.maxSearchResults,
  };
}
