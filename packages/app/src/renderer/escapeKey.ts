/** What the window-level Esc handler does. */
export type EscapeAction =
  | "none"
  | "close-workbench"
  | "close-find"
  | "close-tasks"
  | "close-library-form"
  | "close-library"
  | "stop";

export interface EscapeState {
  /** Another handler already used this Esc: the rename box, the skill menu, the context menu. */
  handled: boolean;
  /** An IME composition is open; Esc cancels the composition. */
  composing: boolean;
  /** A modal dialog closes itself on Esc. */
  dialogOpen: boolean;
  /** The workbench sheet covers the window. */
  workbenchOpen: boolean;
  /** The main find bar or the explain pane's find bar. */
  findOpen: boolean;
  taskPanelOpen: boolean;
  /** A Cancel form is open inside the current library page (连接 / 模型 / 记忆编辑). */
  libraryFormOpen: boolean;
  /** One of 连接 / 技能 / 记忆 / 模型 is covering the stage. */
  libraryOpen: boolean;
  /** A turn is running on the session on screen. */
  viewingRun: boolean;
}

/** Esc closes the nearest open thing. Stopping the run is the last resort, never a side effect. */
export function escapeAction(state: EscapeState): EscapeAction {
  if (state.handled || state.composing || state.dialogOpen) return "none";
  if (state.workbenchOpen) return "close-workbench";
  if (state.findOpen) return "close-find";
  if (state.taskPanelOpen) return "close-tasks";
  // Same as clicking 取消 on the in-page form; a second Esc then closes the library.
  if (state.libraryFormOpen) return "close-library-form";
  // Same as clicking the pale-green 连接/技能/记忆/模型 button again.
  if (state.libraryOpen) return "close-library";
  return state.viewingRun ? "stop" : "none";
}
