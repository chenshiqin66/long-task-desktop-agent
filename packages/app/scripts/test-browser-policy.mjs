import {
  MAX_TABS,
  PINNED,
  SHARED_PARTITION,
  inPinnedSite,
  normalizeAddress,
  pageUserAgent,
  paneBounds,
  webUrl,
} from "../dist/electron/browserPolicy.js";
import { addressBarShown, parseBrowserState, tabLabel } from "../dist/src/renderer/browserView.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The pinned tab and the user's tabs never share cookies.
assert(PINNED.url === "https://chat.deepseek.com/", "pinned address");
assert(PINNED.partition !== SHARED_PARTITION, "pinned tab has its own cookie jar");
assert(MAX_TABS > 1, "tab limit leaves room for tabs");

// The pinned tab stays on https pages of its own site.
assert(inPinnedSite(PINNED.url), "start page stays");
assert(inPinnedSite("https://chat.deepseek.com/a/b?x=1"), "path stays");
assert(inPinnedSite("https://deepseek.com/"), "apex stays");
assert(inPinnedSite("https://sub.chat.deepseek.com/"), "subdomain stays");
assert(!inPinnedSite("http://chat.deepseek.com/"), "http leaves");
assert(!inPinnedSite("https://evildeepseek.com/"), "suffix without a dot leaves");
assert(!inPinnedSite("https://deepseek.com.evil.com/"), "lookalike host leaves");
assert(!inPinnedSite("https://chat.deepseek.com@evil.com/"), "userinfo trick leaves");
assert(!inPinnedSite("javascript:alert(1)"), "javascript: leaves");
assert(!inPinnedSite("not a url"), "garbage leaves");

// Only web links load.
assert(webUrl("https://example.com/a") === "https://example.com/a", "https loads");
assert(webUrl("http://example.com/") === "http://example.com/", "http loads");
assert(webUrl("file:///C:/Windows/win.ini") === null, "file: never loads");
assert(webUrl("javascript:alert(1)") === null, "javascript: never loads");
assert(webUrl("data:text/html,<script>1</script>") === null, "data: never loads");
assert(webUrl("mailto:a@b.c") === null, "mailto: never loads");
assert(webUrl("garbage") === null, "garbage never loads");

// What the user types into the address bar.
assert(normalizeAddress("https://example.com/a?b=1") === "https://example.com/a?b=1", "full https kept");
assert(normalizeAddress("http://example.com") === "http://example.com/", "full http kept");
assert(normalizeAddress("  example.com  ") === "https://example.com/", "bare host gets https and is trimmed");
assert(normalizeAddress("www.baidu.com/s?wd=a") === "https://www.baidu.com/s?wd=a", "bare host with path");
assert(normalizeAddress("example.com:8443/x") === "https://example.com:8443/x", "host:port is not a scheme");
assert(normalizeAddress("localhost:3000") === "http://localhost:3000/", "localhost gets http");
assert(normalizeAddress("127.0.0.1:8080/a") === "http://127.0.0.1:8080/a", "ip gets http");
assert(normalizeAddress("192.168.1.1") === "http://192.168.1.1/", "lan ip gets http");
assert(normalizeAddress("HTTPS://Example.com") === "https://example.com/", "scheme is case-insensitive");
assert(normalizeAddress("百度.com") !== null, "international host");

assert(normalizeAddress("javascript:alert(1)") === null, "javascript: refused");
assert(normalizeAddress("JavaScript:alert(1)") === null, "JavaScript: refused");
assert(normalizeAddress("file:///C:/Windows/win.ini") === null, "file: refused");
assert(normalizeAddress("data:text/html,hi") === null, "data: refused");
assert(normalizeAddress("about:blank") === null, "about: refused");
assert(normalizeAddress("chrome://settings") === null, "chrome: refused");
assert(normalizeAddress("mailto:a@b.c") === null, "mailto: refused");
assert(normalizeAddress("ftp://example.com") === null, "ftp: refused");
assert(normalizeAddress("") === null, "empty refused");
assert(normalizeAddress("   ") === null, "blank refused");
assert(normalizeAddress("hello") === null, "a single word is not an address");
assert(normalizeAddress("你好") === null, "plain Chinese is not an address");
assert(normalizeAddress("how to cook") === null, "text with spaces is not an address");
assert(normalizeAddress("example .com") === null, "inner space refused");
assert(normalizeAddress(null) === null, "null refused");
assert(normalizeAddress(42) === null, "number refused");

// CSS pixels become window pixels by the page zoom.
const plain = paneBounds({ x: 10.4, y: 20.6, width: 300, height: 200 }, 1);
assert(plain && plain.x === 10 && plain.y === 21 && plain.width === 300 && plain.height === 200, "zoom 1");
const zoomed = paneBounds({ x: 100, y: 40, width: 400, height: 200 }, 1.25);
assert(
  zoomed && zoomed.x === 125 && zoomed.y === 50 && zoomed.width === 500 && zoomed.height === 250,
  "zoom 1.25",
);
const squashed = paneBounds({ x: 0, y: 0, width: -5, height: -1 }, 1);
assert(squashed && squashed.width === 0 && squashed.height === 0, "negative size clamps to zero");
assert(paneBounds({ x: 1, y: 2, width: 3, height: 4 }, 0)?.width === 3, "bad zoom counts as 1");
assert(paneBounds({ x: 1, y: 2, width: 3, height: 4 }, Number.NaN)?.width === 3, "NaN zoom counts as 1");
assert(paneBounds(null, 1) === null, "null box");
assert(paneBounds("box", 1) === null, "string box");
assert(paneBounds({ x: "1", y: 2, width: 3, height: 4 }, 1) === null, "string field");
assert(paneBounds({ x: Number.NaN, y: 2, width: 3, height: 4 }, 1) === null, "NaN field");
assert(paneBounds({ x: Infinity, y: 2, width: 3, height: 4 }, 1) === null, "Infinity field");
assert(paneBounds({ x: 1, y: 2, width: 3 }, 1) === null, "missing field");

// A tab sees an ordinary Chrome user agent.
const ua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @agent/app/0.1.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";
assert(
  pageUserAgent(ua, "@agent/app") ===
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Electron and app tokens are dropped",
);
assert(pageUserAgent("Mozilla/5.0 Chrome/130.0.0.0", "@agent/app") === "Mozilla/5.0 Chrome/130.0.0.0", "plain UA unchanged");

// Tab labels.
const tab = (over) => ({
  id: "t1",
  pinned: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over,
});
assert(tabLabel(tab({ pinned: true, title: "DeepSeek", url: PINNED.url })) === "DeepSeek", "pinned label");
assert(tabLabel(tab({ title: "A page", url: "https://example.com/" })) === "A page", "title wins");
assert(tabLabel(tab({ url: "https://example.com/a" })) === "example.com", "host when there is no title yet");
assert(tabLabel(tab({})) === "新标签页", "empty tab");

// The address bar shows only for an empty tab (right after +), and hides once the tab has a page.
assert(addressBarShown(tab({})) === true, "empty tab shows the bar");
assert(addressBarShown(tab({ url: "https://example.com/" })) === false, "tab with a page hides the bar");
assert(addressBarShown(tab({ pinned: true, url: PINNED.url })) === false, "pinned tab hides the bar");
assert(addressBarShown(undefined) === false, "no tab, no bar");

// The state from the main process is checked before it is drawn.
const good = { active: "deepseek", tabs: [tab({ id: "deepseek", pinned: true, title: "DeepSeek", url: PINNED.url })] };
assert(parseBrowserState(good)?.tabs.length === 1, "good state");
assert(parseBrowserState(null) === null, "null state");
assert(parseBrowserState({ tabs: [], active: "x" }) === null, "active tab must exist");
assert(parseBrowserState({ active: "deepseek", tabs: [{ id: "deepseek" }] }) === null, "partial tab");
assert(parseBrowserState({ active: "deepseek", tabs: "no" }) === null, "tabs must be a list");

console.log("browser policy tests ok");
