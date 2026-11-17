export interface Workbench {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

const CLOSE_MS = 220;

/**
 * One button stays in the sidebar slot and paints above the sheet, so the slide
 * never covers it or swaps in a second copy.
 */
function pinWorkbenchButton(button: HTMLButtonElement, sheetSpace: HTMLElement): void {
  const slot = document.createElement("div");
  slot.className = "workbench-slot";
  slot.setAttribute("aria-hidden", "true");
  const height = button.offsetHeight;
  button.replaceWith(slot);
  slot.style.height = `${height}px`;
  sheetSpace.style.height = `${height}px`;
  document.body.append(button);
  button.classList.add("is-pinned");

  const place = (): void => {
    const height = button.offsetHeight;
    slot.style.height = `${height}px`;
    slot.style.width = "100%";
    sheetSpace.style.height = `${height}px`;
    const foot = slot.parentElement;
    const row = foot?.querySelector(".sidebar-tools");
    if (row instanceof HTMLElement) row.style.width = "100%";
    const slotRect = slot.getBoundingClientRect();
    const footRect = foot?.getBoundingClientRect();
    const rect = slotRect.width > 0 ? slotRect : (footRect ?? slotRect);
    button.style.left = `${rect.left}px`;
    button.style.top = `${rect.top}px`;
    button.style.width = `${rect.width}px`;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(slot);
  observer.observe(button);
  window.addEventListener("resize", place);

  // side-in translates #sidebar by -12px and app-in drops #app by 8px.
  // ResizeObserver does not see a transform, so one sample during those
  // animations leaves the button 12px left of 连接/技能/模型.
  const watchUntil = performance.now() + 800;
  const follow = (): void => {
    place();
    if (performance.now() < watchUntil) requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
  const onEnter = (ev: AnimationEvent): void => {
    if (ev.animationName !== "app-in" && ev.animationName !== "side-in") return;
    requestAnimationFrame(place);
  };
  document.getElementById("app")?.addEventListener("animationend", onEnter);
  document.getElementById("sidebar")?.addEventListener("animationend", onEnter);
}

/** Full-window sheet. The left column is the menu; the right column is the page for the current item. */
export function mountWorkbench(
  openButton: HTMLButtonElement,
  sheet: HTMLElement,
  closeBtn: HTMLButtonElement,
  onOpen: () => void,
): Workbench {
  let open = false;
  let closing = false;
  let restore: HTMLElement | null = null;
  let closeTimer = 0;

  const app = document.getElementById("app");
  const sheetSpace = document.getElementById("workbench-foot-space");
  if (sheetSpace) pinWorkbenchButton(openButton, sheetSpace);

  function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function paintOpen(next: boolean): void {
    openButton.classList.toggle("is-current", next);
    openButton.setAttribute("aria-pressed", next ? "true" : "false");
    openButton.setAttribute("aria-expanded", next ? "true" : "false");
  }

  function finishClose(): void {
    if (!closing) return;
    closing = false;
    window.clearTimeout(closeTimer);
    sheet.removeEventListener("animationend", onCloseAnimationEnd);
    sheet.hidden = true;
    sheet.classList.remove("is-closing");
    app?.removeAttribute("inert");
    if (restore?.isConnected) restore.focus();
    restore = null;
  }

  function onCloseAnimationEnd(ev: AnimationEvent): void {
    if (ev.target !== sheet || ev.animationName !== "workbench-down") return;
    finishClose();
  }

  function setOpen(next: boolean): void {
    if (next) {
      if (open && !closing) return;
      window.clearTimeout(closeTimer);
      sheet.removeEventListener("animationend", onCloseAnimationEnd);
      closing = false;
      sheet.classList.remove("is-closing");
      open = true;
      sheet.hidden = false;
      app?.setAttribute("inert", "");
      paintOpen(true);
      restore = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
      onOpen();
      return;
    }
    if (!open || closing) return;
    open = false;
    closing = true;
    paintOpen(false);
    if (prefersReducedMotion()) {
      finishClose();
      return;
    }
    sheet.classList.add("is-closing");
    sheet.addEventListener("animationend", onCloseAnimationEnd);
    closeTimer = window.setTimeout(finishClose, CLOSE_MS + 80);
  }

  openButton.addEventListener("click", () => setOpen(!(open && !closing)));
  closeBtn.addEventListener("click", () => setOpen(false));

  return {
    isOpen: () => open || closing,
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}

export type WorkbenchPage = "folders";

export interface WorkbenchNav {
  current(): WorkbenchPage;
  /** Switches without loading, for a caller that opens the sheet next. */
  select(page: WorkbenchPage): void;
  show(page: WorkbenchPage): void;
}

/** Menu buttons carry data-page. Parts of the stage carry data-workbench-page and show only on that page. */
export function mountWorkbenchNav(opts: {
  nav: HTMLElement;
  stage: HTMLElement;
  title: HTMLElement;
  onShow(page: WorkbenchPage): void;
}): WorkbenchNav {
  let page: WorkbenchPage = "folders";
  const buttons = Array.from(opts.nav.querySelectorAll<HTMLButtonElement>("button[data-page]"));

  function select(next: WorkbenchPage): void {
    page = next;
    buttons.forEach((button) => {
      if (button.dataset.page === next) {
        button.setAttribute("aria-current", "page");
        opts.title.textContent = button.textContent;
      } else {
        button.removeAttribute("aria-current");
      }
    });
    opts.stage.querySelectorAll<HTMLElement>("[data-workbench-page]").forEach((part) => {
      part.hidden = part.dataset.workbenchPage !== next;
    });
  }

  function show(next: WorkbenchPage): void {
    select(next);
    opts.onShow(next);
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => show("folders"));
  });
  return { current: () => page, select, show };
}

function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Right-hand page for the workbench's first menu item. */
export function mountFavoriteFolders(
  view: HTMLElement,
  addBtn: HTMLButtonElement,
  note: HTMLElement,
): { reload(): Promise<void> } {
  let folders: string[] = [];
  let busy = false;
  let dragFrom = -1;
  let suppressClick = false;

  function swallowNextClick(): void {
    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 80);
  }

  function setNote(text: string, tone: "danger" | "muted" = "danger"): void {
    note.hidden = !text;
    note.textContent = text;
    note.classList.toggle("folder-note-muted", tone === "muted" && Boolean(text));
  }

  function persistOrder(next: string[]): void {
    busy = true;
    void window.agent
      .reorderFavoriteFolders(next)
      .then((saved) => {
        folders = saved;
        setNote("");
        paint();
      })
      .catch((err: unknown) => {
        setNote(err instanceof Error ? err.message : "没能保存顺序");
        void reload();
      })
      .finally(() => {
        busy = false;
      });
  }

  function paint(): void {
    view.replaceChildren();
    if (folders.length === 0) {
      const empty = document.createElement("p");
      empty.className = "folder-empty";
      empty.textContent = "还没有文件夹。添加后，单击会在资源管理器里打开。";
      view.append(empty);
      return;
    }
    const list = document.createElement("div");
    list.className = "folder-list";
    folders.forEach((path, index) => {
      const row = document.createElement("div");
      row.className = "folder-row";
      row.draggable = true;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "folder-open";
      const name = document.createElement("span");
      name.className = "folder-name";
      name.textContent = folderLabel(path);
      const where = document.createElement("span");
      where.className = "folder-path";
      where.textContent = path;
      open.append(name, where);
      open.addEventListener("click", () => {
        if (suppressClick) return;
        void window.agent.openExternal(path).then((res) => {
          setNote(res.ok ? "" : res.error || "打不开这个文件夹");
        });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "folder-remove";
      remove.textContent = "−";
      remove.setAttribute("aria-label", `移除 ${folderLabel(path)}`);
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (busy) return;
        busy = true;
        void window.agent
          .removeFavoriteFolder(path)
          .then((next) => {
            folders = next;
            setNote("");
            paint();
          })
          .catch((err: unknown) => {
            setNote(err instanceof Error ? err.message : "移除失败");
          })
          .finally(() => {
            busy = false;
          });
      });
      row.addEventListener("dragstart", (ev) => {
        if (ev.target instanceof Element && ev.target.closest(".folder-remove")) {
          ev.preventDefault();
          return;
        }
        dragFrom = index;
        row.classList.add("is-dragging");
        ev.dataTransfer?.setData("text/plain", path);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("is-dragging");
        dragFrom = -1;
        swallowNextClick();
      });
      row.addEventListener("dragover", (ev) => {
        if (dragFrom < 0 || dragFrom === index) return;
        ev.preventDefault();
        row.classList.add("is-drop");
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        row.classList.remove("is-drop");
        if (dragFrom < 0 || dragFrom === index || busy) return;
        swallowNextClick();
        const next = folders.slice();
        const [moved] = next.splice(dragFrom, 1);
        if (!moved) return;
        next.splice(index, 0, moved);
        dragFrom = -1;
        folders = next;
        paint();
        persistOrder(next);
      });
      row.append(open, remove);
      list.append(row);
    });
    view.append(list);
  }

  async function reload(): Promise<void> {
    const cfg = await window.agent.getConfig();
    const raw = cfg?.favoriteFolders;
    folders = Array.isArray(raw) ? raw.filter((item: unknown): item is string => typeof item === "string") : [];
    paint();
  }

  addBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    addBtn.disabled = true;
    setNote("");
    void window.agent
      .addFavoriteFolder()
      .then((next) => {
        if (next) {
          const added = next.length > folders.length;
          folders = next;
          setNote(added ? "" : "这个文件夹已经在列表里", "muted");
          paint();
        }
      })
      .catch((err: unknown) => {
        setNote(err instanceof Error ? err.message : "添加失败");
      })
      .finally(() => {
        busy = false;
        addBtn.disabled = false;
      });
  });

  return { reload };
}
