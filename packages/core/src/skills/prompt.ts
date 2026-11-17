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
- When a skill body section in this request is complete, do not call read_skill for that body again. Call read_skill with path to read a reference or asset.
- When a skill body section says it was cut off, call read_skill without path to read the rest of that body. path reads a different file in the skill, not the rest of this body.
- To read, list, or search inside a skill, call read_file, list_dir, or keyword_search. Pass skill plus a path relative to that skill, or pass an absolute path that is already inside that skill. An absolute path is accepted only when it lands in one installed skill, and the tool stays inside that skill.
- Run a skill script with run_skill_script. Pass the skill name, a path relative to that skill, and an args array. The program starts python or node on that file. Do not use powershell or bash to read the skill directory or to run its scripts.
- Do not edit the skill directory.`;

/** Characters of a skill body copied into system. A longer body stays on disk and is read again with read_skill. */
export const SKILL_BODY_ATTACH_MAX = 8_000;

export function skillBodyIsComplete(body: string): boolean {
  return body.length <= SKILL_BODY_ATTACH_MAX;
}

/** Names whose full body is in this request. A cut-off body must not answer read_skill with「已在上下文中」. */
export function fullyAttachedSkillNames(bodies: readonly SkillBodyAttachment[]): Set<string> {
  return new Set(bodies.filter((skill) => skillBodyIsComplete(skill.body)).map((skill) => skill.name));
}

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
    .map((skill) => {
      if (skillBodyIsComplete(skill.body)) {
        return `# Skill body: ${skill.name}\nSkill directory: ${skill.directory}\n${skill.body}`;
      }
      const rest = skill.body.length - SKILL_BODY_ATTACH_MAX;
      const head = skill.body.slice(0, SKILL_BODY_ATTACH_MAX);
      return `# Skill body: ${skill.name}\nSkill directory: ${skill.directory}\n${head}\n\n正文在此截断。后面还有 ${rest} 字。需要后文时调用 read_skill，不要带 path。`;
    })
    .join("\n\n");
}

/** Outbound stub for a read_skill result from an earlier user turn. */
export function readSkillHistoryStub(name: string, relativePath?: string): string {
  const what = relativePath?.trim() ? relativePath.trim() : "正文";
  return `此前读过技能 ${name} 的${what}。需要时再调用 read_skill。`;
}
