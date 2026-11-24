/** In-app preview for images and videos in a conversation panel. Never opens a system viewer. */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
export const ZOOM_FACTOR = 1.25;

/** Media in one conversation panel, in document order (top-to-bottom, left-to-right). */
export const PANEL_MEDIA_SELECTOR = ".msg-images img, .msg-videos video";

const NON_TYPING_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "hidden",
  "range",
  "color",
]);

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? current * ZOOM_FACTOR : current / ZOOM_FACTOR);
}

/** Adjacent media in the panel list. Wraps at the ends. `null` when there is at most one item. */
export function neighborIndex(index: number, delta: number, count: number): number | null {
  if (count <= 1) return null;
  return (((index + delta) % count) + count) % count;
}

/** True when Left/Right (and zoom keys) should be left to a text field. */
export function typingTargetBlocksViewerKeys(
  tagName: string,
  options?: { type?: string; contentEditable?: boolean },
): boolean {
  if (options?.contentEditable) return true;
  const tag = tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (options?.type || "text").toLowerCase();
    return !NON_TYPING_INPUT_TYPES.has(type);
  }
  return false;
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target instanceof HTMLElement ? target : null;
  if (
    el &&
    typingTargetBlocksViewerKeys(el.tagName, {
      type: el instanceof HTMLInputElement ? el.type : undefined,
      contentEditable: el.isContentEditable,
    })
  ) {
    return true;
  }
  const host = target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
  if (!(host instanceof HTMLElement)) return false;
  return typingTargetBlocksViewerKeys(host.tagName, {
    type: host instanceof HTMLInputElement ? host.type : undefined,
    contentEditable: host.isContentEditable,
  });
}

export type ViewerMedia = HTMLImageElement | HTMLVideoElement;

/** True for Control+C / Command+C, and not for Shift/Alt/composition variants. */
export function isCopyImageShortcut(ev: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (ev.isComposing) return false;
  if (ev.altKey || ev.shiftKey) return false;
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  return ev.key.length === 1 && ev.key.toLowerCase() === "c";
}

/**
 * When the viewer is open on an image, copy even if leftover text is selected.
 * When it is closed, only copy a focused transcript image if there is no text selection.
 */
export function shouldHandleCopyImageShortcut(opts: {
  viewerOpen: boolean;
  inEditable: boolean;
  hasTextSelection: boolean;
  currentIsImage: boolean;
}): boolean {
  if (opts.inEditable || !opts.currentIsImage) return false;
  if (opts.viewerOpen) return true;
  return !opts.hasTextSelection;
}

/** Image under a conversation thumbnail, image button, or focused descendant. */
export function conversationImageFromTarget(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLImageElement && target.closest(".msg-images")) return target;
  const btn = target.closest(".msg-image-btn");
  if (btn instanceof HTMLElement && btn.closest(".msg-images")) {
    const img = btn.querySelector("img");
    if (img instanceof HTMLImageElement) return img;
  }
  const img = target.closest(".msg-images img");
  return img instanceof HTMLImageElement ? img : null;
}

/** Images and videos in the same `.messages` panel as `from`, in document order. */
export function listPanelMedia(from: Element): ViewerMedia[] {
  const panel = from.closest(".messages") ?? from.closest(".msg");
  if (!panel) return isViewerMedia(from) ? [from] : [];
  return Array.from(panel.querySelectorAll(PANEL_MEDIA_SELECTOR)).filter(isViewerMedia);
}

function isViewerMedia(node: Element): node is ViewerMedia {
  return node instanceof HTMLImageElement || node instanceof HTMLVideoElement;
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

/** Size of the image at zoom 1 so the whole picture fits in the stage. */
export function fitContain(
  stageW: number,
  stageH: number,
  natW: number,
  natH: number,
): { width: number; height: number } {
  if (stageW <= 0 || stageH <= 0 || natW <= 0 || natH <= 0) return { width: 0, height: 0 };
  const scale = Math.min(stageW / natW, stageH / natH);
  return { width: natW * scale, height: natH * scale };
}

/** Keep the image from being panned completely out of the stage. */
export function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  fitW: number,
  fitH: number,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (fitW * zoom - stageW) / 2);
  const maxY = Math.max(0, (fitH * zoom - stageH) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, panX)),
    y: Math.min(maxY, Math.max(-maxY, panY)),
  };
}

let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let imageEl: HTMLImageElement | null = null;
let videoEl: HTMLVideoElement | null = null;
let btnPrev: HTMLButtonElement | null = null;
let btnNext: HTMLButtonElement | null = null;
let btnZoomIn: HTMLButtonElement | null = null;
let btnZoomOut: HTMLButtonElement | null = null;
let btnReset: HTMLButtonElement | null = null;
let btnClose: HTMLButtonElement | null = null;
let btnSave: HTMLButtonElement | null = null;
let btnCopy: HTMLButtonElement | null = null;
let siblings: ViewerMedia[] = [];
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

export type ImageViewerHooks = {
  onSave?: (media: ViewerMedia) => void;
  onCopy?: (media: HTMLImageElement) => void;
};

let hooks: ImageViewerHooks = {};

export function isImageViewerOpen(): boolean {
  return Boolean(root && !root.hidden);
}

export function installImageViewer(next?: ImageViewerHooks): void {
  if (next) hooks = next;
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

  videoEl = document.createElement("video");
  videoEl.className = "image-viewer-img image-viewer-video";
  videoEl.controls = true;
  videoEl.preload = "metadata";
  videoEl.playsInline = true;
  videoEl.hidden = true;

  stage.append(imageEl, videoEl);

  const toolbar = document.createElement("div");
  toolbar.className = "image-viewer-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "图片工具");

  btnPrev = toolButton("上一张", "上一张");
  btnZoomOut = toolButton("缩小", "缩小");
  btnReset = toolButton("复位", "复位");
  btnZoomIn = toolButton("放大", "放大");
  btnNext = toolButton("下一张", "下一张");
  btnSave = toolButton("保存", "保存");
  btnCopy = toolButton("复制", "复制");
  btnClose = toolButton("关闭", "关闭");
  btnClose.classList.add("image-viewer-close");
  toolbar.append(btnPrev, btnZoomOut, btnReset, btnZoomIn, btnNext, btnSave, btnCopy, btnClose);

  root.append(backdrop, stage, toolbar);
  document.body.append(root);

  backdrop.addEventListener("click", () => closeViewer());
  stage.addEventListener("click", (ev) => {
    if (moved || zoom > 1) return;
    if (ev.target === stage) closeViewer();
  });
  btnClose.addEventListener("click", () => closeViewer());
  btnZoomIn.addEventListener("click", () => applyZoom(stepZoom(zoom, 1), false, 0, 0));
  btnZoomOut.addEventListener("click", () => applyZoom(stepZoom(zoom, -1), false, 0, 0));
  btnReset.addEventListener("click", () => applyZoom(1, true));
  btnPrev.addEventListener("click", () => showNeighbor(-1));
  btnNext.addEventListener("click", () => showNeighbor(1));
  btnSave.addEventListener("click", () => {
    const media = visibleMediaEl();
    if (media) hooks.onSave?.(media);
  });
  btnCopy.addEventListener("click", () => copyVisibleImage());
  imageEl.addEventListener("load", () => {
    if (!isImageViewerOpen() || imageEl?.hidden) return;
    paintTransform();
  });
  videoEl.addEventListener("loadedmetadata", () => {
    if (!isImageViewerOpen() || videoEl?.hidden) return;
    paintTransform();
  });
  window.addEventListener("resize", () => {
    if (!isImageViewerOpen()) return;
    paintTransform();
  });

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

function hasCopyableTextSelection(): boolean {
  const sel = window.getSelection();
  return Boolean(sel && !sel.isCollapsed && sel.toString());
}

function currentCopyImage(target: EventTarget | null): HTMLImageElement | null {
  if (isImageViewerOpen()) {
    const media = visibleMediaEl();
    if (media instanceof HTMLImageElement && !media.hidden) return media;
    return null;
  }
  return conversationImageFromTarget(target) ?? conversationImageFromTarget(document.activeElement);
}

function copyVisibleImage(): void {
  const media = visibleMediaEl();
  if (media instanceof HTMLImageElement && !media.hidden) hooks.onCopy?.(media);
}

function onWindowKey(ev: KeyboardEvent): void {
  if (isCopyImageShortcut(ev)) {
    if (isEditableKeyTarget(ev.target)) return;
    const image = currentCopyImage(ev.target);
    if (
      !shouldHandleCopyImageShortcut({
        viewerOpen: isImageViewerOpen(),
        inEditable: false,
        hasTextSelection: hasCopyableTextSelection(),
        currentIsImage: Boolean(image),
      })
    ) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (image) hooks.onCopy?.(image);
    return;
  }
  if (!isImageViewerOpen()) return;
  if (ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeViewer();
    return;
  }
  if (isEditableKeyTarget(ev.target)) return;
  if (ev.key === "+" || ev.key === "=") {
    ev.preventDefault();
    applyZoom(stepZoom(zoom, 1), false, 0, 0);
    return;
  }
  if (ev.key === "-") {
    ev.preventDefault();
    applyZoom(stepZoom(zoom, -1), false, 0, 0);
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

function openViewer(media: ViewerMedia, trigger: HTMLElement): void {
  ensureRoot();
  siblings = listPanelMedia(media);
  index = Math.max(0, siblings.indexOf(media));
  restoreFocus = trigger;
  root!.hidden = false;
  showCurrent();
  applyZoom(1, true);
  btnClose?.focus();
}

function showNeighbor(delta: number): void {
  const next = neighborIndex(index, delta, siblings.length);
  if (next == null) return;
  index = next;
  showCurrent();
  applyZoom(1, true);
}

function visibleMediaEl(): ViewerMedia | null {
  if (videoEl && !videoEl.hidden) return videoEl;
  if (imageEl && !imageEl.hidden) return imageEl;
  return imageEl;
}

function clearMediaLayout(el: HTMLImageElement | HTMLVideoElement | null): void {
  if (!el) return;
  el.style.transform = "";
  el.style.width = "";
  el.style.height = "";
  el.style.maxWidth = "";
  el.style.maxHeight = "";
}

function stopVideo(): void {
  if (!videoEl) return;
  videoEl.pause();
  if (videoEl.getAttribute("src")) {
    videoEl.removeAttribute("src");
    videoEl.load();
  }
}

function showCurrent(): void {
  const srcMedia = siblings[index];
  if (!imageEl || !videoEl || !srcMedia) return;
  if (srcMedia instanceof HTMLVideoElement) {
    imageEl.hidden = true;
    imageEl.removeAttribute("src");
    clearMediaLayout(imageEl);
    videoEl.hidden = false;
    const nextSrc = srcMedia.currentSrc || srcMedia.src;
    if (videoEl.getAttribute("src") !== nextSrc) {
      videoEl.pause();
      videoEl.src = nextSrc;
    }
    copyMediaMeta(videoEl, srcMedia);
    syncNav();
    if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) paintTransform();
    return;
  }
  stopVideo();
  videoEl.hidden = true;
  clearMediaLayout(videoEl);
  imageEl.hidden = false;
  const nextSrc = srcMedia.currentSrc || srcMedia.src;
  if (imageEl.getAttribute("src") !== nextSrc) imageEl.src = nextSrc;
  imageEl.alt = srcMedia.alt || "附件图片";
  copyMediaMeta(imageEl, srcMedia);
  syncNav();
  if (imageEl.complete && imageEl.naturalWidth > 0) paintTransform();
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

function mediaNaturalSize(el: ViewerMedia): { width: number; height: number } {
  if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight };
  return { width: el.naturalWidth, height: el.naturalHeight };
}

function paintTransform(): void {
  const media = visibleMediaEl();
  if (!media || !stage) return;
  const nat = mediaNaturalSize(media);
  const fit = fitContain(stage.clientWidth, stage.clientHeight, nat.width, nat.height);
  if (fit.width > 0 && fit.height > 0) {
    const pan = clampPan(
      panX,
      panY,
      zoom,
      fit.width,
      fit.height,
      stage.clientWidth,
      stage.clientHeight,
    );
    panX = pan.x;
    panY = pan.y;
    media.style.maxWidth = "none";
    media.style.maxHeight = "none";
    media.style.width = `${fit.width}px`;
    media.style.height = `${fit.height}px`;
  }
  media.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  stage.classList.toggle("is-panning", zoom > 1);
}

function syncZoomButtons(): void {
  if (btnZoomIn) btnZoomIn.disabled = zoom >= ZOOM_MAX;
  if (btnZoomOut) btnZoomOut.disabled = zoom <= ZOOM_MIN;
  if (btnReset) btnReset.disabled = zoom === 1 && panX === 0 && panY === 0;
}

function copyMediaMeta(target: HTMLElement, source: HTMLElement): void {
  for (const key of ["mediaPath", "mediaSession", "mediaWorkspace"] as const) {
    const value = source.dataset[key];
    if (value) target.dataset[key] = value;
    else delete target.dataset[key];
  }
}

function syncNav(): void {
  const many = siblings.length > 1;
  if (btnPrev) {
    btnPrev.hidden = !many;
    btnPrev.disabled = !many;
  }
  if (btnNext) {
    btnNext.hidden = !many;
    btnNext.disabled = !many;
  }
  if (btnCopy) {
    const show = Boolean(imageEl && !imageEl.hidden);
    btnCopy.hidden = !show;
    btnCopy.disabled = !show;
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
  stopVideo();
  if (videoEl) {
    videoEl.hidden = true;
    clearMediaLayout(videoEl);
  }
  if (imageEl) {
    imageEl.hidden = false;
    imageEl.removeAttribute("src");
    clearMediaLayout(imageEl);
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
