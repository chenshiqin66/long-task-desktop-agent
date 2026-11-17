import { mkdir, readFile, chmod, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { replaceFile } from "../store/fileLock.js";
import type { StoredConfig } from "./types.js";
import type { AgentConfig } from "../types.js";
import { DEFAULT_AGENT_CONFIG } from "../types.js";

export function getDefaultConfigPath(): string {
  return join(homedir(), ".long-task-agent", "config.json");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Set when a config file could not be parsed. Cleared by takeConfigQuarantine. */
let pendingQuarantine: { movedTo: string } | { stillAt: string } | null = null;

/** One-shot notice for the app. Missing files do not set this. */
export function takeConfigQuarantine(): { movedTo: string } | { stillAt: string } | null {
  const notice = pendingQuarantine;
  pendingQuarantine = null;
  return notice;
}

export async function loadStoredConfig(
  path = getDefaultConfigPath(),
): Promise<StoredConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    // Windows editors / PowerShell -Encoding utf8 often write a UTF-8 BOM.
    return JSON.parse(stripBom(text)) as StoredConfig;
  } catch {
    const backup = `${path}.broken-${Date.now()}`;
    try {
      await rename(path, backup);
      pendingQuarantine = { movedTo: backup };
    } catch {
      pendingQuarantine = { stillAt: path };
    }
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
  await replaceFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

/** autoMemory is on unless the file says false. */
export function autoMemoryOf(stored: StoredConfig | null): boolean {
  return stored?.autoMemory !== false;
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
    ...(stored.searchBaseUrl?.trim() ? { searchBaseUrl: stored.searchBaseUrl.trim() } : {}),
    ...(stored.searchApiKey?.trim() ? { searchApiKey: stored.searchApiKey.trim() } : {}),
  };
}
