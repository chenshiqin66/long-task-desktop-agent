import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExplainStore, SessionStore } from "@agent/core";
import {
  BROWSER_EXPLAIN_SESSION,
  BROWSER_EXPLAIN_WORKSPACE,
  ensureBrowserExplainStore,
} from "../dist/electron/browserExplain.js";
import {
  BROWSER_EXPLAIN_SESSION as RENDERER_SESSION,
  BROWSER_EXPLAIN_WORKSPACE as RENDERER_WORKSPACE,
} from "../dist/src/renderer/browserExplain.js";
import { MAX_SELECTION, clipSelection } from "../dist/electron/browserPolicy.js";
import {
  EXPLAIN_DRAG_MIME,
  MAX_DROPPED,
  canDropText,
  clipDropped,
  droppedText,
} from "../dist/src/renderer/explainDrag.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The two sides of the IPC must agree on the pair that stands for "the browser".
assert(BROWSER_EXPLAIN_WORKSPACE === RENDERER_WORKSPACE, "workspace sentinel matches");
assert(BROWSER_EXPLAIN_SESSION === RENDERER_SESSION, "session sentinel matches");
assert(/^[A-Za-z0-9_-]+$/.test(BROWSER_EXPLAIN_SESSION), "session id is valid for the store");

// Selected text handed to the explain pane.
assert(clipSelection("  hello  ") === "hello", "trimmed");
assert(clipSelection("") === "", "empty");
assert(clipSelection("   \n ") === "", "blank");
assert(clipSelection(null) === "", "null");
assert(clipSelection(42) === "", "number");
assert(clipSelection("a".repeat(MAX_SELECTION)).length === MAX_SELECTION, "at the limit is kept");
assert(clipSelection("a".repeat(MAX_SELECTION + 500)).length === MAX_SELECTION, "over the limit is cut");
const emoji = "😀".repeat(MAX_SELECTION + 10);
const cut = clipSelection(emoji);
assert(Array.from(cut).length === MAX_SELECTION, "cut counts code points");
assert(!/[\ud800-\udbff]$/.test(cut), "a cut never ends on half a surrogate pair");
assert(clipSelection("你好，世界") === "你好，世界", "Chinese kept");

// Text dragged from the page onto the pane.
const drag = (types, text = "") => ({ types, getData: (t) => (t === "text/plain" ? text : "") });
assert(MAX_DROPPED === MAX_SELECTION, "drop and selection share one limit");
assert(clipDropped("  hi  ") === "hi", "dropped text is trimmed");
assert(clipDropped(7) === "", "non-text is nothing");
assert(Array.from(clipDropped("😀".repeat(MAX_DROPPED + 5))).length === MAX_DROPPED, "dropped text is cut by code points");
for (const sample of ["a".repeat(MAX_SELECTION + 9), "😀".repeat(MAX_SELECTION + 9), "  你好  ", "", "\n"]) {
  assert(clipDropped(sample) === clipSelection(sample), "dropping and selecting clip the same way");
}
assert(canDropText(["text/plain", "text/html"], false), "plain text from a page is taken");
assert(!canDropText(["text/plain"], true), "a drop into a text field is the field's own");
assert(!canDropText(["Files"], false), "files are not text");
assert(!canDropText(["Files", "text/plain"], false), "files win over text");
assert(!canDropText(["text/html"], false), "needs text/plain");
assert(!canDropText([EXPLAIN_DRAG_MIME, "text/plain"], false), "in-app drags are main.ts's, not asked twice");
assert(!canDropText(undefined, false), "no data transfer");
assert(droppedText(drag(["text/plain"], "  量子  "), false) === "量子", "drop gives the trimmed text");
assert(droppedText(drag(["text/plain"], "   "), false) === null, "a blank drop is ignored");
assert(droppedText(drag(["text/uri-list"], "x"), false) === null, "other types are ignored");
assert(droppedText(null, false) === null, "no drag");

// The browser's own explain record.
const base = await mkdtemp(join(tmpdir(), "browser-explain-"));
try {
  const path = await ensureBrowserExplainStore(base);
  assert(path === base, "returns the folder to use as the workspace");

  const meta = JSON.parse(await readFile(join(base, ".agent", "sessions", BROWSER_EXPLAIN_SESSION, "meta.json"), "utf8"));
  assert(meta.session_id === BROWSER_EXPLAIN_SESSION, "meta names the session");

  // The explain store accepts it like any session.
  const store = new ExplainStore(base);
  assert((await store.readMessages(BROWSER_EXPLAIN_SESSION)).length === 0, "starts empty");
  assert((await store.getOpen(BROWSER_EXPLAIN_SESSION)) === false, "starts closed");
  await store.setOpen(BROWSER_EXPLAIN_SESSION, true);
  assert((await store.getOpen(BROWSER_EXPLAIN_SESSION)) === true, "open state is kept");

  // Calling it again must not wipe what is there.
  const dir = join(base, ".agent", "sessions", BROWSER_EXPLAIN_SESSION);
  const before = await readdir(dir);
  await writeFile(join(dir, "messages.jsonl"), '{"keep":"me"}\n', "utf8");
  await ensureBrowserExplainStore(base);
  assert((await readFile(join(dir, "messages.jsonl"), "utf8")) === '{"keep":"me"}\n', "second call keeps the records");
  assert((await store.getOpen(BROWSER_EXPLAIN_SESSION)) === true, "second call keeps the open state");
  assert(JSON.stringify(await readdir(dir)) === JSON.stringify(before), "second call adds no files");

  // It is a session of its own: nothing in it is a session of a real workspace.
  const sessions = await new SessionStore(base).listSessions();
  assert(sessions.every((s) => s.session_id === BROWSER_EXPLAIN_SESSION), "only the browser's session lives here");
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log("browser explain tests ok");
