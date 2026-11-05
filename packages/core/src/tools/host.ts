import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { bashTool, SHELL_TOOL_NAME, truncateOutput } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { strReplaceTool } from "./strReplace.js";
import { listDirTool } from "./listDir.js";
import { deleteFileTool } from "./deleteFile.js";
import { searchTool } from "./search.js";
import { webSearchTool } from "./webSearch.js";
import { readSkillTool } from "./readSkill.js";
import { runSkillScriptTool } from "./runSkillScript.js";
import { ASK_USER_NOT_LOCAL, ASK_USER_TOOL_NAME, askUserTool } from "./askUserTool.js";
import { isDangerousBash } from "./dangerous.js";

export { truncateOutput, SHELL_TOOL_NAME, isDangerousBash };
export { resolveWebSearchUrl } from "./webSearch.js";
export type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export function createBuiltinTools(): Tool[] {
  return [
    bashTool,
    readFileTool,
    writeFileTool,
    strReplaceTool,
    listDirTool,
    deleteFileTool,
    searchTool,
    webSearchTool,
    askUserTool,
    readSkillTool,
    runSkillScriptTool,
  ];
}

export class ToolHost {
  private readonly byName: Map<string, Tool>;

  constructor(tools: Tool[] = createBuiltinTools()) {
    this.byName = new Map(tools.map((t) => [t.definition.name, t]));
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.byName.values()].map((t) => t.definition);
  }

  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
    if (name === ASK_USER_TOOL_NAME) {
      throw new Error(ASK_USER_NOT_LOCAL);
    }
    if (process.platform === "win32" && name === "bash") {
      return {
        content:
          "Unknown tool: bash. This agent runs on Windows. Call powershell with PowerShell syntax and Windows paths.",
        is_error: true,
      };
    }
    const tool = this.byName.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, is_error: true };
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch (err) {
      return { content: `Invalid JSON arguments: ${String(err)}`, is_error: true };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  }
}
