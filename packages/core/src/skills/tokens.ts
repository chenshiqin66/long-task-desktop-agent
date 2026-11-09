/** Same shape as SKILL_NAME_RE, without anchors, so it can sit after a slash. */
const SKILL_NAME_SRC = "[a-z0-9]+(?:-[a-z0-9]+)*";
/** The lookahead refuses a name that a path goes on from: `/etc/hosts`, `/mnt\d`, `/notes.md`. */
const TOKEN = new RegExp(`(^|\\s)/(${SKILL_NAME_SRC})\\b(?![/\\\\]|\\.\\w)`, "g");
/** Code spans and fences are literal text, so `/usr` in backticks stays a path. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Skill names marked in a user message. `/` must start the text or follow whitespace.
 * The renderer checks a draft through IPC with this same function, so there is one rule.
 */
export function extractSkillTokens(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.replace(CODE, " ").matchAll(TOKEN)) {
    const name = match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
