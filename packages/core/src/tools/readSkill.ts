import { readInstalledSkillFile } from "../skills/installedSkills.js";
import type { Tool, ToolResult } from "./types.js";

export const READ_SKILL_TOOL_NAME = "read_skill";

export const readSkillTool: Tool = {
  definition: {
    name: READ_SKILL_TOOL_NAME,
    description:
      "Read an installed skill. Omit path to read the SKILL.md instructions. Set path to a file inside that skill, such as a reference. The result includes the skill directory so scripts can be run by absolute path.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed skill name" },
        path: {
          type: "string",
          description: "Optional path relative to the skill directory",
        },
      },
      required: ["name"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    const relative = typeof args.path === "string" ? args.path.trim() : "";
    if (!relative && ctx.attachedSkillNames?.has(name)) {
      return { content: "已在上下文中", is_error: false };
    }
    const result = await readInstalledSkillFile(
      name,
      relative || undefined,
      ctx.maxReadChars,
      ctx.skillsRoot,
    );
    if (result.is_error || relative || !result.directory) {
      return { content: result.content, is_error: result.is_error };
    }
    return {
      content: `Skill directory: ${result.directory}\n${result.content}`,
      is_error: false,
    };
  },
};
