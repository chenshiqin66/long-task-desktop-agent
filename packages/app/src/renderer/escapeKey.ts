/** What the window-level Esc handler does. */
export type EscapeAction = "none" | "close-find" | "close-tasks" | "stop";

export interface EscapeState {
  /** Another handler already used this Esc: the rename box, the skill menu, the context menu. */
  handled: boolean;
  /** An IME composition is open; Esc cancels the composition. */
  composing: boolean;
  /** A modal dialog closes itself on Esc. */
  dialogOpen: boolean;
  /** The main find bar or the explain pane's find bar. */
  findOpen: boolean;
  taskPanelOpen: boolean;
  /** A turn is running on the session on screen. */
  viewingRun: boolean;
}

/** Esc closes the nearest open thing. Stopping the run is the last resort, never a side effect. */
export function escapeAction(state: EscapeState): EscapeAction {
  if (state.handled || state.composing || state.dialogOpen) return "none";
  if (state.findOpen) return "close-find";
  if (state.taskPanelOpen) return "close-tasks";
  return state.viewingRun ? "stop" : "none";
}
