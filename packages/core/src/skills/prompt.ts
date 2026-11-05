export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export interface SkillBodyAttachment {
  name: string;
  directory: string;
  body: string;
}

const SKILL_USE = `Skill use:
- The catalog above is always present. The body is not, until this user message contains /<name> or you call read_skill.
- If /<name> is in the user message, that body is already in this request. Do not call read_skill for the body again. Call read_skill with path to read a reference or asset.
- Run a skill script with run_skill_script. Pass the skill name, a path relative to that skill, and an args array. The program starts python or node on that file. Do not use powershell or bash to read the skill directory or to run its scripts.
- Do not edit the skill directory.`;

export function renderInstalledSkills(skills: SkillCatalogEntry[]): string {
  if (!skills.length) return "";
  const lines = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`);
  return `# Installed skills\n${lines.join("\n")}\n\n${SKILL_USE}`;
}

export function renderSkillBodies(bodies: SkillBodyAttachment[]): string {
  if (!bodies.length) return "";
  return bodies
    .map((skill) => `# Skill body: ${skill.name}\nSkill directory: ${skill.directory}\n${skill.body}`)
    .join("\n\n");
}

/** Outbound stub for a read_skill result from an earlier user turn. */
export function readSkillHistoryStub(name: string, relativePath?: string): string {
  const what = relativePath?.trim() ? relativePath.trim() : "正文";
  return `此前读过技能 ${name} 的${what}。需要时再调用 read_skill。`;
}
