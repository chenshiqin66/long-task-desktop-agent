/** What an in-app drag carries to the explain pane. main.ts puts it on drags that start in the transcripts. */
export const EXPLAIN_DRAG_MIME = "application/x-csq-explain";

/** Same limit as `MAX_SELECTION` in electron/browserPolicy.ts; a test compares them. */
export const MAX_DROPPED = 4000;

/** The part of a drag the browser's explain pane looks at. */
export interface DragLike {
  types: ArrayLike<string>;
  getData(type: string): string;
}

function has(types: ArrayLike<string>, type: string): boolean {
  for (let i = 0; i < types.length; i++) {
    if (types[i] === type) return true;
  }
  return false;
}

/**
 * Whether text dragged in from outside the app's own DOM (the page in the browser view, another program)
 * should be taken. Files are not text. Drags that main.ts already handles are left to it, or the text
 * would be asked twice. A drop into a text field is the field's own business.
 */
export function canDropText(types: ArrayLike<string> | undefined, intoField: boolean): boolean {
  if (!types || intoField) return false;
  if (has(types, "Files") || has(types, EXPLAIN_DRAG_MIME)) return false;
  return has(types, "text/plain");
}

/** Trimmed and cut to MAX_DROPPED code points, like a selection made in the browser. */
export function clipDropped(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return "";
  const points = Array.from(text);
  return points.length > MAX_DROPPED ? points.slice(0, MAX_DROPPED).join("") : text;
}

/** The text to explain, or null when this drop is not for the pane. */
export function droppedText(drag: DragLike | null | undefined, intoField: boolean): string | null {
  if (!drag || !canDropText(drag.types, intoField)) return null;
  return clipDropped(drag.getData("text/plain")) || null;
}
