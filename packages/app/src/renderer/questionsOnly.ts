import { refreshStickyTurns } from "./ui.js";

/**
 * The "只看用户问题" filter, shared by the main conversation and the explain pane. A board is any
 * `.messages` element. While it carries `is-questions-only`, a turn that is not expanded shows only its
 * question bubble, and a click on a bubble opens or folds that turn. The find bar skips the hidden text.
 */
const FILTER_CLASS = "is-questions-only";

export function questionsOnly(board: HTMLElement | null): boolean {
  return Boolean(board?.classList.contains(FILTER_CLASS));
}

/** Sets the filter state of one board without any scroll handling. Used when a session's view is mounted. */
export function setFilterState(board: HTMLElement, on: boolean): void {
  board.classList.toggle(FILTER_CLASS, on);
}

/** Whether the filter hides this text node. A node outside any board is never hidden. */
export function isQuestionFilterHidden(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  const board = el?.closest<HTMLElement>(".messages") ?? null;
  if (!questionsOnly(board)) return false;
  const turn = el?.closest(".turn");
  if (!(turn instanceof HTMLElement) || turn.classList.contains("is-expanded") || !board?.contains(turn)) return false;
  const branch = el?.closest(".turn > *");
  if (!(branch instanceof HTMLElement)) return false;
  if (branch.classList.contains("user")) return false;
  if (branch.classList.contains("msg-time") && branch.previousElementSibling?.classList.contains("user")) return false;
  return true;
}

/** Keeps a bubble at the same place on screen while the turns above or around it change. */
function holdBubble(board: HTMLElement, bubble: HTMLElement, mutate: () => void): void {
  const before = bubble.getBoundingClientRect().top;
  const behavior = board.style.scrollBehavior;
  board.style.scrollBehavior = "auto";
  mutate();
  refreshStickyTurns(board);
  const delta = bubble.getBoundingClientRect().top - before;
  if (Math.abs(delta) > 0.5) board.scrollTop += delta;
  board.style.scrollBehavior = behavior;
}

/** The first question bubble that is on screen, so switching the filter does not jump the view. */
function visibleAnchor(board: HTMLElement): HTMLElement | null {
  const box = board.getBoundingClientRect();
  for (const node of Array.from(board.querySelectorAll(":scope > .turn > .msg.user"))) {
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom > box.top + 4 && rect.top < box.bottom - 4) return node;
  }
  return null;
}

/**
 * Turns the filter on or off for a board. `streamingTurn` is the turn whose run is still going: it
 * opens when the filter turns on, so the answer being written is not hidden. `onChange` runs with the
 * new state so the caller can update its button.
 */
export function setQuestionsOnly(
  board: HTMLElement,
  on: boolean,
  streamingTurn: HTMLElement | null,
  onChange?: (on: boolean) => void,
): void {
  const anchor = visibleAnchor(board);
  const apply = (): void => {
    board.classList.toggle(FILTER_CLASS, on);
    onChange?.(on);
    if (on) streamingTurn?.classList.add("is-expanded");
  };
  if (anchor) holdBubble(board, anchor, apply);
  else {
    apply();
    refreshStickyTurns(board);
  }
}

/** A question sent while the filter is on opens its own turn, so the user sees what they just sent. */
export function expandTurnForQuestion(board: HTMLElement, body: HTMLElement): void {
  if (questionsOnly(board)) body.closest(".turn")?.classList.add("is-expanded");
}

/** On a filtered board, a click on a question bubble opens or folds its turn. Links, buttons and a text selection are left alone. */
export function bindQuestionBubbleToggle(board: HTMLElement): void {
  board.addEventListener("click", (ev) => {
    if (!questionsOnly(board)) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest("a, button, summary, input, textarea")) return;
    const bubble = target.closest(".msg.user");
    if (!(bubble instanceof HTMLElement) || !board.contains(bubble)) return;
    const selected = window.getSelection();
    if (selected && !selected.isCollapsed && bubble.contains(selected.anchorNode)) return;
    const turn = bubble.parentElement;
    if (!(turn instanceof HTMLElement) || !turn.classList.contains("turn")) return;
    holdBubble(board, bubble, () => turn.classList.toggle("is-expanded"));
  });
}
