import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TABS, NO_SAVED_TABS, PINNED, parseSavedTabs, snapshotTabs } from "../dist/electron/browserPolicy.js";
import { SavedTabsFile } from "../dist/electron/browserTabsStore.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- snapshotTabs: what gets written down
const pinned = { id: "deepseek", pinned: true, url: PINNED.url, title: "DeepSeek" };
const a = { id: "t1", pinned: false, url: "https://a.example/x?y=1", title: "A" };
const b = { id: "t2", pinned: false, url: "https://b.example/", title: "B" };
const empty = { id: "t3", pinned: false, url: "", title: "" };

let snap = snapshotTabs([pinned, a, b], "t2");
assert(same(snap.tabs, [{ url: a.url, title: "A" }, { url: b.url, title: "B" }]), "user tabs kept in order");
assert(snap.active === 1, "active tab is its index among the kept tabs");
assert(snap.pinnedUrl === PINNED.url, "the pinned tab's address is kept");

snap = snapshotTabs([pinned, a, empty, b], "t3");
assert(snap.tabs.length === 2, "an empty + tab is not kept");
assert(snap.active === -1, "an empty active tab falls back to the pinned tab");

snap = snapshotTabs([pinned, a], "deepseek");
assert(snap.active === -1, "pinned tab active");

snap = snapshotTabs([{ ...pinned, url: "https://chat.deepseek.com/a/chat/s/42" }, a], "t1");
assert(snap.pinnedUrl === "https://chat.deepseek.com/a/chat/s/42", "the pinned tab's conversation is kept");
snap = snapshotTabs([{ ...pinned, url: "https://evil.example/" }, a], "t1");
assert(snap.pinnedUrl === "", "a pinned tab that somehow left its site is not kept");

snap = snapshotTabs([pinned, { ...a, url: "https://x.example/" + "a".repeat(5000) }, b], "t2");
assert(snap.tabs.length === 1 && snap.active === 0, "an overlong address is skipped and the index follows");
snap = snapshotTabs([pinned, { ...a, title: "长".repeat(500) }], "t1");
assert(Array.from(snap.tabs[0].title).length === 200, "titles are cut");

// DeepSeek can be closed, and that is remembered.
snap = snapshotTabs([a, b], "t2");
assert(snap.pinnedOpen === false && snap.pinnedUrl === "", "no pinned tab: closed is recorded");
assert(snap.active === 1 && snap.tabs.length === 2, "other tabs unaffected");
assert(snapshotTabs([pinned, a], "t1").pinnedOpen === true, "pinned tab present: open is recorded");
assert(snapshotTabs([], "").pinnedOpen === false && snapshotTabs([], "").tabs.length === 0, "nothing at all");
assert(NO_SAVED_TABS.pinnedOpen === true, "by default DeepSeek is open");
assert(parseSavedTabs({ tabs: [{ url: "https://a.example/" }] }).pinnedOpen === true, "a file from before DeepSeek could close means open");
assert(parseSavedTabs({ tabs: [], pinnedOpen: false, pinnedUrl: PINNED.url }).pinnedUrl === "", "closed has no address");
assert(parseSavedTabs({ tabs: [], pinnedOpen: false }).pinnedOpen === false, "closed round-trips");
assert(parseSavedTabs({ tabs: [], pinnedOpen: "no" }).pinnedOpen === true, "only an explicit false closes it");
assert(same(parseSavedTabs(snapshotTabs([a, b], "t1")), snapshotTabs([a, b], "t1")), "closed snapshot survives parse");

const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => ({ id: `t${i}`, pinned: false, url: `https://e.example/${i}`, title: "" }));
assert(snapshotTabs([pinned, ...many], "t0").tabs.length === MAX_TABS - 1, "never more than the tab limit leaves room for");

// --- parseSavedTabs: a file in the user's folder is not trusted
const good = { tabs: [{ url: "https://a.example/", title: "A" }, { url: "http://localhost:3000/", title: "" }], active: 1, pinnedUrl: PINNED.url };
const parsed = parseSavedTabs(good);
assert(parsed.tabs.length === 2 && parsed.active === 1 && parsed.pinnedUrl === PINNED.url, "good file round-trips");
assert(same(parseSavedTabs(snapshotTabs([pinned, a, b], "t2")), snapshotTabs([pinned, a, b], "t2")), "snapshot survives parse");
for (const junk of [null, undefined, 7, "x", [], {}, { tabs: "no" }, { tabs: [null, 3, "x"] }]) {
  const p = parseSavedTabs(junk);
  assert(p.tabs.length === 0 && p.active === -1 && p.pinnedUrl === "", `junk gives no tabs: ${JSON.stringify(junk)}`);
}
const evil = parseSavedTabs({
  tabs: [
    { url: "file:///C:/Windows/win.ini", title: "f" },
    { url: "javascript:alert(1)", title: "j" },
    { url: "chrome://settings", title: "c" },
    { url: "https://ok.example/", title: "ok" },
    { url: 42, title: "n" },
  ],
  active: 3,
  pinnedUrl: "https://evil.example/",
});
assert(same(evil.tabs, [{ url: "https://ok.example/", title: "ok" }]), "only web addresses survive");
assert(evil.active === -1, "an index that no longer points at the same row is dropped");
assert(evil.pinnedUrl === "", "a pinned address off its site is dropped");
assert(parseSavedTabs({ tabs: [{ url: "https://a.example/" }], active: 5 }).active === -1, "active out of range");
assert(parseSavedTabs({ tabs: [{ url: "https://a.example/" }], active: 0.5 }).active === -1, "active must be an integer");
assert(parseSavedTabs({ tabs: [{ url: "https://a.example/" }], active: "0" }).active === -1, "active must be a number");
assert(parseSavedTabs({ tabs: many.map((t) => ({ url: t.url })) }).tabs.length === MAX_TABS - 1, "file cannot exceed the limit");
assert(parseSavedTabs({ tabs: [{ url: "https://a.example/", title: 5 }] }).tabs[0].title === "", "non-text title is empty");
assert(parseSavedTabs(NO_SAVED_TABS).tabs.length === 0, "the empty value parses");

// --- SavedTabsFile
const dir = await mkdtemp(join(tmpdir(), "browser-tabs-"));
try {
  const path = join(dir, "sub", "browser-tabs.json");
  const file = new SavedTabsFile(path);
  assert(file.load().tabs.length === 0, "missing file means no tabs");

  const first = snapshotTabs([pinned, a], "t1");
  file.save(first);
  assert(file.load().tabs.length === 0, "a save waits before writing");
  file.flush();
  assert(same(file.load(), first), "flush writes it, creating the folder");
  assert(JSON.parse(await readFile(path, "utf8")).tabs[0].url === a.url, "plain JSON on disk");
  assert(!(await readdir(join(dir, "sub"))).some((n) => n.endsWith(".tmp")), "no temp file left");

  // Many quick saves: only the last is written, and without an explicit flush.
  const second = snapshotTabs([pinned, a, b], "t2");
  file.save(first);
  file.save(snapshotTabs([pinned, b], "t2"));
  file.save(second);
  await sleep(700);
  assert(same(file.load(), second), "the timer writes the latest list");

  file.flush();
  assert(same(file.load(), second), "flush with nothing waiting changes nothing");

  // A damaged file must not stop the app.
  await writeFile(path, "{ not json", "utf8");
  assert(file.load().tabs.length === 0, "damaged file means no tabs");
  await writeFile(path, "\ufeff" + JSON.stringify(first), "utf8");
  assert(same(file.load(), first), "a BOM is tolerated");

  // An unwritable place must not throw.
  const blocked = new SavedTabsFile(join(path, "inside-a-file", "x.json"));
  blocked.save(first);
  blocked.flush();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("browser tabs store tests ok");
