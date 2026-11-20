import { canDropText, droppedText } from "./explainDrag.js";
import type { ExplainPane } from "./explainPane.js";

/**
 * What the explain pane gets instead of a workspace and a session while the browser has it. The main
 * process turns this pair into a record under the app's own data folder. Keep both in step with
 * `electron/browserExplain.ts`; a test compares them.
 */
export const BROWSER_EXPLAIN_WORKSPACE = "browser:explain";
export const BROWSER_EXPLAIN_SESSION = "browser-explain";

export interface BrowserExplainApi {
  onBrowserExplain(cb: (text: string) => void): () => void;
}

export interface BrowserExplain {
  /** The browser page opened: the explain pane moves into it and works on the browser's record. */
  enter(): void;
  /** The browser page closed: the pane goes back where it was and follows the session on screen. */
  leave(): void;
}

/** Remembers where an element was, so it can be put back. */
function lend(node: HTMLElement, to: HTMLElement): () => void {
  const marker = document.createComment("lent");
  node.before(marker);
  to.append(node);
  return () => {
    if (marker.parentNode) marker.replaceWith(node);
  };
}

/**
 * The browser page has no explain pane of its own. It borrows the one the agent page has, as a column
 * beside the page that reaches up to the top: the same element, so the answers, the model picker, the
 * open and collapse buttons and the styles are the same. The pane's expand button comes along, so the
 * pane shows and hides itself here the way it does on the agent page. Both are put back when the page
 * closes. The browser's explanations are kept apart from every session's.
 *
 * Text gets in two ways: "解释所选文字" in a page's right-click menu, and dragging selected text from the
 * page onto the open pane.
 */
export function mountBrowserExplain(opts: {
  explain: Pick<ExplainPane, "pane" | "use" | "ask">;
  /** The pane's own expand button, shown by the pane while it is collapsed. */
  expand: HTMLButtonElement;
  /** Where the pane sits while the browser has it. */
  slot: HTMLElement;
  /** Where the expand button sits while the browser has it. */
  expandSlot: HTMLElement;
  api: () => BrowserExplainApi | undefined;
}): BrowserExplain {
  const { explain, expand, slot, expandSlot, api } = opts;
  const pane = explain.pane;
  let entered = false;
  let putBack: Array<() => void> = [];

  // "解释所选文字" in a page's right-click menu.
  api()?.onBrowserExplain((text) => {
    if (entered) explain.ask(text, null);
  });

  // Text dragged out of the page. The page is another process, so it can only hand over plain text.
  function intoField(ev: DragEvent): boolean {
    return ev.target instanceof Element && Boolean(ev.target.closest("textarea, input"));
  }
  pane.addEventListener("dragover", (ev) => {
    if (!entered || !canDropText(ev.dataTransfer?.types, intoField(ev))) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    pane.classList.add("is-explain-drop");
  });
  pane.addEventListener("dragleave", (ev) => {
    const next = ev.relatedTarget;
    if (next instanceof Node && pane.contains(next)) return;
    pane.classList.remove("is-explain-drop");
  });
  pane.addEventListener("drop", (ev) => {
    if (!entered) return;
    const text = droppedText(ev.dataTransfer, intoField(ev));
    pane.classList.remove("is-explain-drop");
    if (text === null) return;
    ev.preventDefault();
    explain.ask(text, null);
  });

  return {
    enter(): void {
      if (entered) return;
      entered = true;
      putBack = [lend(pane, slot), lend(expand, expandSlot)];
      explain.use({ sessionId: BROWSER_EXPLAIN_SESSION, workspace: BROWSER_EXPLAIN_WORKSPACE });
    },
    leave(): void {
      if (!entered) return;
      entered = false;
      pane.classList.remove("is-explain-drop");
      for (const undo of putBack) undo();
      putBack = [];
      explain.use(null);
    },
  };
}
