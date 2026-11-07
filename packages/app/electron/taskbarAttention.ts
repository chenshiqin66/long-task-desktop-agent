/**
 * Taskbar attention blink.
 *
 * Windows FlashWindow / Electron flashFrame cannot be tinted: the button
 * chrome stays the system highlight (usually orange). The send-button green
 * is therefore a two-frame icon swap, which is how WeChat and QQ signal a
 * waiting conversation.
 *
 * Cadence is 530ms, the Windows caret-blink default that FlashWindow uses.
 * The swap runs until the prompt is cleared. It does not stop on its own:
 * WeChat keeps flashing until you come back, rather than Outlook's
 * "seven flashes, then a steady highlight".
 */

export const TASKBAR_FLASH_MS = 530;

export type TaskbarIconKind = "rest" | "dim" | "lit";

export interface AttentionState {
  pending: boolean;
  show: TaskbarIconKind;
}

export type AttentionEvent = { type: "need" } | { type: "clear" } | { type: "tick" };

export function initialAttention(): AttentionState {
  return { pending: false, show: "rest" };
}

export function reduceAttention(state: AttentionState, event: AttentionEvent): AttentionState {
  if (event.type === "need") {
    if (state.pending) return state;
    return { pending: true, show: "lit" };
  }
  if (event.type === "clear") {
    if (!state.pending && state.show === "rest") return state;
    return { pending: false, show: "rest" };
  }
  if (!state.pending) return state;
  return { pending: true, show: state.show === "lit" ? "dim" : "lit" };
}

export function attentionDelay(state: AttentionState): number | null {
  return state.pending ? TASKBAR_FLASH_MS : null;
}
