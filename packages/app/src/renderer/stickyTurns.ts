/** Whether a folded user bubble should expand again. */
export function shouldReleaseStuck(opts: {
  top: number;
  edge: number;
  one: number;
  scrollTop: number;
}): boolean {
  if (opts.top > opts.edge + Math.max(opts.one, 16)) return true;
  // The first bubble cannot move down past the top, so the usual hysteresis never fires.
  return opts.scrollTop <= 1 && opts.top <= opts.edge + 4;
}
