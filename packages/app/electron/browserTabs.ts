import { app, session, WebContentsView } from "electron";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  MAX_TABS,
  PINNED,
  SHARED_PARTITION,
  inPinnedSite,
  normalizeAddress,
  pageUserAgent,
  paneBounds,
  webUrl,
  type PaneRect,
} from "./browserPolicy.js";

export interface TabInfo {
  id: string;
  pinned: boolean;
  /** Empty until the tab loads its first page. */
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

interface Tab {
  id: string;
  pinned: boolean;
  /** Made on the first navigation. A new empty tab has none, so it costs no process. */
  view: WebContentsView | null;
  url: string;
  title: string;
  loading: boolean;
  /** The last main-frame load failed. The pinned tab tries again the next time it is shown. */
  failed: boolean;
}

/** Permissions a page may use. Everything else (camera, microphone, location, ...) is refused. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

const guardedPartitions = new Set<string>();

function guardPartition(partition: string) {
  const ses = session.fromPartition(partition);
  if (!guardedPartitions.has(partition)) {
    guardedPartitions.add(partition);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  }
  return ses;
}

/**
 * Tabs shown in the workbench. Each page is its own native view with no preload and no Node, so it
 * can reach neither `window.agent` nor the app's own UI. This class owns the tab list. The renderer
 * sends commands (open, switch, close, go) and gets the state back, and it never picks a view itself.
 */
export class BrowserTabs {
  private readonly tabs: Tab[] = [];
  private active: string = PINNED.id;
  private shown = false;
  private bounds: PaneRect | null = null;
  private serial = 1;

  constructor(
    private readonly getWin: () => BrowserWindow | null,
    private readonly publish: (state: BrowserState) => void,
  ) {
    this.tabs.push({ id: PINNED.id, pinned: true, view: null, url: PINNED.url, title: PINNED.title, loading: false, failed: false });
  }

  state(): BrowserState {
    return {
      active: this.active,
      tabs: this.tabs.map((tab) => {
        const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
        return {
          id: tab.id,
          pinned: tab.pinned,
          url: tab.url,
          title: tab.title,
          loading: tab.loading,
          canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
          canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
        };
      }),
    };
  }

  /** The workbench opened the browser page. `rawBox` is where the page goes. */
  show(rawBox: unknown): void {
    const win = this.getWin();
    if (!win || win.isDestroyed()) return;
    const bounds = paneBounds(rawBox, win.webContents.getZoomFactor());
    if (!bounds) return;
    this.bounds = bounds;
    this.shown = true;
    const tab = this.current();
    if (tab.pinned && (!tab.view || tab.failed)) this.load(tab, PINNED.url);
    this.layout();
    this.changed();
  }

  setBounds(rawBox: unknown): void {
    const win = this.getWin();
    if (!win || win.isDestroyed() || !this.shown) return;
    const bounds = paneBounds(rawBox, win.webContents.getZoomFactor());
    if (!bounds) return;
    this.bounds = bounds;
    this.layout();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.layout();
    const win = this.getWin();
    // Keys must go back to the app, or Esc would no longer reach it.
    if (win && !win.isDestroyed()) win.webContents.focus();
  }

  select(id: unknown): void {
    const tab = this.find(id);
    if (!tab) return;
    this.active = tab.id;
    if (tab.pinned && tab.failed) this.load(tab, PINNED.url);
    this.layout();
    this.changed();
  }

  /** The + button, or a link that wants a new tab. A new tab with no address stays empty. */
  open(address?: string): void {
    if (this.tabs.length >= MAX_TABS) return;
    const id = `t${this.serial++}`;
    const tab: Tab = { id, pinned: false, view: null, url: "", title: "", loading: false, failed: false };
    this.tabs.push(tab);
    this.active = id;
    if (address) this.load(tab, address);
    this.layout();
    this.changed();
  }

  close(id: unknown): void {
    const tab = this.find(id);
    if (!tab || tab.pinned) return;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    this.destroy(tab);
    if (this.active === tab.id) {
      this.active = (this.tabs[index - 1] ?? this.tabs[0] ?? { id: PINNED.id }).id;
    }
    this.layout();
    this.changed();
  }

  /**
   * The address bar. The pinned tab is tied to its own site, so a typed address opens a new tab instead.
   * Returns false when the text is not a web address.
   */
  go(input: unknown): boolean {
    const address = normalizeAddress(input);
    if (!address) return false;
    const tab = this.current();
    if (tab.pinned) this.open(address);
    else this.load(tab, address);
    this.layout();
    this.changed();
    return true;
  }

  back(): void {
    const wc = this.current().view?.webContents;
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(): void {
    const wc = this.current().view?.webContents;
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(): void {
    const tab = this.current();
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (tab.failed && tab.pinned) this.load(tab, PINNED.url);
    else wc.reload();
  }

  dispose(): void {
    for (const tab of this.tabs) this.destroy(tab);
    this.tabs.length = 0;
    this.shown = false;
  }

  private current(): Tab {
    return this.tabs.find((tab) => tab.id === this.active) ?? (this.tabs[0] as Tab);
  }

  private find(id: unknown): Tab | undefined {
    return typeof id === "string" ? this.tabs.find((tab) => tab.id === id) : undefined;
  }

  private changed(): void {
    this.publish(this.state());
  }

  /** Only the active tab is visible, and only while the workbench shows the browser page. */
  private layout(): void {
    for (const tab of this.tabs) {
      const view = tab.view;
      if (!view || view.webContents.isDestroyed()) continue;
      const on = this.shown && tab.id === this.active && this.bounds !== null;
      if (on && this.bounds) view.setBounds(this.bounds);
      view.setVisible(on);
    }
  }

  private load(tab: Tab, address: string): void {
    const view = tab.view ?? this.createView(tab);
    if (!view) return;
    tab.url = address;
    tab.failed = false;
    view.webContents.loadURL(address).catch(() => {
      // did-fail-load has already recorded it.
    });
  }

  private destroy(tab: Tab): void {
    const view = tab.view;
    tab.view = null;
    if (!view) return;
    const win = this.getWin();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private createView(tab: Tab): WebContentsView | null {
    const win = this.getWin();
    if (!win || win.isDestroyed()) return null;
    const ses = guardPartition(tab.pinned ? PINNED.partition : SHARED_PARTITION);
    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    view.setVisible(false);
    win.contentView.addChildView(view);
    tab.view = view;

    const wc = view.webContents;
    wc.setUserAgent(pageUserAgent(wc.getUserAgent(), app.getName()));

    /** A link the tab may not follow itself. A web link goes to a new tab, anything else is dropped. */
    const elsewhere = (url: string): void => {
      const target = webUrl(url);
      if (target) this.open(target);
    };
    wc.setWindowOpenHandler(({ url }) => {
      if (tab.pinned && inPinnedSite(url)) void wc.loadURL(url);
      else elsewhere(url);
      return { action: "deny" };
    });
    const guard = (event: { url: string; preventDefault(): void }): void => {
      if (tab.pinned ? inPinnedSite(event.url) : webUrl(event.url) !== null) return;
      event.preventDefault();
      if (tab.pinned) elsewhere(event.url);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);

    wc.on("page-title-updated", (_event, title) => {
      if (!tab.pinned) tab.title = title;
      this.changed();
    });
    const arrived = (_event: unknown, url: string): void => {
      if (webUrl(url)) tab.url = url;
      this.changed();
    };
    wc.on("did-navigate", arrived);
    wc.on("did-navigate-in-page", arrived);
    wc.on("did-start-loading", () => {
      tab.loading = true;
      this.changed();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.changed();
    });
    wc.on("did-finish-load", () => {
      tab.failed = false;
    });
    wc.on("did-fail-load", (_event, code, _desc, url, isMainFrame) => {
      // -3 is a load that was cancelled by another navigation, not a failure.
      if (!isMainFrame || code === -3) return;
      tab.failed = true;
      if (webUrl(url)) tab.url = url;
      this.changed();
    });
    return view;
  }
}

/** Only the app's own window may drive the tabs. */
export function registerBrowserHandlers(
  ipc: IpcMain,
  tabs: BrowserTabs,
  getWin: () => BrowserWindow | null,
): void {
  const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = getWin();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  };
  const on = (channel: string, run: (...args: unknown[]) => void): void => {
    ipc.on(channel, (event, ...args: unknown[]) => {
      if (fromApp(event)) run(...args);
    });
  };
  on("agent:browserShow", (box) => tabs.show(box));
  on("agent:browserBounds", (box) => tabs.setBounds(box));
  on("agent:browserHide", () => tabs.hide());
  on("agent:browserSelect", (id) => tabs.select(id));
  on("agent:browserNew", () => tabs.open());
  on("agent:browserClose", (id) => tabs.close(id));
  on("agent:browserBack", () => tabs.back());
  on("agent:browserForward", () => tabs.forward());
  on("agent:browserReload", () => tabs.reload());
  ipc.handle("agent:browserGo", (event, text: unknown) => (fromApp(event) ? tabs.go(text) : false));
}
