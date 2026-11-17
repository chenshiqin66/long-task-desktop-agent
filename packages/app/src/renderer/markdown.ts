/** String-only markdown helpers. No DOM, so a plain Node script can import them. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal markdown for assistant replies (no external deps). */
export function formatMarkdown(src: string): string {
  // Collapse runaway blank lines from model output (never keep 3+ newlines).
  const normalized = src.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const escaped = escapeHtml(normalized);
  const parts: string[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = fence.exec(escaped))) {
    parts.push(proseMd(escaped.slice(last, m.index)));
    const lang = (m[1] || "").trim();
    parts.push(
      `<pre class="md-code"><code class="lang-${escapeHtml(lang)}">${m[2]}</code></pre>`,
    );
    last = m.index + m[0].length;
  }
  parts.push(proseMd(escaped.slice(last)));
  return parts.join("");
}

const AUTO_LINK_RE =
  /(?:https?:\/\/[^\s<\u0000]+|file:\/\/[^\s<\u0000]+|\/mnt\/[a-zA-Z]\/[^\s<\u0000；。，、）)」』]+|(?:[A-Za-z]:)(?:\\[^\s<\u0000；。，、）)」』]+|\/[^\s<\u0000；。，、）)」』]+))/g;

function mdLink(href: string, label: string, local = false): string {
  const title = local ? "点击打开所在文件夹" : "点击打开";
  const flag = local ? ' data-local="1"' : "";
  return `<a class="md-link" href="#" data-open="${href}"${flag} title="${title}">${label}</a>`;
}

/**
 * True when the text is an URL or a path with a directory, not a bare file name.
 * Bare names like `system-architecture.png` are mentions, not locations.
 */
export function looksOpenable(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 2048) return false;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return true;
  if (/^\/mnt\/[a-zA-Z]\//.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^\/[a-zA-Z]\//.test(s) && /\.[a-zA-Z0-9]{1,8}$/.test(s)) return true;
  if (s.includes("..") || (s.includes("\\") && !/^[A-Za-z]:[\\/]/.test(s))) return false;
  return /^(?:[^\\/:*?"<>|\s]+\/)+[^\\/:*?"<>|\s]+\.[A-Za-z0-9]{1,8}$/.test(s);
}

function linkedHtml(raw: string, label: string): string | null {
  const target = trimOpenable(raw);
  if (/^https?:\/\//i.test(target)) return mdLink(target, label, false);
  if (!looksOpenable(target)) return null;
  return mdLink(target, label, true);
}

function trimOpenable(raw: string): string {
  let s = raw.trim();
  if (/^https?:/i.test(s)) s = s.replace(/[.,;:!?)]+$/, "");
  return s;
}

function inlineFormat(s: string): string {
  const slots: string[] = [];
  const hold = (html: string) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let t = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    const link = linkedHtml(c, c);
    if (link) return hold(`<code class="md-inline md-inline-link">${link}</code>`);
    return hold(`<code class="md-inline">${c}</code>`);
  });
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const link = linkedHtml(url, text);
    return hold(link ?? text);
  });
  // 来源行: [n] title — https://… → [n] <a>title</a>（不展示裸 URL）
  t = t.replace(
    /\[(\d+)\]\s+(.+?)\s+[—–\-]\s+(https?:\/\/[^\s<]+)/g,
    (_m, n: string, title: string, url: string) => {
      const target = trimOpenable(url);
      return hold(`[${n}] ${mdLink(target, title.trim())}`);
    },
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  t = t.replace(AUTO_LINK_RE, (m) => hold(linkedHtml(m, trimOpenable(m)) ?? m));
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? "");
}

/** Escape + autolink for tool panels (no full markdown). */
export function linkifyPlainText(src: string): string {
  const escaped = escapeHtml(src);
  const slots: string[] = [];
  const hold = (html: string) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };
  const linked = escaped.replace(AUTO_LINK_RE, (m) => hold(linkedHtml(m, trimOpenable(m)) ?? m));
  return linked
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? "")
    .replace(/\n/g, "<br>");
}

function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !/-{3,}/.test(t)) return false;
  return /^[\s|:-]+$/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.indexOf("|", 1) !== -1;
}

function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** Drop trailing empty cells from over-terminated pipes: `| a | b | |` */
function trimTrailingEmptyCells(cells: string[]): string[] {
  const out = cells.slice();
  while (out.length > 1 && !(out[out.length - 1] ?? "").trim()) out.pop();
  return out;
}

function tableCell(tag: "th" | "td", text: string): string {
  const inner = inlineFormat(text);
  // Short cells (e.g. "10") stay on one line; long prose may wrap.
  const wrap = tag === "td" && [...text].length > 24;
  const cls = wrap ? ' class="md-cell-wrap"' : "";
  return `<${tag}${cls}>${inner}</${tag}>`;
}

function renderTable(lines: string[]): string {
  const header = trimTrailingEmptyCells(splitTableCells(lines[0] ?? ""));
  const bodyRows = lines.slice(2).map((line) => {
    const row = trimTrailingEmptyCells(splitTableCells(line));
    // Pad/truncate to header width so ragged pipes don't invent extra columns.
    return header.map((_, i) => row[i] ?? "");
  });
  const thead = `<thead><tr>${header.map((h) => tableCell("th", h)).join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows
    .map((row) => `<tr>${row.map((c) => tableCell("td", c)).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

function sourceLabel(line: string): string | null {
  const t = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  if (t === "来源" || t === "参考来源" || /^sources$/i.test(t)) return "来源";
  return null;
}

/** `[1] title — url` or the prompt's `[1] [title](url)`. */
function isBareSourceItem(line: string): boolean {
  return /^\s*\[\d+\]\s+\S/.test(line);
}

/** Same citation as a bullet or numbered item: `- [1] [title](url)`. */
function isListedSourceItem(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+\[\d+\]\s+\S/.test(line);
}

function isSourceItem(line: string): boolean {
  return isBareSourceItem(line) || isListedSourceItem(line);
}

function renderSources(lines: string[]): string {
  const parts = lines.map((line) => {
    const label = sourceLabel(line);
    if (label) return `<p class="md-sources-label">${label}</p>`;
    const body = line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "");
    return `<p class="md-cite">${inlineFormat(body)}</p>`;
  });
  return `<div class="md-sources">${parts.join("")}</div>`;
}

function matchListItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = line.match(/^\s*([-*+])\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[2]! };
  const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[2]! };
  return null;
}

function proseMd(chunk: string): string {
  const trimmed = chunk.replace(/^\n+|\n+$/g, "");
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = () => {
    if (!para.length) return;
    const html = inlineFormat(para.join("\n")).replace(/\n/g, "<br>");
    out.push(`<p class="md-p">${html}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }

    if (sourceLabel(line) || isBareSourceItem(line)) {
      flushPara();
      const block: string[] = [];
      if (sourceLabel(line)) {
        block.push(line);
        i += 1;
      }
      while (i < lines.length) {
        if (!lines[i]!.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j]!.trim()) j += 1;
          if (j < lines.length && isSourceItem(lines[j]!)) {
            i = j;
            continue;
          }
          break;
        }
        if (!isSourceItem(lines[i]!)) break;
        block.push(lines[i]!);
        i += 1;
      }
      if (block.length) out.push(renderSources(block));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      out.push(
        `<h${level} class="md-h md-h${level}">${inlineFormat(heading[2]!.trim())}</h${level}>`,
      );
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flushPara();
      const tableLines = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) {
        tableLines.push(lines[i]!);
        i += 1;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    const listFirst = matchListItem(line);
    if (listFirst) {
      flushPara();
      const ordered = listFirst.ordered;
      const items: string[] = [listFirst.text];
      i += 1;
      while (i < lines.length) {
        if (!lines[i]!.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j]!.trim()) j += 1;
          const peek = j < lines.length ? matchListItem(lines[j]!) : null;
          if (peek && peek.ordered === ordered) {
            i = j;
            continue;
          }
          break;
        }
        const next = matchListItem(lines[i]!);
        if (!next || next.ordered !== ordered) break;
        items.push(next.text);
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag} class="md-list md-${tag}">${items
          .map((t) => `<li>${inlineFormat(t)}</li>`)
          .join("")}</${tag}>`,
      );
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join("");
}

