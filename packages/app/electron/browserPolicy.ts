/**
 * Rules for the workbench browser. No Electron import here, so node can test them.
 * The renderer only sends text and tab ids. What counts as a web address, and which site the
 * pinned tab may leave for, is decided here.
 */

/**
 * The DeepSeek tab. It is open at first, can be closed, and comes back from the empty tab's button.
 * It has its own cookie jar and stays on its own site.
 */
export const PINNED = {
  id: "deepseek",
  title: "DeepSeek",
  url: "https://chat.deepseek.com/",
  /** Logging in here never reaches the other tabs. */
  partition: "persist:deepseek",
  hostSuffix: "deepseek.com",
} as const;

/** Tabs the user opens share one cookie jar, separate from the pinned tab's. */
export const SHARED_PARTITION = "persist:browser";

/** Every open tab is a Chromium renderer process. This keeps pop-ups and the + button from piling them up. */
export const MAX_TABS = 12;

/** A link is a web link when it is http or https. Anything else (file:, javascript:, mailto:, ...) never loads. */
export function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The pinned tab stays on https pages of its own site. */
export function inPinnedSite(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === PINNED.hostSuffix || url.hostname.endsWith(`.${PINNED.hostSuffix}`);
}

const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;

/**
 * Turns what the user typed into an address, or null when it is not one.
 * A full http(s) address is kept. A bare host gets https, except localhost and plain IPs, which get http.
 * Any other scheme is refused, and so is plain text: this is an address bar, not a search box.
 */
export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) return webUrl(text);
  // "name:" is a scheme unless digits follow, which makes it host:port.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+([/?#]|$))/i.test(text)) return null;
  const candidate = `${LOCAL_HOST.test(text) ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname;
  const looksLikeHost = host.includes(".") || host === "localhost" || host.startsWith("[");
  return looksLikeHost ? webUrl(url.toString()) : null;
}

/** A selection longer than this is cut. Ctrl+A on a long page must not send the whole page to the model. */
export const MAX_SELECTION = 4000;

/** Text the user selected in a page, ready to hand to the explain pane. Empty when there is none. */
export function clipSelection(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  // Count code points, so a cut never splits a surrogate pair.
  const points = Array.from(text);
  return points.length > MAX_SELECTION ? points.slice(0, MAX_SELECTION).join("") : text;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The renderer measures in CSS pixels. The native view is placed in window pixels,
 * which differ by the page zoom (View > zoom in/out).
 */
export function paneBounds(raw: unknown, zoom: number): PaneRect | null {
  if (!raw || typeof raw !== "object") return null;
  const box = raw as Record<string, unknown>;
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const [x, y, width, height] = values as [number, number, number, number];
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: Math.max(0, Math.round(width * scale)),
    height: Math.max(0, Math.round(height * scale)),
  };
}

/**
 * A tab is a plain Chromium browser. Drop the two tokens Electron adds
 * (its own, and the app's name and version) so the site sees an ordinary Chrome user agent.
 */
export function pageUserAgent(ua: string, appName: string): string {
  return ua
    .split(" ")
    .filter((part) => !part.startsWith("Electron/") && !part.startsWith(`${appName}/`))
    .join(" ");
}

/** What is kept of the tabs between runs: where each one was, not what was on the page. */
export interface SavedTab {
  url: string;
  title: string;
}

export interface SavedTabs {
  /** The tabs the user opened, in order. The pinned tab is not in the list. */
  tabs: SavedTab[];
  /** Index into `tabs` of the tab that was showing, or -1 for the pinned tab. */
  active: number;
  /** Where the pinned tab was, when that is a page of its own site. Empty otherwise. */
  pinnedUrl: string;
  /** Whether the pinned tab was open. A file from before it could be closed has no such field: open. */
  pinnedOpen: boolean;
}

export const NO_SAVED_TABS: SavedTabs = { tabs: [], active: -1, pinnedUrl: "", pinnedOpen: true };

/** A longer address is not worth keeping; it is nearly always a page that carries a token or a data blob. */
const MAX_SAVED_URL = 4096;
const MAX_SAVED_TITLE = 200;

function savedUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_SAVED_URL) return null;
  return webUrl(raw);
}

function savedTitle(raw: unknown): string {
  return typeof raw === "string" ? Array.from(raw).slice(0, MAX_SAVED_TITLE).join("") : "";
}

/**
 * Reads the file written by `snapshotTabs`. It is a plain file in the user's folder, so it is checked
 * like any input: anything that is not a web address is dropped, and a damaged file means no tabs.
 */
export function parseSavedTabs(raw: unknown): SavedTabs {
  if (!raw || typeof raw !== "object") return { ...NO_SAVED_TABS, tabs: [] };
  const data = raw as Record<string, unknown>;
  const tabs: SavedTab[] = [];
  const rows = Array.isArray(data.tabs) ? data.tabs : [];
  for (const row of rows) {
    if (tabs.length >= MAX_TABS - 1) break;
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const url = savedUrl(item.url);
    if (url) tabs.push({ url, title: savedTitle(item.title) });
  }
  // Dropping a row shifts the indexes after it, so the saved index only counts when nothing was dropped.
  const intact = tabs.length === rows.length;
  const active =
    intact && Number.isInteger(data.active) && (data.active as number) >= -1 && (data.active as number) < tabs.length
      ? (data.active as number)
      : -1;
  const pinnedOpen = data.pinnedOpen !== false;
  const pinned = savedUrl(data.pinnedUrl);
  return { tabs, active, pinnedUrl: pinnedOpen && pinned && inPinnedSite(pinned) ? pinned : "", pinnedOpen };
}

/** The tabs as they should be written down. An empty tab (just opened with +) has nothing to keep. */
export function snapshotTabs(
  tabs: ReadonlyArray<{ id: string; pinned: boolean; url: string; title: string }>,
  active: string,
): SavedTabs {
  const kept: SavedTab[] = [];
  let activeIndex = -1;
  let pinnedUrl = "";
  let pinnedOpen = false;
  for (const tab of tabs) {
    if (tab.pinned) {
      pinnedOpen = true;
      const url = savedUrl(tab.url);
      if (url && inPinnedSite(url)) pinnedUrl = url;
      continue;
    }
    const url = savedUrl(tab.url);
    if (!url || kept.length >= MAX_TABS - 1) continue;
    if (tab.id === active) activeIndex = kept.length;
    kept.push({ url, title: savedTitle(tab.title) });
  }
  return { tabs: kept, active: activeIndex, pinnedUrl, pinnedOpen };
}
