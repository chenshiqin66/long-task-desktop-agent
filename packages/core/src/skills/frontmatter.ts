/** Installed skill directory names. One path segment, no dot, no uppercase. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Markdown after the closing frontmatter fence. */
  body: string;
}

export function isSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_RE.test(name);
}

export function parseSkillMarkdown(raw: string): SkillFrontmatter {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    throw new Error("技能说明无效：缺少 frontmatter");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("技能说明无效：frontmatter 没有结束");
  const fields = parseFields(lines.slice(1, end));
  const name = (fields.name ?? "").trim();
  const description = (fields.description ?? "").trim();
  if (!name || !description) throw new Error("技能说明无效：缺少 name 或 description");
  if (!isSkillName(name)) throw new Error(`技能名字不合法：${name}`);
  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
  return { name, description, body };
}

function parseFields(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!matched) throw new Error("技能说明无效：无法解析 frontmatter");
    const key = matched[1]!;
    const indicator = (matched[2] ?? "").trim();
    if (indicator === ">" || indicator === ">-" || indicator === "|" || indicator === "|-") {
      const folded = indicator.startsWith(">");
      const strip = indicator.endsWith("-");
      const block = readBlock(lines, i + 1, folded);
      out[key] = (strip ? block.text.replace(/\n$/, "") : block.text).trim();
      i = block.next;
      continue;
    }
    out[key] = unquote(indicator);
    i += 1;
  }
  return out;
}

function readBlock(lines: string[], start: number, folded: boolean): { text: string; next: number } {
  let indent = -1;
  const collected: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      collected.push("");
      continue;
    }
    const current = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent < 0) indent = current;
    if (current < indent) break;
    collected.push(line.slice(indent));
  }
  if (folded) {
    const paragraphs: string[] = [];
    let buf: string[] = [];
    for (const line of collected) {
      if (!line.trim()) {
        if (buf.length) paragraphs.push(buf.join(" "));
        buf = [];
      } else {
        buf.push(line.trim());
      }
    }
    if (buf.length) paragraphs.push(buf.join(" "));
    return { text: paragraphs.join("\n"), next: i };
  }
  return { text: collected.join("\n"), next: i };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
