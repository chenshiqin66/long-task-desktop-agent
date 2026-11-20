/**
 * An agent input box folds to its one-row form (the same look as the idle explain box) until it is
 * used. It stays open while the session has not started, while it has focus, while it holds a draft,
 * and while the app is waiting on it (an answer is due, or the box is locked or disabled).
 */
export interface CollapseFacts {
  /** The session has messages. A new or empty session keeps its box open. */
  started: boolean;
  focused: boolean;
  hasDraft: boolean;
  held: boolean;
}

export function composerCollapsed(facts: CollapseFacts): boolean {
  return facts.started && !facts.focused && !facts.hasDraft && !facts.held;
}

export interface ComposerCollapse {
  /** Call after anything that changes the draft or the box state. Session changes are noticed on their own. */
  refresh(): void;
}

const CLASS = "is-collapsed";

export function attachComposerCollapse(opts: {
  composer: HTMLElement;
  input: HTMLTextAreaElement;
  /** Where the messages are. An `.empty-state` inside it means the session has not started. */
  conversation: HTMLElement;
  hasDraft(): boolean;
  held(): boolean;
}): ComposerCollapse {
  let focused = false;

  function refresh(): void {
    const collapsed = composerCollapsed({
      started: !opts.conversation.querySelector(".empty-state"),
      focused,
      hasDraft: opts.hasDraft(),
      held: opts.held(),
    });
    opts.composer.classList.toggle(CLASS, collapsed);
  }

  opts.composer.addEventListener("focusin", () => {
    focused = true;
    refresh();
  });
  opts.composer.addEventListener("focusout", (ev) => {
    // Moving between the box's own buttons keeps it open; leaving it folds it again.
    const next = ev.relatedTarget;
    focused = next instanceof Node && opts.composer.contains(next);
    refresh();
  });
  // A folded box is one row; a click anywhere on it, not only on the text, opens it.
  opts.composer.addEventListener("pointerdown", (ev) => {
    if (!opts.composer.classList.contains(CLASS)) return;
    const target = ev.target;
    if (target instanceof Element && target.closest("button, select, input")) return;
    if (target !== opts.input) opts.input.focus();
  });
  opts.input.addEventListener("input", refresh);
  new MutationObserver(refresh).observe(opts.conversation, { childList: true, subtree: true });
  refresh();
  return { refresh };
}
