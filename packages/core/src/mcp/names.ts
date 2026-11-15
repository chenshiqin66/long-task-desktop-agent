import { createHash } from "node:crypto";

/** OpenAI function names stop at 64. `mcp__` + server + `__` has to leave room for the tool. */
export const MCP_SERVER_NAME_MAX = 32;
const MCP_SERVER_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXPOSED_MAX = 64;

export function isMcpServerName(name: string): boolean {
  return name.length >= 1 && name.length <= MCP_SERVER_NAME_MAX && MCP_SERVER_NAME_RE.test(name);
}

/** `mcp__amap__maps_geo` → `amap / maps_geo`. */
export function mcpToolLabel(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const body = toolName.slice(5);
  const split = body.indexOf("__");
  if (split <= 0) return toolName;
  return `${body.slice(0, split)} / ${body.slice(split + 2)}`;
}

export function serverFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const body = toolName.slice(5);
  const split = body.indexOf("__");
  if (split <= 0) return null;
  const server = body.slice(0, split);
  return isMcpServerName(server) ? server : null;
}

/**
 * Stable tool name the model calls. Characters outside the function-name alphabet
 * become underscores. Names that would exceed 64 characters keep a hash tail.
 */
export function exposeToolName(server: string, remote: string): string | null {
  const cleaned = remote
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || !isMcpServerName(server)) return null;
  const full = `mcp__${server}__${cleaned}`;
  if (full.length <= EXPOSED_MAX) return full;
  const hash = createHash("sha256").update(remote).digest("hex").slice(0, 6);
  const prefix = `mcp__${server}__`;
  const room = EXPOSED_MAX - prefix.length - 1 - hash.length;
  if (room < 1) return null;
  return `${prefix}${cleaned.slice(0, room)}_${hash}`;
}
