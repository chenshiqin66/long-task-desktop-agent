import { nativeImage, type BrowserWindow, type NativeImage } from "electron";

import {
  attentionDelay,
  initialAttention,
  reduceAttention,
  type AttentionState,
  type TaskbarIconKind,
} from "./taskbarAttention.js";
import { iconPng } from "./taskbarIcon.js";
import { applyWinTaskbarIcon } from "./taskbarIconWin.js";

/**
 * Swaps the window icon while a permission or ask card is waiting and the
 * user is not looking at it. Window focus is read here; whether the card is
 * on the current page comes from the renderer.
 */
export class TaskbarAlert {
  private state: AttentionState = initialAttention();
  private timer: NodeJS.Timeout | undefined;
  private painted: TaskbarIconKind | null = null;
  private open = false;
  private inView = false;
  private win: BrowserWindow | null = null;
  private readonly icons: Record<TaskbarIconKind, NativeImage>;

  constructor() {
    this.icons = {
      rest: nativeImage.createFromBuffer(iconPng("rest")),
      dim: nativeImage.createFromBuffer(iconPng("dim")),
      lit: nativeImage.createFromBuffer(iconPng("lit")),
    };
    for (const kind of ["rest", "dim", "lit"] as const) {
      if (this.icons[kind].isEmpty()) console.error("taskbar icon empty", kind);
    }
  }

  get restIcon(): NativeImage {
    return this.icons.rest;
  }

  attach(win: BrowserWindow): void {
    this.win = win;
    this.painted = null;
    this.paint();
    if (process.platform !== "win32") return;
    const refresh = () => this.refresh();
    win.on("focus", refresh);
    win.on("blur", refresh);
    win.on("minimize", refresh);
    win.on("closed", () => {
      this.stopTimer();
      this.win = null;
    });
  }

  /** `inView` is true when the waiting card is on the page the user has open. */
  setPrompt(open: boolean, inView: boolean): void {
    this.open = open;
    this.inView = inView;
    this.refresh();
  }

  private shouldAlert(): boolean {
    if (process.platform !== "win32") return false;
    if (!this.open || !this.win || this.win.isDestroyed()) return false;
    const looking = this.win.isFocused() && !this.win.isMinimized() && this.inView;
    return !looking;
  }

  private refresh(): void {
    const next = this.shouldAlert()
      ? reduceAttention(this.state, { type: "need" })
      : reduceAttention(this.state, { type: "clear" });
    this.apply(next);
  }

  private apply(next: AttentionState): void {
    if (next === this.state) return;
    this.state = next;
    this.paint();
    this.arm();
  }

  private paint(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.painted === this.state.show) return;
    this.painted = this.state.show;
    if (applyWinTaskbarIcon(win, this.state.show)) return;
    win.setIcon(this.icons[this.state.show]);
  }

  private arm(): void {
    this.stopTimer();
    const ms = attentionDelay(this.state);
    if (ms == null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.apply(reduceAttention(this.state, { type: "tick" }));
    }, ms);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
