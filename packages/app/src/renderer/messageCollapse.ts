/** Long transcript bubbles fold to five typography lines until the user clicks them. */

export const MESSAGE_COLLAPSE_LINES = 5;

export function collapsedMaxHeight(opts: {
  lineHeight: number;
  paddingY?: number;
  borderY?: number;
  boxSizing?: "border-box" | "content-box";
  lines?: number;
}): number {
  const content = opts.lineHeight * (opts.lines ?? MESSAGE_COLLAPSE_LINES);
  if (opts.boxSizing === "content-box") return content;
  return content + (opts.paddingY ?? 0) + (opts.borderY ?? 0);
}

export function shouldCollapseMessage(contentHeight: number, maxHeight: number): boolean {
  return contentHeight > maxHeight + 1;
}

const INTERACTIVE = "a, button, video, audio, input, textarea, select, label, .msg-image-btn";

export function isCollapseInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE));
}

export function shouldToggleMessageCollapse(opts: {
  long: boolean;
  stuck: boolean;
  interactive: boolean;
  selecting: boolean;
}): boolean {
  return opts.long && !opts.stuck && !opts.interactive && !opts.selecting;
}

function transcriptBody(node: HTMLElement): HTMLElement | null {
  const msg = node.closest(".msg");
  if (!(msg instanceof HTMLElement)) return null;
  if (!msg.classList.contains("user") && !msg.classList.contains("assistant")) return null;
  if (msg.classList.contains("notice")) return null;
  const body = node.classList.contains("msg-body") ? node : msg.querySelector(":scope > .msg-body");
  return body instanceof HTMLElement ? body : null;
}

function isStuck(body: HTMLElement): boolean {
  return Boolean(body.closest(".msg.is-stuck"));
}

function selectionIn(body: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.toString()) return false;
  return body.contains(range.commonAncestorContainer);
}

function measureMaxHeight(body: HTMLElement): number | null {
  const style = getComputedStyle(body);
  const line = parseFloat(style.lineHeight);
  if (!Number.isFinite(line) || line <= 0) return null;
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const boxSizing = style.boxSizing === "content-box" ? "content-box" : "border-box";
  return collapsedMaxHeight({
    lineHeight: line,
    paddingY: Number.isFinite(pad) ? pad : 0,
    borderY: Number.isFinite(border) ? border : 0,
    boxSizing,
  });
}

const bound = new WeakSet<HTMLElement>();
const press = new WeakMap<HTMLElement, { x: number; y: number }>();
const fitTimers = new WeakMap<HTMLElement, number>();
const mutateAt = new WeakMap<HTMLElement, number>();
const pendingFrame = new WeakSet<HTMLElement>();

function syncChrome(body: HTMLElement, long: boolean, expanded: boolean): void {
  if (!long) {
    body.removeAttribute("title");
    return;
  }
  body.title = expanded ? "点击收起" : "点击展开";
}

export function fitMessageCollapse(body: HTMLElement): void {
  const target = transcriptBody(body);
  if (!target) return;
  // Leave classes alone while the sticky one-line fold is active; measuring nowrap would look short.
  if (isStuck(target)) return;
  const quietAt = mutateAt.get(target) ?? 0;
  if (Date.now() - quietAt < 180) {
    scheduleMessageCollapse(target, 200);
    return;
  }
  const max = measureMaxHeight(target);
  if (max == null) return;
  if (target.clientHeight === 0 && target.scrollHeight === 0) {
    // Detached history holders have no layout yet; ResizeObserver will fit them once mounted.
    if (!target.isConnected) return;
    if (pendingFrame.has(target)) return;
    pendingFrame.add(target);
    requestAnimationFrame(() => {
      pendingFrame.delete(target);
      fitMessageCollapse(target);
    });
    return;
  }
  target.style.setProperty("--msg-clamp-height", `${max}px`);
  const expanded = target.classList.contains("is-expanded");
  const long = shouldCollapseMessage(target.scrollHeight, max);
  target.classList.toggle("is-long", long);
  target.classList.toggle("is-collapsed", long && !expanded);
  if (!long) target.classList.remove("is-expanded");
  syncChrome(target, long, long && expanded);
}

export function scheduleMessageCollapse(body: HTMLElement, delayMs = 0): void {
  const target = transcriptBody(body);
  if (!target) return;
  const prev = fitTimers.get(target);
  if (prev) window.clearTimeout(prev);
  if (delayMs <= 0) {
    fitTimers.delete(target);
    fitMessageCollapse(target);
    return;
  }
  fitTimers.set(
    target,
    window.setTimeout(() => {
      fitTimers.delete(target);
      fitMessageCollapse(target);
    }, delayMs),
  );
}

export function refreshMessageCollapse(node: HTMLElement): void {
  const target = transcriptBody(node);
  if (!target) return;
  if (!bound.has(target)) return;
  mutateAt.set(target, Date.now());
  scheduleMessageCollapse(target, 200);
}

function onClick(ev: MouseEvent): void {
  const body = ev.currentTarget;
  if (!(body instanceof HTMLElement)) return;
  if (isCollapseInteractiveTarget(ev.target)) return;
  const start = press.get(body);
  if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) return;
  if (!shouldToggleMessageCollapse({
    long: body.classList.contains("is-long"),
    stuck: isStuck(body),
    interactive: false,
    selecting: selectionIn(body),
  })) return;
  const expanded = body.classList.toggle("is-expanded");
  body.classList.toggle("is-collapsed", !expanded);
  syncChrome(body, true, expanded);
}

function onPointerDown(ev: PointerEvent): void {
  const body = ev.currentTarget;
  if (!(body instanceof HTMLElement)) return;
  press.set(body, { x: ev.clientX, y: ev.clientY });
}

let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;

function observeCollapse(target: HTMLElement): void {
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target;
        if (!(node instanceof HTMLElement)) continue;
        const quietAt = mutateAt.get(node) ?? 0;
        // Growing stream text also resizes the box; wait until the text settles before folding.
        if (Date.now() - quietAt < 180) scheduleMessageCollapse(node, 200);
        else scheduleMessageCollapse(node, 0);
      }
    });
  }
  if (!mutationObserver) {
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const el = node instanceof HTMLElement ? node : node.parentElement;
        if (!(el instanceof HTMLElement)) continue;
        const body = transcriptBody(el);
        if (!body || !bound.has(body)) continue;
        mutateAt.set(body, Date.now());
        scheduleMessageCollapse(body, 200);
      }
    });
  }
  resizeObserver.observe(target);
  mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
}

/** Watch a user/assistant bubble and fold it to five lines when the text is long. */
export function bindMessageCollapse(body: HTMLElement): void {
  const target = transcriptBody(body);
  if (!target) return;
  if (!bound.has(target)) {
    bound.add(target);
    target.addEventListener("click", onClick);
    target.addEventListener("pointerdown", onPointerDown);
    observeCollapse(target);
  }
  scheduleMessageCollapse(target, 0);
}