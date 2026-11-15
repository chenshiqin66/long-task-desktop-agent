import type { Tool } from "../tools/types.js";

/** What a turn can see from the shared MCP pool. Definitions are snapshotted by the caller. */
export interface McpToolSource {
  currentTools(): Tool[];
  /** True only for a connected tool whose server opted into skipping the permission card. */
  autoAllows(toolName: string): boolean;
}
