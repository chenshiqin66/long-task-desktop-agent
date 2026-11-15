import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isPathInside, resolveWithinWorkspace } from "../pathSandbox.js";
import { matchInstalledSkillPath, resolveSkillScope } from "../skills/installedSkills.js";
import type { ToolContext } from "./types.js";

export interface ToolLocation {
  target: string;
  /** Real directory the final path must stay inside. */
  boundary: string;
  /** Root used when printing a relative path back to the model. */
  displayRoot: string;
  /** Set when the path was resolved inside one installed skill. */
  skill?: string;
}

/**
 * Workspace path, or one installed skill. An absolute path that lands inside a
 * skill is read as that skill plus the relative path. A skill argument never
 * falls back to the workspace.
 */
export async function locateToolPath(
  requested: string,
  skillArg: string,
  ctx: Pick<ToolContext, "workspacePath" | "skillsRoot">,
): Promise<ToolLocation | { error: string }> {
  const skill = skillArg.trim();
  const raw = requested.trim();
  if (skill) {
    let relative = raw;
    if (raw && isAbsolute(raw)) {
      const match = await matchInstalledSkillPath(raw, ctx.skillsRoot);
      if (!match || match.skill !== skill) return { error: `路径超出技能目录：${raw}` };
      relative = match.relativePath;
    }
    const resolved = await resolveSkillScope(skill, relative || undefined, ctx.skillsRoot);
    if ("error" in resolved) return { error: resolved.error };
    return {
      target: resolved.target,
      boundary: resolved.root,
      displayRoot: resolved.root,
      skill,
    };
  }
  if (raw && isAbsolute(raw)) {
    const match = await matchInstalledSkillPath(raw, ctx.skillsRoot);
    if (match) {
      const resolved = await resolveSkillScope(match.skill, match.relativePath || undefined, ctx.skillsRoot);
      if ("error" in resolved) return { error: resolved.error };
      return {
        target: resolved.target,
        boundary: resolved.root,
        displayRoot: resolved.root,
        skill: match.skill,
      };
    }
  }
  try {
    const abs = resolveWithinWorkspace(ctx.workspacePath, raw || ".");
    const boundary = await realpath(ctx.workspacePath);
    let target: string;
    try {
      target = await realpath(abs);
    } catch (err) {
      return { error: String(err) };
    }
    if (!isPathInside(boundary, target)) return { error: `Path is outside workspace: ${raw || "."}` };
    return { target, boundary, displayRoot: ctx.workspacePath };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
