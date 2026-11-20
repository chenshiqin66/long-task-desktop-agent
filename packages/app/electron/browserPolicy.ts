/**
 * Rules for the workbench browser. No Electron import here, so node can test them.
 * The renderer only sends text and tab ids. What counts as a web address, and which site the
 * pinned tab may leave for, is decided here.
 */

/** The tab that is always there. It has its own cookie jar and stays on its own site. */
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
