import type { AgentConfig, LlmProvider, ToolCall } from "@agent/core";
import type { ToolHost, ToolResult } from "@agent/core";
import { coreDistUrl } from "./paths.js";

/**
 * Two pieces of @agent/core are exported from source modules but not from the
 * package index: the isolated subagent loop and the fixed tool subset.
 *
 * The runner is compiled into runner/dist, so a static relative import would
 * break when the output depth changes. Load them from the built package by an
 * absolute file URL instead. `npm run eval` builds core first.
 */

export interface SubagentToolEvent {
  type: "tool_call";
  tool_call: ToolCall;
}

export interface SubagentToolResultEvent {
  type: "tool_result";
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

export interface RunIsolatedSubagentOptions {
  workspacePath: string;
  sessionId: string;
  parentTurnId: string;
  parentToolCallId: string;
  config: AgentConfig;
  provider: LlmProvider;
  skillsRoot: string;
  tools: ToolHost;
  signal: AbortSignal;
  subagentType: "explore" | "worker";
  task: string;
  description: string;
  outputDir?: string;
  agentId?: string;
  taskId?: string;
  onTool?: (event: SubagentToolEvent | SubagentToolResultEvent) => void;
}

export interface CoreInternals {
  runIsolatedSubagent(opts: RunIsolatedSubagentOptions): Promise<ToolResult>;
  toolsForSubagent(type: "explore" | "worker"): readonly string[];
}

let loaded: Promise<CoreInternals> | null = null;

async function importDist<T>(relativePath: string): Promise<T> {
  const url = coreDistUrl(relativePath);
  try {
    return (await import(url)) as T;
  } catch (err) {
    throw new Error(
      `Cannot load ${url}. Build @agent/core first (npm run build -w @agent/core). Underlying error: ${String(err)}`,
    );
  }
}

export function loadCoreInternals(): Promise<CoreInternals> {
  loaded ??= (async () => {
    const subagentRun = await importDist<{
      runIsolatedSubagent: CoreInternals["runIsolatedSubagent"];
    }>("runtime/subagentRun.js");
    const agentTool = await importDist<{
      toolsForSubagent: CoreInternals["toolsForSubagent"];
    }>("tools/agentTool.js");
    return {
      runIsolatedSubagent: subagentRun.runIsolatedSubagent,
      toolsForSubagent: agentTool.toolsForSubagent,
    };
  })();
  return loaded;
}
