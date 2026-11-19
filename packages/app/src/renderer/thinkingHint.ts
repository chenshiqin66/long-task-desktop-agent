/**
 * Placeholder of the folded main composer while the agent is working.
 * The label is the run phase ("思考中", "执行工具", …); the ellipsis plays on a loop.
 */

export const THINKING_FALLBACK = "思考中";
/** 0 → "思考中", 1 → "思考中…", 2 → "思考中……", then around again. */
export const THINKING_FRAMES = 3;
export const THINKING_FRAME_MS = 450;

/** Phase text like "执行工具…" becomes "执行工具"; the dots are drawn by the animation. */
export function thinkingLabel(status: string | null | undefined): string {
  const label = (status ?? "").replace(/[\s….。]+$/u, "").trim();
  return label || THINKING_FALLBACK;
}

export function thinkingText(label: string, frame: number): string {
  const n = ((Math.trunc(frame) % THINKING_FRAMES) + THINKING_FRAMES) % THINKING_FRAMES;
  return label + "…".repeat(n);
}

export interface ThinkingHint {
  /** Start, or keep playing with a new label. The frame does not restart, so the dots never stutter. */
  show(label: string): void;
  /** Stop the timer. The caller writes the normal placeholder back. */
  hide(): void;
}

export function createThinkingHint(input: HTMLTextAreaElement): ThinkingHint {
  let label = THINKING_FALLBACK;
  let frame = 0;
  let timer: number | null = null;

  const reduced = (): boolean =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const paint = (): void => {
    // Reduced motion: hold the full "思考中……" instead of animating.
    input.placeholder = thinkingText(label, reduced() ? THINKING_FRAMES - 1 : frame);
  };

  return {
    show(next) {
      label = next;
      paint();
      if (timer !== null) return;
      timer = window.setInterval(() => {
        frame = (frame + 1) % THINKING_FRAMES;
        paint();
      }, THINKING_FRAME_MS);
    },
    hide() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      frame = 0;
    },
  };
}
