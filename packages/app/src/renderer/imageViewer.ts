/** In-app preview for images in a conversation bubble. Never opens a system viewer. */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
export const ZOOM_FACTOR = 1.25;

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? current * ZOOM_FACTOR : current / ZOOM_FACTOR);
}

/** Adjacent image in the same `.msg-images` row. `null` at either end. */
export function neighborIndex(index: number, delta: number, count: number): number | null {
  if (count <= 0) return null;
  const next = index + delta;
  if (next < 0 || next >= count) return null;
  return next;
}

/** Keep the point under the pointer still while the scale changes. Offsets are from the image center. */
export function panAfterZoom(
  panX: number,
  panY: number,
  zoom: number,
  nextZoom: number,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  if (zoom === 0 || nextZoom === 1) return { x: 0, y: 0 };
  const factor = nextZoom / zoom;
  return {
    x: offsetX - (offsetX - panX) * factor,
    y: offsetY - (offsetY - panY) * factor,
  };
}

let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let imageEl: HTMLImageElement | null = null;
let btnPrev: HTMLButtonElement | null = null;
let btnNext: HTMLButtonElement | null = null;
let btnZoomIn: HTMLButtonElement | null = null;
let btnZoomOut: HTMLButtonElement | null = null;
let btnReset: HTMLButtonElement | null = null;
let btnClose: HTMLButtonElement | null = null;
let siblings: HTMLImageElement[] = [];
let index = 0;
let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let moved = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;
let restoreFocus: HTMLElement | null = null;
let installed = false;

export function isImageViewerOpen(): boolean {
  return Boolean(root && !root.hidden);
}

export function installImageViewer(): void {
  if (installed) return;
  installed = true;
  ensureRoot();
  document.addEventListener("click", onThumbnailClick);
  window.addEventListener("keydown", onWindowKey, true);
}

function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.createElement("div");
  root.className = "image-viewer";
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "查看图片");

  const backdrop = document.createElement("div");
  backdrop.className = "image-viewer-backdrop";

  stage = document.createElement("div");
  stage.className = "image-viewer-stage";

  imageEl = document.createElement("img");
  imageEl.className = "image-viewer-img";
  imageEl.alt = "附件图片";
  imageEl.draggable = false;
  stage.append(imageEl);

  const toolbar = document.createElement("div");
  toolbar.className = "image-viewer-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "图片工具");

  btnPrev = toolButton("上一张", "上一张");
  btnZoomOut = toolButton("缩小", "缩小");
  btnReset = toolButton("复位", "复位");
  btnZoomIn = toolButton("放大", "放大");
  btnNext = toolButton("下一张", "下一张");
  btnClose = toolButton("关闭", "关闭");
  btnClose.classList.add("image-viewer-close");
  toolbar.append(btnPrev, btnZoomOut, btnReset, btnZoomIn, btnNext, btnClose);

  root.append(backdrop, stage, toolbar);
  document.body.append(root);

  backdrop.addEventListener("click", () => closeViewer());
  stage.addEventListener("click", (ev) => {
    if (moved || zoom > 1) return;
    if (ev.target === stage) closeViewer();
  });
  btnClose.addEventListener("click", () => closeViewer());
  btnZoomIn.addEventListener("click", () => applyZoom(stepZoom(zoom, 1)));
  btnZoomOut.addEventListener("click", () => applyZoom(stepZoom(zoom, -1)));
  btnReset.addEventListener("click", () => applyZoom(1, true));
  btnPrev.addEventListener("click", () => showNeighbor(-1));
  btnNext.addEventListener("click", () => showNeighbor(1));

  stage.addEventListener(
    "wheel",
    (ev) => {
      if (!isImageViewerOpen()) return;
      ev.preventDefault();
      const next = stepZoom(zoom, ev.deltaY < 0 ? 1 : -1);
      const rect = stage!.getBoundingClientRect();
      const offsetX = ev.clientX - (rect.left + rect.width / 2);
      const offsetY = ev.clientY - (rect.top + rect.height / 2);
      applyZoom(next, false, offsetX, offsetY);
    },
    { passive: false },
  );

  stage.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  return root;
}

function toolButton(label: string, ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "image-viewer-btn";
  btn.textContent = label;
  btn.setAttribute("aria-label", ariaLabel);
  return btn;
}

function onThumbnailClick(ev: MouseEvent): void {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  if (root && root.contains(target)) return;
  const btn = target.closest(".msg-image-btn");
  if (!(btn instanceof HTMLElement) || !btn.closest(".msg-images")) return;
  const img = btn.querySelector("img");
  if (!(img instanceof HTMLImageElement)) return;
  ev.preventDefault();
  openViewer(img, btn);
}

function onWindowKey(ev: KeyboardEvent): void {
  if (!isImageViewerOpen()) return;
  if (ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeViewer();
    return;
  }
  if (ev.key === "+" || ev.key === "=") {
    ev.preventDefault();
    applyZoom(stepZoom(zoom, 1));
    return;
  }
  if (ev.key === "-") {
    ev.preventDefault();
    applyZoom(stepZoom(zoom, -1));
    return;
  }
  if (ev.key === "0") {
    ev.preventDefault();
    applyZoom(1, true);
    return;
  }
  if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    showNeighbor(-1);
    return;
  }
  if (ev.key === "ArrowRight") {
    ev.preventDefault();
    showNeighbor(1);
  }
}

function openViewer(img: HTMLImageElement, trigger: HTMLElement): void {
  ensureRoot();
  const row = img.closest(".msg-images");
  siblings = row ? Array.from(row.querySelectorAll("img")) : [img];
  index = Math.max(0, siblings.indexOf(img));
  restoreFocus = trigger;
  root!.hidden = false;
  applyZoom(1, true);
  showCurrent();
  btnClose?.focus();
}

function showNeighbor(delta: number): void {
  const next = neighborIndex(index, delta, siblings.length);
  if (next == null) return;
  index = next;
  applyZoom(1, true);
  showCurrent();
}

function showCurrent(): void {
  const srcImg = siblings[index];
  if (!imageEl || !srcImg) return;
  imageEl.src = srcImg.currentSrc || srcImg.src;
  imageEl.alt = srcImg.alt || "附件图片";
  syncNav();
}

function applyZoom(next: number, resetPan = false, offsetX?: number, offsetY?: number): void {
  const clamped = clampZoom(next);
  if (resetPan || clamped === 1) {
    panX = 0;
    panY = 0;
  } else if (offsetX != null && offsetY != null) {
    const pan = panAfterZoom(panX, panY, zoom, clamped, offsetX, offsetY);
    panX = pan.x;
    panY = pan.y;
  }
  zoom = clamped;
  paintTransform();
  syncZoomButtons();
}

function paintTransform(): void {
  if (!imageEl || !stage) return;
  imageEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  stage.classList.toggle("is-panning", zoom > 1);
}

function syncZoomButtons(): void {
  if (btnZoomIn) btnZoomIn.disabled = zoom >= ZOOM_MAX;
  if (btnZoomOut) btnZoomOut.disabled = zoom <= ZOOM_MIN;
  if (btnReset) btnReset.disabled = zoom === 1 && panX === 0 && panY === 0;
}

function syncNav(): void {
  const many = siblings.length > 1;
  if (btnPrev) {
    btnPrev.hidden = !many;
    btnPrev.disabled = neighborIndex(index, -1, siblings.length) == null;
  }
  if (btnNext) {
    btnNext.hidden = !many;
    btnNext.disabled = neighborIndex(index, 1, siblings.length) == null;
  }
}

function onPointerDown(ev: PointerEvent): void {
  if (!isImageViewerOpen() || zoom <= 1 || ev.button !== 0) return;
  dragging = true;
  moved = false;
  dragStartX = ev.clientX;
  dragStartY = ev.clientY;
  panStartX = panX;
  panStartY = panY;
  stage?.classList.add("is-dragging");
  stage?.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging) return;
  const dx = ev.clientX - dragStartX;
  const dy = ev.clientY - dragStartY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
  panX = panStartX + dx;
  panY = panStartY + dy;
  paintTransform();
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  stage?.classList.remove("is-dragging");
  if (stage?.hasPointerCapture(ev.pointerId)) stage.releasePointerCapture(ev.pointerId);
  syncZoomButtons();
  window.setTimeout(() => {
    moved = false;
  }, 0);
}

export function closeViewer(): void {
  if (!root || root.hidden) return;
  dragging = false;
  moved = false;
  stage?.classList.remove("is-dragging", "is-panning");
  root.hidden = true;
  if (imageEl) {
    imageEl.removeAttribute("src");
    imageEl.style.transform = "";
  }
  const back = restoreFocus;
  restoreFocus = null;
  siblings = [];
  index = 0;
  zoom = 1;
  panX = 0;
  panY = 0;
  if (back?.isConnected) back.focus();
}
