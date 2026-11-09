/** Main-conversation question rail. Collapsed ticks, titles on hover. */

const TITLE_CHARS = 12;
const TIP_CHARS = 80;

export function questionTitle(text: string, limit = TITLE_CHARS): { label: string; full: string } {
  const full = text.replace(/\s+/g, " ").trim();
  const chars = graphemes(full);
  if (chars.length <= limit) return { label: full, full };
  return { label: `${chars.slice(0, limit).join("").trimEnd()}...`, full };
}

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
}

function tip(full: string, label: string): string {
  if (!full || full === label) return "";
  const chars = graphemes(full);
  if (chars.length <= TIP_CHARS) return full;
  return `${chars.slice(0, TIP_CHARS).join("")}…`;
}

type Item = { el: HTMLElement; btn: HTMLButtonElement; label: string; fingerprint: string };

function fingerprint(el: HTMLElement): string {
  const text = el.querySelector(":scope > .msg-body")?.textContent ?? "";
  const images = el.querySelectorAll(":scope > .msg-images img").length;
  return `${images}\n${text}`;
}

function describe(el: HTMLElement): { label: string; full: string } | null {
  const text = el.querySelector(":scope > .msg-body")?.textContent ?? "";
  const images = el.querySelectorAll(":scope > .msg-images img").length;
  const titled = questionTitle(text);
  if (!titled.full && images === 0) return null;
  if (!titled.full) return { label: "（图片）", full: "（图片）" };
  return titled;
}

export function mountQuestionNav(nav: HTMLElement, messages: HTMLElement): void {
  const card = document.createElement("div");
  card.className = "question-nav-card";
  card.setAttribute("role", "list");
  const hit = document.createElement("div");
  hit.className = "question-nav-hit";
  hit.setAttribute("aria-hidden", "true");
  nav.append(card, hit);
  nav.tabIndex = -1;

  let items: Item[] = [];
  let open = false;
  let current = 0;
  let overNav = false;
  let closeTimer = 0;
  let frame = 0;
  let laying = false;

  const userNodes = (): HTMLElement[] =>
    Array.from(messages.querySelectorAll(":scope > .turn > .msg.user, :scope > .msg.user")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );

  function scheduleClose(): void {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      const focusInside = nav.contains(document.activeElement);
      if (!overNav && !focusInside) close();
    }, 160);
  }

  function cancelClose(): void {
    window.clearTimeout(closeTimer);
  }

  function syncRailBox(): void {
    const pad = parseFloat(messages.style.paddingBottom || "0");
    nav.style.bottom = `${Number.isFinite(pad) ? Math.max(8, pad - 4) : 8}px`;
  }

  /** Same row pitch either way. Hover only reveals labels; it must not move ticks. */
  function layoutCard(): void {
    const railH = nav.clientHeight;
    if (railH <= 0) return;
    const held = card.scrollTop;
    card.style.height = "auto";
    card.style.maxHeight = `${railH}px`;
    const cardH = Math.min(card.scrollHeight, railH);
    card.style.top = `${Math.max(0, (railH - cardH) / 2)}px`;
    card.scrollTop = held;
  }

  function relayout(): void {
    if (laying) return;
    laying = true;
    syncRailBox();
    if (!nav.hidden && nav.clientHeight > 0) layoutCard();
    laying = false;
  }

  function setOpen(next: boolean): void {
    open = next;
    nav.classList.toggle("is-open", open);
    nav.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function close(): void {
    if (!open) return;
    setOpen(false);
  }

  function markCurrent(): void {
    if (!items.length) return;
    const box = messages.getBoundingClientRect();
    const line = box.top + Math.min(88, box.height * 0.22);
    let next = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.el.getBoundingClientRect().top <= line + 1) next = i;
    }
    const nearTail = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
    const lastBox = items[items.length - 1]!.el.getBoundingClientRect();
    if (nearTail && lastBox.top < box.bottom - 16 && lastBox.bottom > box.top) next = items.length - 1;
    current = next;
    items.forEach((item, index) => {
      const on = index === current;
      item.btn.classList.toggle("is-current", on);
      if (on) item.btn.setAttribute("aria-current", "true");
      else item.btn.removeAttribute("aria-current");
    });
    if (!overNav) {
      const btn = items[current]?.btn;
      if (!btn) return;
      const top = btn.offsetTop;
      const bottom = top + btn.offsetHeight;
      if (top < card.scrollTop) card.scrollTop = top;
      else if (bottom > card.scrollTop + card.clientHeight) card.scrollTop = bottom - card.clientHeight;
    }
  }

  function scrollTo(index: number): void {
    const item = items[index];
    if (!item) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    item.el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }

  function indexAt(clientY: number): number {
    if (!items.length) return 0;
    let best = 0;
    let bestDist = Infinity;
    items.forEach((item, index) => {
      const box = item.btn.getBoundingClientRect();
      const dist = Math.abs(clientY - (box.top + box.bottom) / 2);
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    });
    return best;
  }

  function rebuild(): void {
    const nodes = userNodes();
    const described = nodes.map((el) => ({ el, title: describe(el), fingerprint: fingerprint(el) }));
    const visible = described.filter((row): row is { el: HTMLElement; title: { label: string; full: string }; fingerprint: string } => row.title !== null);
    const unchanged =
      visible.length === items.length &&
      visible.every((row, index) => row.el === items[index]?.el && row.fingerprint === items[index]?.fingerprint);
    if (unchanged) {
      markCurrent();
      return;
    }
    card.replaceChildren();
    items = visible.map((row) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "question-nav-item";
      btn.tabIndex = -1;
      btn.setAttribute("role", "listitem");
      btn.setAttribute("aria-label", row.title.full);
      const hover = tip(row.title.full, row.title.label);
      if (hover) btn.title = hover;
      const label = document.createElement("span");
      label.className = "question-nav-label";
      label.setAttribute("aria-hidden", "true");
      label.textContent = row.title.label;
      const tick = document.createElement("span");
      tick.className = "question-nav-tick";
      tick.setAttribute("aria-hidden", "true");
      btn.append(label, tick);
      btn.addEventListener("click", () => {
        const index = items.findIndex((item) => item.btn === btn);
        scrollTo(index);
      });
      card.append(btn);
      return { el: row.el, btn, label: row.title.label, fingerprint: row.fingerprint };
    });
    const show = items.length > 0;
    nav.hidden = !show;
    nav.tabIndex = show ? 0 : -1;
    if (!show) {
      open = false;
      nav.classList.remove("is-open");
      nav.setAttribute("aria-expanded", "false");
      return;
    }
    requestAnimationFrame(() => {
      relayout();
      markCurrent();
    });
  }

  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      rebuild();
    });
  }

  nav.addEventListener("mouseenter", (ev) => {
    overNav = true;
    cancelClose();
    if (!open) setOpen(true);
  });
  nav.addEventListener("mouseleave", () => {
    overNav = false;
    scheduleClose();
  });
  nav.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Node) || (target instanceof Element && target.closest(".question-nav-item"))) return;
    if (open) return;
    scrollTo(indexAt(ev.clientY));
  });

  nav.addEventListener(
    "wheel",
    (ev) => {
      const onCard = ev.target instanceof Node && (ev.target === card || card.contains(ev.target));
      if (open && onCard && card.scrollHeight > card.clientHeight + 1) return;
      messages.scrollTop += ev.deltaY;
      ev.preventDefault();
    },
    { passive: false },
  );

  nav.addEventListener("focusin", () => {
    cancelClose();
    if (!open && items.length) setOpen(true);
  });
  nav.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (!nav.contains(document.activeElement)) scheduleClose();
    });
  });
  nav.addEventListener("keydown", (ev) => {
    if (!items.length) return;
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End" && ev.key !== "Enter") return;
    if (ev.key === "Enter" && ev.target !== nav) return;
    ev.preventDefault();
    let next = current;
    if (ev.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
    else if (ev.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = items.length - 1;
    else next = current;
    setOpen(true);
    items[next]?.btn.focus();
    scrollTo(next);
  });

  messages.addEventListener("scroll", () => markCurrent(), { passive: true });
  window.addEventListener("resize", () => relayout());
  new ResizeObserver(() => relayout()).observe(nav);
  const stack = document.querySelector(".float-stack");
  if (stack instanceof HTMLElement) new ResizeObserver(() => relayout()).observe(stack);
  new MutationObserver(() => schedule()).observe(messages, { childList: true });
  nav.setAttribute("aria-expanded", "false");
  rebuild();
}
