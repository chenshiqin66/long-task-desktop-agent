import type { IpcMain } from "electron";
import type { McpPool, McpServerInput } from "@agent/core";

function asInput(value: unknown): McpServerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP 配置无效");
  return value as McpServerInput;
}

function asName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("MCP 名称无效");
  return value;
}

export function registerMcpHandlers(ipc: IpcMain, pool: McpPool): void {
  ipc.handle("agent:listMcpServers", () => pool.snapshot());
  ipc.handle("agent:addMcpServer", (_event, input: unknown) => pool.add(asInput(input)));
  ipc.handle("agent:updateMcpServer", (_event, name: unknown, input: unknown) =>
    pool.update(asName(name), asInput(input)),
  );
  ipc.handle("agent:removeMcpServer", (_event, name: unknown) => pool.remove(asName(name)));
  ipc.handle("agent:setMcpEnabled", (_event, name: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("MCP 开关无效");
    return pool.setEnabled(asName(name), enabled);
  });
  ipc.handle("agent:setMcpAutoAllow", (_event, name: unknown, autoAllow: unknown) => {
    if (typeof autoAllow !== "boolean") throw new Error("MCP 自动放行开关无效");
    return pool.setAutoAllow(asName(name), autoAllow);
  });
  ipc.handle("agent:reconnectMcpServer", (_event, name: unknown) => pool.reconnect(asName(name)));
}
