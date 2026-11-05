export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  tool: "工具",
  error: "错误",
  system: "系统",
};

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

function mdLink(href: string, label: string): string {
  const title = /^https?:\/\//i.test(href) ? "点击打开" : "点击打开所在文件夹";
  return `<a class="md-link" href="#" data-open="${href}" title="${title}">${label}</a>`;
}

/** Paths/URLs agents often wrap in backticks — still make them openable. */
export function looksOpenable(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 2048) return false;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return true;
  if (/^\/mnt\/[a-zA-Z]\//.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^\/[a-zA-Z]\//.test(s) && /\.[a-zA-Z0-9]{1,8}$/.test(s)) return true;
  // Workspace-relative file names the model wraps in backticks or markdown.
  if (s.includes("..") || s.includes("\\") && !/^[A-Za-z]:[\\/]/.test(s)) return false;
  return /^(?:[^\\/:*?"<>|\s]+\/)*[^\\/:*?"<>|\s]+\.[A-Za-z0-9]{1,8}$/.test(s);
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
    const inner = c.trim();
    if (looksOpenable(inner)) {
      const target = trimOpenable(inner);
      return hold(`<code class="md-inline md-inline-link">${mdLink(target, c)}</code>`);
    }
    return hold(`<code class="md-inline">${c}</code>`);
  });
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
    hold(mdLink(url, text)),
  );
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
  t = t.replace(AUTO_LINK_RE, (m) => {
    const target = trimOpenable(m);
    return hold(mdLink(target, target));
  });
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
  const linked = escaped.replace(AUTO_LINK_RE, (m) => {
    const target = trimOpenable(m);
    return hold(mdLink(target, target));
  });
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

export function setRichText(node: HTMLElement, text: string, rich: boolean): void {
  if (rich) {
    // Keep source markdown so we can re-render after renderer/CSS upgrades.
    node.dataset.rawMd = text;
    node.innerHTML = formatMarkdown(text);
  } else {
    delete node.dataset.rawMd;
    node.textContent = text;
  }
}

/** Re-apply Markdown to every assistant bubble that still has raw source. */
export function rerenderAllAssistantMarkdown(container: HTMLElement): number {
  let count = 0;
  const bodies = Array.from(
    container.querySelectorAll(".msg.assistant .msg-body"),
  ) as HTMLElement[];
  for (const body of bodies) {
    const raw = body.dataset.rawMd;
    if (raw == null) continue;
    setRichText(body, raw, true);
    count += 1;
  }
  return count;
}

/** Returns the `.msg-body` element (streaming appends here). */
export function appendMessage(
  container: HTMLElement,
  role: string,
  content: string,
  opts?: { rich?: boolean; images?: string[] },
) {
  const div = el("div", { class: `msg ${role}` });
  if (opts?.images?.length) {
    const row = el("div", { class: "msg-images" });
    for (const src of opts.images) {
      row.append(el("img", { src, alt: "附件图片" }));
    }
    div.append(row);
  }
  const body = el("div", { class: "msg-body" });
  if (role === "assistant" && opts?.rich !== false) {
    setRichText(body, content, true);
  } else {
    body.textContent = content;
  }
  // 用户/助手靠左右气泡区分，不再显示「用户」「助手」标签；错误等仍保留。
  if (role !== "user" && role !== "assistant") {
    div.append(el("span", { class: "msg-role" }, ROLE_LABEL[role] ?? role));
  }
  if (content || role !== "user") div.append(body);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return body;
}

export function setToolDetailContent(node: HTMLElement, detail: string): void {
  node.innerHTML = linkifyPlainText(detail);
}

export function appendToolStep(
  container: HTMLElement,
  opts: { title: string; detail?: string; open?: boolean },
): HTMLElement {
  const wrap = el("div", { class: "msg tool-step" });
  const details = document.createElement("details");
  if (opts.open) details.open = true;
  const summary = el("summary", { class: "tool-summary" }, opts.title);
  const body = el("div", { class: "tool-detail" });
  setToolDetailContent(body, opts.detail ?? "");
  details.append(summary, body);
  wrap.append(details);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return body;
}

const PERMISSION_CMD_PREVIEW = 2400;

export function appendPermissionCard(
  container: HTMLElement,
  opts: {
    requestId: string;
    tool: string;
    summary: string;
    command?: string;
    onAllow: () => void;
    onDeny: () => void;
  },
): HTMLElement {
  const card = el("div", { class: "permission-card", "data-request-id": opts.requestId });
  const title = el("div", { class: "permission-title" }, "需要确认才能执行");
  const meta = el("div", { class: "permission-meta" }, `${opts.tool} · ${opts.summary}`);

  const raw = opts.command?.trim() ? opts.command : "";
  const truncated =
    raw.length > PERMISSION_CMD_PREVIEW
      ? `${raw.slice(0, PERMISSION_CMD_PREVIEW)}\n…（已截断，共 ${raw.length} 字符）`
      : raw;
  const body = el("pre", { class: "permission-body" }, truncated || opts.summary);

  const actions = el("div", { class: "permission-actions" });
  const allowBtn = el("button", { type: "button", class: "perm-allow" }, "允许");
  const denyBtn = el("button", { type: "button", class: "perm-deny" }, "拒绝");
  const dismiss = () => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    card.remove();
    // No leftover "ghost" cards — hide dock when nothing pending.
    if (!container.querySelector(".permission-card")) {
      container.hidden = true;
      container.innerHTML = "";
    }
  };
  allowBtn.onclick = () => {
    dismiss();
    opts.onAllow();
  };
  denyBtn.onclick = () => {
    dismiss();
    opts.onDeny();
  };
  actions.append(allowBtn, denyBtn);
  card.append(title, meta, body, actions);
  container.hidden = false;
  container.appendChild(card);
  // Keep action row reachable; don't scroll the huge body into the middle of the viewport.
  actions.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return card;
}

export function appendAskCard(
  container: HTMLElement,
  opts: {
    requestId: string;
    question: string;
    options: string[];
    onAnswer: (text: string) => void;
    onCancel: () => void;
  },
): HTMLElement {
  const card = el("div", { class: "ask-card", "data-request-id": opts.requestId });
  const title = el("div", { class: "ask-title" }, "需要你回答后才能继续");
  const question = el("p", { class: "ask-question" }, opts.question);
  card.append(title, question);
  if (opts.options.length) {
    const choices = el("div", { class: "ask-options" });
    for (const option of opts.options) {
      const btn = el("button", { type: "button", class: "ask-option" }, option);
      btn.onclick = () => opts.onAnswer(option);
      choices.append(btn);
    }
    card.append(choices);
  }
  const hint = el(
    "p",
    { class: "ask-hint" },
    opts.options.length
      ? "可以点一个选项，也可以在下面输入自己的回答。Esc 停止。"
      : "在下面的输入框回答。Esc 停止。",
  );
  const stop = el("button", { type: "button", class: "ask-stop" }, "停止");
  stop.onclick = () => opts.onCancel();
  const row = el("div", { class: "ask-row" });
  row.append(hint, stop);
  card.append(row);
  container.hidden = false;
  container.appendChild(card);
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return card;
}

export function renderEmptyState(container: HTMLElement, kind: "no-workspace" | "no-session" | "idle"): void {
  container.innerHTML = "";
  const box = el("div", { class: "empty-state" });
  if (kind === "no-workspace") {
    box.innerHTML = `
      <p class="empty-kicker">开始之前</p>
      <h2 class="empty-title">先选择一个本地工作区</h2>
      <ol class="empty-steps">
        <li><strong>工作区右侧的 +</strong> — 增加一个目录，已有工作区仍留在列表里</li>
        <li><strong>直接发送</strong> — 左侧会自动出现这个会话</li>
        <li><strong>发送指令</strong> — 写文件走 write_file；命令 / 搜索 / 联网按需调用</li>
      </ol>
      <p class="empty-hint">写删类命令会弹出确认；危险命令会被拦截。</p>`;
  } else if (kind === "no-session") {
    box.innerHTML = `
      <p class="empty-kicker">工作区已就绪</p>
      <h2 class="empty-title">直接输入，发送即开始</h2>
      <p class="empty-hint">第一次发送会在左侧加上这个会话。同一工作区可以有多个会话，互不影响历史。</p>`;
  } else {
    box.innerHTML = `
      <p class="empty-kicker">会话已打开</p>
      <h2 class="empty-title">输入任务，Enter 发送</h2>
      <p class="empty-hint">Shift+Enter 换行。运行中发送按钮会变成「停止」。需要你做决定时，这一轮会停下来等回答。</p>`;
  }
  container.appendChild(box);
}
