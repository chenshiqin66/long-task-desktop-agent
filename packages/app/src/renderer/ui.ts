import { formatMarkdown, linkifyPlainText } from "./markdown.js";

export { escapeHtml, formatMarkdown, looksOpenable, linkifyPlainText } from "./markdown.js";

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

export const CANCELLED_TURN_NOTICE = "任务已终止";

export function isCancelledNotice(content: string): boolean {
  return content.trim() === CANCELLED_TURN_NOTICE;
}

/** Right-aligned control under a user question. The caller decides when it may send. */
export function appendReaskButton(messageBody: HTMLElement, onClick: () => void): void {
  const msg = messageBody.parentElement;
  if (!msg) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "reask";
  btn.textContent = "重新问";
  btn.addEventListener("click", onClick);
  msg.append(btn);
}

const noticeHosts = new WeakSet<HTMLElement>();
const noticeHostObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    entry.target.querySelectorAll(".msg.notice").forEach((node) => {
      if (node instanceof HTMLElement) fitTaskNotice(node);
    });
  }
});

/** Collapsed receipts stay at 4 lines. A wider pane can change how many lines the text wraps to. */
function watchNoticeHost(container: HTMLElement): void {
  if (noticeHosts.has(container)) return;
  noticeHosts.add(container);
  noticeHostObserver.observe(container);
}

function fitTaskNotice(card: HTMLElement): void {
  if (card.classList.contains("is-open")) return;
  const body = card.querySelector(".notice-body");
  const toggle = card.querySelector(".notice-toggle");
  if (!(body instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return;
  if (body.clientHeight === 0) return;
  card.classList.remove("is-short");
  const overflow = body.scrollHeight > body.clientHeight + 1;
  card.classList.toggle("is-short", !overflow);
  toggle.hidden = !overflow;
}

/** Background receipt. Not a user bubble, so it does not get a re-ask control. */
export function appendTaskNotice(container: HTMLElement, content: string): HTMLElement {
  const div = el("div", { class: "msg notice" });
  const head = el("div", { class: "notice-head" });
  head.append(el("span", { class: "notice-title" }, "后台完成"));
  const toggle = el("button", { type: "button", class: "notice-toggle" }, "展开↓");
  toggle.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  head.append(toggle);
  const body = el("div", { class: "notice-body msg-body" });
  body.textContent = content;
  div.append(head, body);
  toggle.addEventListener("click", () => {
    const open = div.classList.toggle("is-open");
    toggle.textContent = open ? "收起↑" : "展开↓";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) {
      body.scrollTop = 0;
      fitTaskNotice(div);
    }
  });
  placeTranscript(container, div, false);
  watchNoticeHost(container);
  fitTaskNotice(div);
  if (body.clientHeight === 0) requestAnimationFrame(() => fitTaskNotice(div));
  return body;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localDayKey(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** `YYYY-MM-DD HH:mm:ss` on the first message of a local day, otherwise `HH:mm:ss`. */
export function bubbleTimeLabel(at: Date, previous: Date | null): string {
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  if (previous && localDayKey(previous) === localDayKey(at)) return clock;
  return `${localDayKey(at)} ${clock}`;
}

function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function previousStamp(node: HTMLElement): Date | null {
  const root = node.closest(".messages");
  if (!root) return null;
  let found: Date | null = null;
  for (const el of Array.from(root.querySelectorAll(".msg-time"))) {
    if (!(el instanceof HTMLTimeElement)) continue;
    if ((node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) === 0) continue;
    const at = parseStamp(el.dateTime);
    if (at) found = at;
  }
  return found;
}

/** Clock sits beside the bubble, not inside it, so a pinned one-line question stays one line. */
function insertMessageTime(msg: HTMLElement, at: Date): void {
  if (msg.nextElementSibling?.classList.contains("msg-time")) return;
  const time = document.createElement("time");
  time.className = "msg-time";
  time.dateTime = at.toISOString();
  time.textContent = bubbleTimeLabel(at, previousStamp(msg));
  msg.after(time);
}

function stampVisibleBubble(msg: HTMLElement, role: string, content: string, at: string | undefined, images?: string[]): void {
  if (role !== "user" && role !== "assistant") return;
  const visible = role === "user" ? Boolean(content.trim() || images?.length) : Boolean(content.trim());
  if (!visible) return;
  const parsed = parseStamp(at);
  if (!parsed) return;
  insertMessageTime(msg, parsed);
}

/** Put a clock under a bubble once it actually has a reply. A second call does nothing. */
export function ensureMessageTime(body: HTMLElement, at: string | Date = new Date()): void {
  const msg = body.closest(".msg");
  if (!(msg instanceof HTMLElement)) return;
  if (msg.classList.contains("is-blank")) return;
  if (!msg.classList.contains("user") && !msg.classList.contains("assistant")) return;
  const parsed = typeof at === "string" ? parseStamp(at) : at;
  if (!parsed || Number.isNaN(parsed.getTime())) return;
  insertMessageTime(msg, parsed);
}

/** Returns the `.msg-body` element (streaming appends here). */
export function appendMessage(
  container: HTMLElement,
  role: string,
  content: string,
  opts?: { rich?: boolean; images?: string[]; messageId?: string; at?: string },
) {
  const div = el("div", { class: `msg ${role}` });
  if (opts?.messageId) div.dataset.messageId = opts.messageId;
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
  placeTranscript(container, div, role === "user");
  stampVisibleBubble(div, role, content, opts?.at, opts?.images);
  return body;
}

const stickyFrames = new WeakMap<HTMLElement, number>();

/** The folded bar is one text line plus the bubble's own vertical padding. */
function oneLineHeight(node: HTMLElement): number {
  const body = node.querySelector(":scope > .msg-body");
  if (!(body instanceof HTMLElement)) return node.offsetHeight;
  const style = getComputedStyle(body);
  const line = parseFloat(style.lineHeight);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  if (!Number.isFinite(line)) return node.offsetHeight;
  return line + (Number.isFinite(pad) ? pad : 0) + (Number.isFinite(border) ? border : 0);
}

function scrollHoldOf(container: HTMLElement): HTMLElement | null {
  const node = container.querySelector(":scope > .scroll-hold");
  return node instanceof HTMLElement ? node : null;
}

/** Keep a fold offset reachable when the shortened turn no longer fills the viewport. */
function holdFoldOffset(container: HTMLElement, target: number): void {
  const existing = scrollHoldOf(container);
  const held = existing?.offsetHeight ?? 0;
  let holdAt = existing ? parseFloat(existing.dataset.holdAt ?? "0") : 0;
  if (!Number.isFinite(holdAt)) holdAt = 0;
  holdAt = Math.max(holdAt, target);
  const contentMax = container.scrollHeight - held - container.clientHeight;
  const gap = Math.max(0, holdAt - Math.max(0, contentMax));
  if (gap <= 0.5) {
    existing?.remove();
    return;
  }
  const node = existing ?? document.createElement("div");
  if (!existing) {
    node.className = "scroll-hold";
    node.setAttribute("aria-hidden", "true");
    container.append(node);
  }
  node.dataset.holdAt = String(holdAt);
  node.style.flexShrink = "0";
  if (Math.abs(node.offsetHeight - gap) > 0.5) {
    node.style.height = `${gap}px`;
    node.style.minHeight = `${gap}px`;
  }
}

function releaseFoldOffset(container: HTMLElement): void {
  const hold = scrollHoldOf(container);
  if (!hold) return;
  const contentMax = container.scrollHeight - hold.offsetHeight - container.clientHeight;
  if (container.scrollTop <= contentMax + 0.5) hold.remove();
}

/**
 * Folding removes the bubble's height from the document. Move the viewport by the same
 * amount so the lines below stay put. If that offset would be clamped, extend the tail
 * just enough that the previous bubble stays above the viewport.
 */
function foldToLine(container: HTMLElement, node: HTMLElement): void {
  const before = node.offsetHeight;
  const scrollBefore = container.scrollTop;
  node.classList.remove("is-short");
  node.classList.add("is-stuck");
  const delta = Math.max(0, before - node.offsetHeight);
  const target = Math.max(0, scrollBefore - delta);
  holdFoldOffset(container, target);
  void container.scrollHeight;
  if (container.scrollTop >= target - 0.5) return;
  const previous = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  container.scrollTop = target;
  container.style.scrollBehavior = previous;
}

/**
 * A tall bubble scrolls away at full height. It folds to one line only once that is all
 * that remains in the viewport, then stays pinned until the next user message pushes it out.
 * A bubble that is already one line pins as soon as it reaches the top; its height does not change.
 */
function updateStickyTurns(container: HTMLElement): void {
  const padTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
  const viewTop = container.getBoundingClientRect().top;
  const edge = viewTop + padTop;
  let pinned: HTMLElement | null = null;
  for (const node of Array.from(container.querySelectorAll(":scope > .turn > .msg.user"))) {
    if (!(node instanceof HTMLElement)) continue;
    const turn = node.parentElement;
    if (!(turn instanceof HTMLElement)) continue;
    const one = oneLineHeight(node);
    if (node.classList.contains("is-stuck")) {
      const top = node.getBoundingClientRect().top;
      // The pin lets go once the user scrolls up and the bar moves down by about a line.
      if (top > edge + Math.max(one, 16)) {
        node.classList.remove("is-stuck");
        node.classList.toggle("is-short", node.offsetHeight <= one + 2);
        releaseFoldOffset(container);
      } else if (top >= viewTop - 1 && turn.getBoundingClientRect().top < top - 1) {
        pinned = node;
      }
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.height <= one + 2) {
      node.classList.add("is-short");
      const top = node.getBoundingClientRect().top;
      if (top <= edge + 4 && top >= viewTop - 1 && turn.getBoundingClientRect().top < top - 1) pinned = node;
      continue;
    }
    node.classList.remove("is-short");
    const turnBottom = turn.getBoundingClientRect().bottom;
    const entered = rect.top < edge - 1;
    const turnRemains = turnBottom > edge + 4;
    const oneLeft = rect.bottom > edge - 8 && rect.bottom <= edge + one + 6;
    const jumpedPast = rect.bottom <= edge;
    if (entered && turnRemains && (oneLeft || jumpedPast)) {
      foldToLine(container, node);
      const top = node.getBoundingClientRect().top;
      if (top >= viewTop - 1 && top <= edge + 4) pinned = node;
    }
  }
  if (container.querySelector(":scope > .turn > .msg.user.is-stuck")) {
    const hold = scrollHoldOf(container);
    const holdAt = hold ? parseFloat(hold.dataset.holdAt ?? "") : NaN;
    if (Number.isFinite(holdAt)) holdFoldOffset(container, holdAt);
  } else {
    releaseFoldOffset(container);
  }
  placeSeam(container, pinned);
}

function syncStickyTurns(container: HTMLElement): void {
  if (container.dataset.questionNavScroll) return;
  if (stickyFrames.get(container)) return;
  stickyFrames.set(
    container,
    requestAnimationFrame(() => {
      stickyFrames.delete(container);
      updateStickyTurns(container);
    }),
  );
}

/** Re-measure after the transcript grows, before a tail jump lands inside a stale spacer. */
export function refreshStickyTurns(container: HTMLElement): void {
  updateStickyTurns(container);
}

/** History is built in a detached holder and moved into `.messages` later, so watch the live scrollers, not the append target. */
document.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.classList.contains("messages")) syncStickyTurns(target);
  },
  { capture: true, passive: true },
);
window.addEventListener("resize", () => {
  for (const node of Array.from(document.querySelectorAll(".messages"))) {
    if (node instanceof HTMLElement) syncStickyTurns(node);
  }
});

function titleBar(container: HTMLElement): HTMLElement | null {
  const pane = container.closest("#main, #explain-pane");
  const bar = pane?.querySelector(":scope > .main-bar, :scope > .explain-bar");
  return bar instanceof HTMLElement ? bar : null;
}

/** Rectangle from the title-bar bottom (y1) to the stuck bubble top (y2). */
function placeSeam(container: HTMLElement, pinned: HTMLElement | null): void {
  const host = container.parentElement;
  if (!(host instanceof HTMLElement)) return;
  const found = host.querySelector(":scope > .transcript-seam");
  const seam = found instanceof HTMLElement ? found : document.createElement("div");
  if (seam !== found) {
    seam.className = "transcript-seam";
    host.append(seam);
  }
  const bar = titleBar(container);
  if (!pinned || !bar) {
    seam.style.height = "0px";
    return;
  }
  const y1 = bar.getBoundingClientRect().bottom;
  const y2 = pinned.getBoundingClientRect().top;
  seam.style.top = `${y1 - host.getBoundingClientRect().top}px`;
  seam.style.height = `${Math.max(0, y2 - y1)}px`;
}

function appendTranscriptNode(container: HTMLElement, node: Node): void {
  const hold = scrollHoldOf(container);
  if (hold) container.insertBefore(node, hold);
  else container.append(node);
}

/** A user message starts a section. Later siblings stay in it, so the folded line can stick until the next user message. */
function placeTranscript(container: HTMLElement, node: HTMLElement, startsTurn: boolean): void {
  if (startsTurn) {
    const turn = el("div", { class: "turn" });
    turn.append(node);
    appendTranscriptNode(container, turn);
    return;
  }
  const hold = scrollHoldOf(container);
  const last = hold ? hold.previousElementSibling : container.lastElementChild;
  if (last instanceof HTMLElement && last.classList.contains("turn")) {
    last.append(node);
    return;
  }
  appendTranscriptNode(container, node);
}

export function removeLastTranscriptNodes(container: HTMLElement, count: number): void {
  for (let i = 0; i < count; i++) {
    const nodes = container.querySelectorAll(".msg");
    const last = nodes[nodes.length - 1];
    if (!(last instanceof HTMLElement)) return;
    const turn = last.closest(".turn");
    const time = last.nextElementSibling;
    if (time instanceof HTMLElement && time.classList.contains("msg-time")) time.remove();
    last.remove();
    if (turn instanceof HTMLElement && turn.parentElement === container && !turn.querySelector(".msg, .tool-group")) {
      turn.remove();
    }
  }
}

export function setToolDetailContent(node: HTMLElement, detail: string): void {
  node.innerHTML = linkifyPlainText(detail);
}

function isAskToolTitle(title: string): boolean {
  return title.startsWith("提问") || title.includes("ask_user");
}

/** A tool-only turn still leaves an assistant bubble. Visually that is a blank line, not a paragraph. */
function isBlankGap(node: Element | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.classList.contains("tool-step") || node.classList.contains("tool-group")) return false;
  if (node.querySelector("img")) return false;
  const body = node.querySelector(".msg-body");
  const text = (body ? body.textContent : node.textContent) ?? "";
  return text.trim().length === 0;
}

function hideGaps(nodes: HTMLElement[]): void {
  for (const node of nodes) node.classList.add("is-blank");
}

/** A grouped row stays a title. The body opens only when that row is clicked. */
function foldGroupedStep(step: HTMLElement): void {
  const details = step.querySelector(":scope > details");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

/**
 * Fold tool rows that sit together. Blank bubbles between them do not split the run.
 * A message with text does.
 */
function adoptToolGroup(wrap: HTMLElement): void {
  const parent = wrap.parentElement;
  if (!parent || wrap.classList.contains("tool-step-ask")) return;

  const hostGroup = parent.closest(".tool-group");
  if (hostGroup instanceof HTMLElement && hostGroup.contains(wrap)) {
    foldGroupedStep(wrap);
    refreshToolGroup(hostGroup);
    return;
  }

  const gaps: HTMLElement[] = [];
  const run: HTMLElement[] = [];
  let cursor: Element | null = wrap;
  let groupBefore: HTMLElement | null = null;
  while (cursor instanceof HTMLElement) {
    if (cursor.classList.contains("tool-step") && !cursor.classList.contains("tool-step-ask")) {
      run.push(cursor);
      cursor = cursor.previousElementSibling;
      continue;
    }
    if (cursor.classList.contains("msg-time")) {
      cursor = cursor.previousElementSibling;
      continue;
    }
    if (isBlankGap(cursor)) {
      gaps.push(cursor);
      cursor = cursor.previousElementSibling;
      continue;
    }
    if (cursor.classList.contains("tool-group") && !wrap.classList.contains("tool-step-nested")) {
      groupBefore = cursor;
    }
    break;
  }

  if (groupBefore) {
    const body = groupBefore.querySelector(":scope > .tool-group-body");
    if (body) {
      run.reverse();
      for (const node of run) {
        body.appendChild(node);
        foldGroupedStep(node);
      }
      hideGaps(gaps);
      refreshToolGroup(groupBefore);
    }
    return;
  }

  hideGaps(gaps);
  if (run.length < 2) return;
  run.reverse();
  const group = document.createElement("details");
  group.className = "tool-group";
  const summary = el("summary", { class: "tool-group-summary" });
  const body = el("div", { class: "tool-group-body" });
  group.append(summary, body);
  parent.insertBefore(group, run[0]!);
  for (const node of run) {
    body.appendChild(node);
    foldGroupedStep(node);
  }
  refreshToolGroup(group);
}

export function refreshToolGroup(group: Element | null): void {
  if (!(group instanceof HTMLElement) || !group.classList.contains("tool-group")) return;
  const count = group.querySelectorAll(":scope > .tool-group-body > .tool-step").length;
  const errors = group.querySelectorAll(":scope > .tool-group-body > .tool-step.is-error").length;
  const pending = group.querySelectorAll(
    ":scope > .tool-group-body > .tool-step.is-pending > details > .tool-summary",
  );
  const running = pending[pending.length - 1]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const summary = group.querySelector(":scope > .tool-group-summary");
  if (!summary) return;
  let text = `${count} 个工具`;
  if (running) text = count > 1 ? `${running} · 共 ${count} 个` : running;
  if (errors > 0) text += ` · ${errors} 个失败`;
  summary.textContent = text;
  group.classList.toggle("is-error", errors > 0);
}

export function appendToolStep(
  container: HTMLElement,
  opts: {
    title: string;
    detail?: string;
    open?: boolean;
    nested?: boolean;
    after?: HTMLElement;
    toolCallId?: string;
    parentToolCallId?: string;
    messageId?: string;
    error?: boolean;
  },
): HTMLElement {
  const wrap = el("div", {
    class: opts.nested ? "msg tool-step tool-step-nested" : "msg tool-step",
  });
  if (isAskToolTitle(opts.title)) wrap.classList.add("tool-step-ask");
  if (opts.error) wrap.classList.add("is-error");
  if (opts.open && opts.detail === "等待结果…") wrap.classList.add("is-pending");
  if (opts.messageId) wrap.dataset.messageId = opts.messageId;
  if (opts.toolCallId) wrap.dataset.toolCallId = opts.toolCallId;
  if (opts.parentToolCallId) wrap.dataset.parentToolCallId = opts.parentToolCallId;
  const details = document.createElement("details");
  if (opts.open) details.open = true;
  const summary = el("summary", { class: "tool-summary" }, opts.title);
  const body = el("div", { class: "tool-detail" });
  setToolDetailContent(body, opts.detail ?? "");
  details.append(summary, body);
  wrap.append(details);
  if (opts.after?.parentNode) opts.after.after(wrap);
  else placeTranscript(container, wrap, false);
  if (!wrap.classList.contains("tool-step-ask")) adoptToolGroup(wrap);
  return body;
}

const PERMISSION_CMD_PREVIEW = 2400;

function permissionCommandText(opts: { tool: string; summary: string; command?: string }): string {
  const command = opts.command?.trim() ?? "";
  const summary = opts.summary.replace(/^Needs confirmation:\s*/i, "").trim();
  const raw = command || summary || opts.tool;
  if (raw.length <= PERMISSION_CMD_PREVIEW) return raw;
  return `${raw.slice(0, PERMISSION_CMD_PREVIEW)}\n…（已截断，共 ${raw.length} 字符）`;
}

export function appendPermissionCard(
  container: HTMLElement,
  opts: {
    requestId: string;
    tool: string;
    summary: string;
    command?: string;
    once?: boolean;
    onAllow: () => void;
    onDeny: () => void;
    onStop: () => void;
  },
): HTMLElement {
  const card = el("div", { class: "permission-card", "data-request-id": opts.requestId });
  const title = el("div", { class: "permission-title" }, opts.once ? "需要确认这次 MCP 调用" : "需要确认才能执行");
  const hint = el(
    "p",
    { class: "permission-hint" },
    opts.once
      ? "只允许这一次调用。这一轮里的写操作、命令，以及其他 MCP 调用，仍会再问。停止会打断这一轮，但不会中止已经在后台运行的子代理。"
      : "允许后，这一轮剩下的写操作和命令不再逐条询问。停止会打断这一轮，但不会中止已经在后台运行的子代理。认得出的删盘根、格式化磁盘命令始终不执行。",
  );
  const body = el("pre", { class: "permission-body" }, permissionCommandText(opts));

  const actions = el("div", { class: "permission-actions" });
  const allowBtn = el("button", { type: "button", class: "perm-allow" }, opts.once ? "允许这一次" : "允许这一轮");
  allowBtn.setAttribute("aria-label", opts.once ? "只允许这一次 MCP 调用" : "允许这一轮剩下的写操作");
  const denyBtn = el("button", { type: "button", class: "perm-deny" }, "拒绝");
  const stopBtn = el("button", { type: "button", class: "perm-stop" }, "停止");
  const dismiss = () => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    stopBtn.disabled = true;
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
  stopBtn.onclick = () => {
    dismiss();
    opts.onStop();
  };
  actions.append(allowBtn, denyBtn, stopBtn);
  card.append(title, body, hint, actions);
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
  } else {
    box.innerHTML = `
      <h2 class="empty-title">提出好问题，才是真智慧</h2>
      <p class="empty-hint">人迷茫，不是因为不知道答案，而是不知道问题。</p>`;
  }
  container.appendChild(box);
}
