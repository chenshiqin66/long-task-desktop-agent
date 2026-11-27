/**
 * Native `title` renders the browser's slow yellow tooltip. Mirror every
 * `title` into `data-tip`, remove `title` so the native one never shows, and
 * draw a single shared dark-pill tooltip from `data-tip`. A JS-driven element
 * (rather than a ::after rule) avoids clashing with elements that already use
 * ::after — e.g. the view tabs' file-state rule.
 *
 * `title` is cleared rather than kept: callers that need the text back read
 * `data-tip` instead.
 */

const TIP = "data-tip";

/** Anchors that must not raise the shared dark-pill toast. */
export const TOOLTIP_SUPPRESS = ["#composer", ".store-tab"] as const;

export function shouldSuppressTooltip(el: { closest(selector: string): unknown }): boolean {
  return TOOLTIP_SUPPRESS.some((sel) => Boolean(el.closest(sel)));
}

function mirror(el: HTMLElement): void {
  if (!el.hasAttribute("title")) return;
  const value = el.getAttribute("title") ?? "";
  if (value) el.setAttribute(TIP, value);
  else el.removeAttribute(TIP);
  el.removeAttribute("title");
}

function scan(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[title]").forEach(mirror);
  if (root instanceof HTMLElement && root.hasAttribute("title")) mirror(root);
}

type Box = { left: number; top: number; width: number; height: number };

const MARGIN = 6;
const GAP = 7;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

/**
 * `.workbench-web` only marks where a native BrowserView is laid. That view is
 * composited above the renderer, so a CSS z-index cannot lift a tooltip over
 * the page. These boxes are treated as walls the tooltip must not cover.
 */
function occluders(): Box[] {
  const boxes: Box[] = [];
  document.querySelectorAll<HTMLElement>(".workbench-web").forEach((el) => {
    if (el.closest("[hidden]")) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    boxes.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  });
  return boxes;
}

function onScreen(box: Box): boolean {
  return (
    box.left >= MARGIN &&
    box.top >= MARGIN &&
    box.left + box.width <= window.innerWidth - MARGIN &&
    box.top + box.height <= window.innerHeight - MARGIN
  );
}

function clearOfWalls(box: Box, walls: Box[]): boolean {
  return walls.every((wall) => !intersects(box, wall));
}

function place(tip: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const width = t.width;
  const height = t.height;
  const walls = occluders();
  const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  const midLeft = clamp(r.left + r.width / 2 - width / 2, MARGIN, maxLeft);
  const midTop = clamp(r.top + r.height / 2 - height / 2, MARGIN, maxTop);

  const candidates: Box[] = [
    { left: midLeft, top: r.top - height - GAP, width, height },
    { left: midLeft, top: r.bottom + GAP, width, height },
    { left: r.left - width - GAP, top: midTop, width, height },
    { left: r.right + GAP, top: midTop, width, height },
  ];

  let chosen = candidates.find((box) => onScreen(box) && clearOfWalls(box, walls));
  if (!chosen) {
    const clamped = candidates.map((box) => ({
      ...box,
      left: clamp(box.left, MARGIN, maxLeft),
      top: clamp(box.top, MARGIN, maxTop),
    }));
    chosen = clamped.find((box) => clearOfWalls(box, walls)) ?? clamped[0]!;
  }

  tip.style.left = `${Math.round(chosen.left)}px`;
  tip.style.top = `${Math.round(chosen.top)}px`;
}

export function installTooltips(): void {
  scan(document);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        if (record.attributeName === "title") mirror(record.target);
        continue;
      }
      if (record.type === "childList") {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.querySelectorAll<HTMLElement>("[title]").forEach(mirror);
          if (node.hasAttribute("title")) mirror(node);
        });
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title"],
  });

  const tip = document.createElement("div");
  tip.className = "app-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);

  let anchor: HTMLElement | null = null;

  const hide = () => {
    anchor = null;
    tip.hidden = true;
  };
  const show = (el: HTMLElement) => {
    if (shouldSuppressTooltip(el)) return;
    const text = el.getAttribute(TIP);
    if (!text) return;
    anchor = el;
    tip.textContent = text;
    tip.hidden = false;
    place(tip, el);
  };

  document.addEventListener("mouseover", (ev) => {
    const el = (ev.target as Element | null)?.closest?.(`[${TIP}]`);
    if (el instanceof HTMLElement) show(el);
  });
  document.addEventListener("mouseout", (ev) => {
    const el = (ev.target as Element | null)?.closest?.(`[${TIP}]`);
    const to = ev.relatedTarget as Node | null;
    if (el instanceof HTMLElement && el === anchor && !el.contains(to)) hide();
  });
  document.addEventListener("focusin", (ev) => {
    if (ev.target instanceof HTMLElement && ev.target.hasAttribute(TIP)) show(ev.target);
  });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", () => anchor && place(tip, anchor), true);
  window.addEventListener("resize", () => anchor && place(tip, anchor));
}
