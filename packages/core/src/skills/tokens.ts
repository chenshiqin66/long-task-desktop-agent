/** Same shape as SKILL_NAME_RE, without anchors, so it can sit after a slash. */
const SKILL_NAME_SRC = "[a-z0-9]+(?:-[a-z0-9]+)*";
const TOKEN = new RegExp(`(^|\\s)/(${SKILL_NAME_SRC})\\b`, "g");

/** Skill names marked in a user message. `/` must start the text or follow whitespace. */
export function extractSkillTokens(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const name = match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
