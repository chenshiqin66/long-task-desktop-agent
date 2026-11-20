import { app, Menu, session, WebContentsView } from "electron";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  MAX_TABS,
  NO_SAVED_TABS,
  PINNED,
  SHARED_PARTITION,
  clipSelection,
  inPinnedSite,
  normalizeAddress,
  pageUserAgent,
  paneBounds,
  snapshotTabs,
  webUrl,
  type SavedTabs,
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
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

/**
 * Run in a page to end its full screen. The app hears "full screen" before the page has finished
 * entering it, so a page that is not there yet leaves as soon as it arrives (for two seconds at most).
 */
const EXIT_FULLSCREEN = `(() => {
  const leave = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  if (document.fullscreenElement) return leave();
  const late = () => { document.removeEventListener("fullscreenchange", late); leave(); };
  document.addEventListener("fullscreenchange", late);
  setTimeout(() => document.removeEventListener("fullscreenchange", late), 2000);
})(); 0`;

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
  private active = "";
  private shown = false;
  private bounds: PaneRect | null = null;
  private serial = 1;
  /** The last list handed to `sink.save`, so only a real change is written. */
  private lastSaved: string;
  private disposed = false;
  /** The tab whose page is in full screen (a video), if any. */
  private fullscreen: string | null = null;
  private watched: BrowserWindow | null = null;

  /**
   * `saved` is where the tabs were last time. They come back as tabs without a page: a tab loads its
   * address only when it is shown, so a restart does not open a dozen pages at once.
   */
  constructor(
    private readonly getWin: () => BrowserWindow | null,
    private readonly sink: {
      /** The tab list or a tab changed. */
      state(state: BrowserState): void;
      /** The user chose "explain" on text selected in a page. */
      explain(text: string): void;
      /** The list of addresses changed. The sink decides when to write it down. */
      save(saved: SavedTabs): void;
    },
    saved: SavedTabs = NO_SAVED_TABS,
  ) {
    if (saved.pinnedOpen) this.tabs.push(this.pinnedTab(saved.pinnedUrl || PINNED.url));
    this.active = this.tabs[0]?.id ?? "";
    saved.tabs.slice(0, MAX_TABS - 1).forEach((item, index) => {
      const id = `t${this.serial++}`;
      this.tabs.push({ id, pinned: false, view: null, url: item.url, title: item.title, loading: false, failed: false });
      if (index === saved.active) this.active = id;
    });
    // There is always a tab to show: with nothing saved and DeepSeek closed, that is an empty one.
    if (this.tabs.length === 0) {
      const id = `t${this.serial++}`;
      this.tabs.push({ id, pinned: false, view: null, url: "", title: "", loading: false, failed: false });
      this.active = id;
    } else if (!this.tabs.some((tab) => tab.id === this.active)) {
      // "The pinned tab was showing", but it is closed now: show the first one.
      this.active = (this.tabs[0] as Tab).id;
    }
    this.lastSaved = JSON.stringify(snapshotTabs(this.tabs, this.active));
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
    this.mute(false);
    this.wake(this.current());
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
    // The pages stay alive while the workbench is closed, so they must not go on playing.
    this.mute(true);
    this.layout();
    const win = this.getWin();
    // Keys must go back to the app, or Esc would no longer reach it.
    if (win && !win.isDestroyed()) win.webContents.focus();
  }

  select(id: unknown): void {
    const tab = this.find(id);
    if (!tab) return;
    this.active = tab.id;
    this.wake(tab);
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
    if (!tab) return;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    this.destroy(tab);
    // Closing the last tab leaves an empty one, so the page is never without a tab.
    if (this.tabs.length === 0) {
      this.open();
      return;
    }
    if (this.active === tab.id) {
      this.active = (this.tabs[index - 1] ?? this.tabs[0] as Tab).id;
    }
    this.layout();
    this.changed();
  }

  /**
   * DeepSeek has its own cookie jar, so it only ever opens as its own tab. This brings that tab back
   * (first in the row) or switches to it. A tab that was still empty is dropped: it was only there to ask for this.
   */
  openDeepSeek(address?: string): void {
    let tab = this.tabs.find((item) => item.pinned);
    if (!tab) {
      const stray = this.current();
      const drop = !stray.pinned && !stray.view && stray.url === "";
      if (this.tabs.length - (drop ? 1 : 0) >= MAX_TABS) return;
      tab = this.pinnedTab(PINNED.url);
      this.tabs.unshift(tab);
      if (drop) {
        this.tabs.splice(this.tabs.indexOf(stray), 1);
        this.destroy(stray);
      }
    }
    this.active = tab.id;
    if (address && inPinnedSite(address)) this.load(tab, address);
    else this.wake(tab);
    this.layout();
    this.changed();
  }

  /**
   * The address bar. An address on DeepSeek's site goes to the DeepSeek tab, which has the login. The DeepSeek
   * tab is tied to its own site, so any other address opens a new tab instead.
   * Returns false when the text is not a web address.
   */
  go(input: unknown): boolean {
    const address = normalizeAddress(input);
    if (!address) return false;
    if (inPinnedSite(address)) {
      this.openDeepSeek(address);
      return true;
    }
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
    // Last chance to record where the tabs are. After this the list is empty and must not be saved.
    this.persist();
    this.disposed = true;
    if (this.watched && !this.watched.isDestroyed()) this.watched.off("resize", this.onResize);
    this.watched = null;
    for (const tab of this.tabs) this.destroy(tab);
    this.tabs.length = 0;
    this.shown = false;
  }

  private pinnedTab(url: string): Tab {
    return { id: PINNED.id, pinned: true, view: null, url, title: PINNED.title, loading: false, failed: false };
  }

  private current(): Tab {
    return this.tabs.find((tab) => tab.id === this.active) ?? (this.tabs[0] as Tab);
  }

  private find(id: unknown): Tab | undefined {
    return typeof id === "string" ? this.tabs.find((tab) => tab.id === id) : undefined;
  }

  private changed(): void {
    this.sink.state(this.state());
    this.persist();
  }

  private persist(): void {
    if (this.disposed) return;
    const saved = snapshotTabs(this.tabs, this.active);
    const text = JSON.stringify(saved);
    if (text === this.lastSaved) return;
    this.lastSaved = text;
    this.sink.save(saved);
  }

  /** Gives a tab its page when it is about to be seen: first time after a restart, or after a failed load. */
  private wake(tab: Tab): void {
    if (tab.pinned) {
      if (!tab.view) this.load(tab, inPinnedSite(tab.url) ? tab.url : PINNED.url);
      else if (tab.failed) this.load(tab, PINNED.url);
    } else if (!tab.view && tab.url) {
      this.load(tab, tab.url);
    }
  }

  private mute(on: boolean): void {
    for (const tab of this.tabs) {
      const wc = tab.view?.webContents;
      if (wc && !wc.isDestroyed()) wc.setAudioMuted(on);
    }
  }

  /** Only the active tab is visible, and only while the workbench shows the browser page. */
  private layout(): void {
    const win = this.getWin();
    // Full screen belongs to the tab on screen. If another tab (or no tab) is on screen now, it ends.
    const full = this.tabs.find((tab) => tab.id === this.fullscreen);
    if (full && !(this.shown && full.id === this.active)) this.leaveFullscreen(full);
    for (const tab of this.tabs) {
      const view = tab.view;
      if (!view || view.webContents.isDestroyed()) continue;
      const on = this.shown && tab.id === this.active && this.bounds !== null;
      if (on && this.fullscreen === tab.id && win && !win.isDestroyed()) {
        // Over the whole window, whatever size the workbench page had.
        const [width, height] = win.getContentSize();
        view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
      } else if (on && this.bounds) {
        view.setBounds(this.bounds);
      }
      view.setVisible(on);
    }
  }

  /** The window changes size when it goes in and out of full screen, and the page must follow. */
  private watch(win: BrowserWindow): void {
    if (this.watched === win) return;
    this.watched = win;
    win.on("resize", this.onResize);
  }

  private readonly onResize = (): void => {
    if (this.fullscreen) this.layout();
  };

  /** Ends a page's full screen from outside (tab switched, workbench closed). The window goes back too. */
  private leaveFullscreen(tab: Tab): void {
    if (this.fullscreen === tab.id) this.fullscreen = null;
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.executeJavaScript(EXIT_FULLSCREEN, true).catch(() => {
        // The page may be gone or busy. Esc still works in it.
      });
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
    const wasFull = this.fullscreen === tab.id;
    if (wasFull) this.fullscreen = null;
    tab.view = null;
    if (!view) return;
    const win = this.getWin();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    if (!wasFull || this.disposed) {
      wc.close();
      return;
    }
    // A page that is closed while it is full screen would leave the window full screen. It leaves first.
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (!wc.isDestroyed()) wc.close();
    };
    wc.once("leave-html-full-screen", finish);
    setTimeout(finish, 1500).unref();
    wc.executeJavaScript(EXIT_FULLSCREEN, true).catch(finish);
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
    // A page opened while the workbench is closed (a pop-up from a page in the background) starts silent.
    wc.setAudioMuted(!this.shown);
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

    // A page has no menu of its own here. This one offers the two things a selection is for.
    wc.on("context-menu", (_event, params) => {
      const text = clipSelection(params.selectionText);
      Menu.buildFromTemplate([
        { label: "解释所选文字", enabled: text !== "", click: () => this.sink.explain(text) },
        { label: "复制", enabled: text !== "", click: () => wc.copy() },
      ]).popup({ window: win });
    });

    // A page asks for full screen (a video's full screen button). Electron already makes the window
    // full screen, but this view keeps its small size unless it is told to fill the window.
    wc.on("enter-html-full-screen", () => {
      this.fullscreen = tab.id;
      this.watch(win);
      this.layout();
      if (tab.id === this.active && this.shown) wc.focus();
    });
    wc.on("leave-html-full-screen", () => {
      if (this.fullscreen === tab.id) this.fullscreen = null;
      this.layout();
    });

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
  on("agent:browserDeepseek", () => tabs.openDeepSeek());
  on("agent:browserClose", (id) => tabs.close(id));
  on("agent:browserBack", () => tabs.back());
  on("agent:browserForward", () => tabs.forward());
  on("agent:browserReload", () => tabs.reload());
  ipc.handle("agent:browserGo", (event, text: unknown) => (fromApp(event) ? tabs.go(text) : false));
}
