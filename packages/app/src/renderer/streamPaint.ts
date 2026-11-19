/**
 * Throttled painting of a streaming reply. No DOM and no globals, so a plain Node script can test it.
 *
 * Text deltas arrive faster than frames, so the bubble is redrawn at most once per frame from the
 * accumulated buffer. The hazard is that a frame may still be pending when the stream ends or the
 * target changes. Cancelling it would drop whatever arrived since the last paint, and the reply
 * would look cut off even though the stored message is complete. Every path that drops a pending
 * frame therefore paints it first.
 */
export interface StreamPaintState<E> {
  streamBuffer: string;
  streamingEl: E | null;
  /** Pending frame handle, 0 when nothing is scheduled. */
  streamRaf: number;
}

export interface StreamPaintEnv<E> {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  render(el: E, text: string): void;
}

/** Drop the pending frame without painting. Only for callers that are discarding the bubble. */
export function discardStreamPaint<E>(state: StreamPaintState<E>, env: StreamPaintEnv<E>): void {
  if (!state.streamRaf) return;
  env.cancelFrame(state.streamRaf);
  state.streamRaf = 0;
}

/** Schedule a paint of the buffer, or paint it right now when `immediate`. */
export function paintStream<E>(
  state: StreamPaintState<E>,
  env: StreamPaintEnv<E>,
  immediate = false,
): void {
  if (!state.streamingEl) return;
  const paint = () => {
    state.streamRaf = 0;
    if (!state.streamingEl) return;
    env.render(state.streamingEl, state.streamBuffer);
  };
  if (immediate) {
    discardStreamPaint(state, env);
    paint();
    return;
  }
  if (state.streamRaf) return;
  state.streamRaf = env.requestFrame(paint);
}

/** Paint now if a frame is pending, so nothing that was already received stays off screen. */
export function flushStreamPaint<E>(state: StreamPaintState<E>, env: StreamPaintEnv<E>): void {
  if (!state.streamRaf || !state.streamingEl) return;
  paintStream(state, env, true);
}

/** Point the stream at a new bubble (or none). The previous bubble is painted in full first. */
export function resetStreamTarget<E>(
  state: StreamPaintState<E>,
  env: StreamPaintEnv<E>,
  el: E | null = null,
): void {
  flushStreamPaint(state, env);
  discardStreamPaint(state, env);
  state.streamingEl = el;
  state.streamBuffer = "";
}
