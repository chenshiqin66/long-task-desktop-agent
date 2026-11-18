/** Drag the top-right grip to change an expanded composer textarea height. */

export const COMPOSER_INPUT_MIN = 43;
export const COMPOSER_INPUT_MAX = 108;

export function composerResizeHeight(
  startHeight: number,
  startY: number,
  currentY: number,
  min = COMPOSER_INPUT_MIN,
  max = COMPOSER_INPUT_MAX,
): number {
  return Math.round(Math.min(max, Math.max(min, startHeight + (startY - currentY))));
}

export function attachComposerResize(
  composer: HTMLElement,
  input: HTMLTextAreaElement,
  handle: HTMLElement,
): void {
  let startY = 0;
  let startHeight = 0;

  const onMove = (event: PointerEvent): void => {
    input.style.height = `${composerResizeHeight(startHeight, startY, event.clientY)}px`;
  };

  const onUp = (event: PointerEvent): void => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || composer.classList.contains("is-compact")) return;
    event.preventDefault();
    startY = event.clientY;
    startHeight = input.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}
