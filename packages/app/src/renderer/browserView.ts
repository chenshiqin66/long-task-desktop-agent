export interface TabInfo {
  id: string;
  pinned: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserState {
  tabs: TabInfo[];
  active: string;
}

export interface PaneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of `window.agent` that drives the workbench browser. */
export interface BrowserApi {
  browserShow(box: PaneBox): void;
  browserMove(box: PaneBox): void;
  browserHide(): void;
  browserSelect(id: string): void;
  browserNewTab(): void;
  browserOpenDeepseek(): void;
  browserCloseTab(id: string): void;
  browserBack(): void;
  browserForward(): void;
  browserReload(): void;
  browserGo(text: string): Promise<boolean>;
  onBrowserState(cb: (state: unknown) => void): () => void;
}

/** What a tab is called on its label: the pinned name, the page title, the host, then a placeholder. */
export function tabLabel(tab: TabInfo): string {
  if (tab.title) return tab.title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return "新标签页";
}

/**
 * The address bar is hidden until it is needed: while the active tab has no page yet, which is right after +.
 * Once an address is entered the tab has a page and the bar goes away again.
 */
export function addressBarShown(tab: TabInfo | undefined): boolean {
  return Boolean(tab) && tab?.url === "";
}

/** The main process sends this state. Anything that is not the expected shape is dropped. */
export function parseBrowserState(raw: unknown): BrowserState | null {
  if (!raw || typeof raw !== "object") return null;
  const { tabs, active } = raw as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(tabs) || typeof active !== "string") return null;
  const parsed: TabInfo[] = [];
  for (const item of tabs) {
    if (!item || typeof item !== "object") return null;
    const tab = item as Record<string, unknown>;
    if (
      typeof tab.id !== "string" ||
      typeof tab.pinned !== "boolean" ||
      typeof tab.url !== "string" ||
      typeof tab.title !== "string" ||
      typeof tab.loading !== "boolean" ||
      typeof tab.canGoBack !== "boolean" ||
      typeof tab.canGoForward !== "boolean"
    ) {
      return null;
    }
    parsed.push({
      id: tab.id,
      pinned: tab.pinned,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    });
  }
  if (!parsed.some((tab) => tab.id === active)) return null;
  return { tabs: parsed, active };
}

export interface BrowserView {
  show(): void;
  hide(): void;
}

/** How long to keep following after `show`: the workbench sheet slides up for 380 ms. */
const FOLLOW_MS = 700;

/**
 * The tab bar and the address bar are ordinary DOM. The page itself is a native view above the window, so the
 * DOM cannot hold it: `host` is an empty box that only marks where it goes. This sends that box's position,
 * and sends it again whenever the box moves: while the sheet slides, when the window resizes, when the
 * page zoom changes.
 */
export function mountBrowser(opts: {
  tabs: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  reload: HTMLButtonElement;
  host: HTMLElement;
  /** Shown over the empty host while the active tab has no page yet. */
  empty: HTMLElement;
  /** In the empty hint: opens the DeepSeek tab again. */
  deepseek: HTMLButtonElement;
  api: () => BrowserApi | undefined;
}): BrowserView {
  const { tabs: tabsEl, form, input, back, forward, reload, host, empty, deepseek, api } = opts;
  let state: BrowserState | null = null;
  let page = false;
  let lastKey = "";
  let frame = 0;
  let paintedActive = "";
  const observer = new ResizeObserver(() => push());

  function box(): PaneBox {
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function keyOf(b: PaneBox): string {
    return `${b.x}|${b.y}|${b.width}|${b.height}`;
  }

  function push(): void {
    if (!page) return;
    const next = box();
    const key = keyOf(next);
    if (key === lastKey) return;
    lastKey = key;
    api()?.browserMove(next);
  }

  function follow(): void {
    cancelAnimationFrame(frame);
    const until = performance.now() + FOLLOW_MS;
    const step = (): void => {
      push();
      if (page && performance.now() < until) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function activeTab(): TabInfo | undefined {
    return state?.tabs.find((tab) => tab.id === state?.active);
  }

  function paintTabs(): void {
    tabsEl.replaceChildren();
    for (const tab of state?.tabs ?? []) {
      const selected = tab.id === state?.active;
      const item = document.createElement("div");
      item.className = "browser-tab";
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.classList.toggle("is-active", selected);
      item.classList.toggle("is-loading", tab.loading);

      const label = document.createElement("button");
      label.type = "button";
      label.className = "browser-tab-label";
      label.dataset.tab = tab.id;
      label.textContent = tabLabel(tab);
      label.title = tab.url || label.textContent;
      item.append(label);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "browser-tab-close";
      close.dataset.tabClose = tab.id;
      close.setAttribute("aria-label", `关闭 ${label.textContent}`);
      close.innerHTML =
        '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 1.6 8.4 8.4M8.4 1.6 1.6 8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      item.append(close);
      tabsEl.append(item);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "browser-tab-new library-add";
    add.dataset.tabNew = "1";
    add.setAttribute("aria-label", "新建标签页");
    add.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    tabsEl.append(add);
  }

  /** The address bar shows the page's address, unless the user is typing in it. */
  function syncAddress(): void {
    const tab = activeTab();
    input.value = tab?.url ?? "";
    input.removeAttribute("aria-invalid");
  }

  function paintBar(): void {
    const tab = activeTab();
    back.disabled = !tab?.canGoBack;
    forward.disabled = !tab?.canGoForward;
    reload.disabled = !tab?.url;
    const asking = addressBarShown(tab);
    empty.hidden = !asking;
    // The way back to DeepSeek is only offered while its tab is closed.
    deepseek.hidden = Boolean(state?.tabs.some((item) => item.pinned));
    form.hidden = !asking;
    const changedTab = (tab?.id ?? "") !== paintedActive;
    paintedActive = tab?.id ?? "";
    if (changedTab || document.activeElement !== input) syncAddress();
    // The bar only exists after +, so the cursor goes straight into it.
    if (changedTab && asking) input.focus();
  }

  function paint(): void {
    paintTabs();
    paintBar();
  }

  api()?.onBrowserState((raw) => {
    const next = parseBrowserState(raw);
    if (!next) return;
    state = next;
    paint();
  });

  tabsEl.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const close = target?.closest<HTMLElement>("[data-tab-close]");
    if (close?.dataset.tabClose) {
      api()?.browserCloseTab(close.dataset.tabClose);
      return;
    }
    const tab = target?.closest<HTMLElement>("[data-tab]");
    if (tab?.dataset.tab) {
      api()?.browserSelect(tab.dataset.tab);
      return;
    }
    if (target?.closest("[data-tab-new]")) api()?.browserNewTab();
  });

  back.addEventListener("click", () => api()?.browserBack());
  forward.addEventListener("click", () => api()?.browserForward());
  reload.addEventListener("click", () => api()?.browserReload());
  deepseek.addEventListener("click", () => api()?.browserOpenDeepseek());

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void api()
      ?.browserGo(input.value)
      .then((ok) => {
        if (ok) input.blur();
        else input.setAttribute("aria-invalid", "true");
      });
  });
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", syncAddress);
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.isComposing) return;
    // Esc here only cancels the edit. It must not reach the handler that closes the workbench.
    ev.preventDefault();
    syncAddress();
    input.blur();
  });

  window.addEventListener("resize", push);

  return {
    show(): void {
      page = true;
      const first = box();
      lastKey = keyOf(first);
      api()?.browserShow(first);
      observer.observe(host);
      follow();
    },
    hide(): void {
      if (!page) return;
      page = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      api()?.browserHide();
    },
  };
}
