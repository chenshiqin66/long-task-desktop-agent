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

function place(tip: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
  let top = r.top - t.height - 7;
  if (top < 6) top = r.bottom + 7;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
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
    // The chat composer deliberately has no hover toast.
    if (el.closest("#composer")) return;
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
