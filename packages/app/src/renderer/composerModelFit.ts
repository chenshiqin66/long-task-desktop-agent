/** Size composer model selects to the selected label, or the longest label when open. */

const OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " ", "Spacebar"]);

export function composerModelLabels(optionTexts: string[], selectedText: string, open: boolean): string[] {
  return open ? optionTexts : [selectedText];
}

export function composerModelFitWidth(textWidth: number, extra: number, maxWidth?: number): number {
  const raw = Math.ceil(Math.max(0, textWidth) + Math.max(0, extra) + 1);
  if (maxWidth !== undefined && maxWidth > 0) return Math.max(1, Math.min(raw, Math.floor(maxWidth)));
  return raw;
}

export function shouldOpenComposerModelOnKey(key: string, altKey = false): boolean {
  return altKey || OPEN_KEYS.has(key);
}

export function fitComposerModelSelect(select: HTMLSelectElement, open = false): void {
  if (select.hidden) {
    select.style.width = "";
    return;
  }
  const labels = composerModelLabels(
    Array.from(select.options, (option) => option.textContent ?? ""),
    select.selectedOptions[0]?.textContent ?? "",
    open,
  );
  applyComposerModelWidth(select, labels);
}

export function fitComposerModelEmpty(btn: HTMLButtonElement): void {
  if (btn.hidden) {
    btn.style.width = "";
    return;
  }
  applyComposerModelWidth(btn, [btn.textContent?.trim() ?? ""]);
}

export function attachComposerModelSizing(select: HTMLSelectElement): void {
  const expand = (): void => {
    fitComposerModelSelect(select, true);
  };
  const collapse = (): void => {
    fitComposerModelSelect(select, false);
  };
  select.addEventListener("pointerdown", expand);
  select.addEventListener("keydown", (event) => {
    if (shouldOpenComposerModelOnKey(event.key, event.altKey)) expand();
  });
  select.addEventListener("change", collapse);
  select.addEventListener("blur", collapse);
}

function applyComposerModelWidth(el: HTMLElement, labels: string[]): void {
  const style = getComputedStyle(el);
  const extra =
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.borderRightWidth);
  const textWidth = labels.reduce((max, label) => Math.max(max, measureLabel(label, style)), 0);
  el.style.width = `${composerModelFitWidth(textWidth, extra, maxFitWidth(el))}px`;
}

function measureLabel(text: string, style: CSSStyleDeclaration): number {
  const probe = labelProbe();
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.fontSize = style.fontSize;
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontWeight = style.fontWeight;
  probe.textContent = text || "";
  return probe.getBoundingClientRect().width;
}

function maxFitWidth(el: HTMLElement): number | undefined {
  const composer = el.closest("#composer, #explain-composer") as HTMLElement | null;
  if (!composer) return undefined;
  const send = composer.querySelector("#btn-send, #explain-send") as HTMLElement | null;
  const styles = getComputedStyle(composer);
  const pad = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const sendWidth = send?.getBoundingClientRect().width ?? 28;
  const available = composer.getBoundingClientRect().width - pad - sendWidth - 8;
  return available > 0 ? available : undefined;
}

let probeEl: HTMLSpanElement | null = null;

function labelProbe(): HTMLSpanElement {
  if (probeEl?.isConnected) return probeEl;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;pointer-events:none;";
  document.body.append(probe);
  probeEl = probe;
  return probe;
}
