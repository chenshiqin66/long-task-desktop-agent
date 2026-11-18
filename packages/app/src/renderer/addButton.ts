/** Circular plus icon used by page “添加” buttons and the workspace add control. */

export const ADD_ICON_PATHS = [
  "M256 512a32 32 0 0 1 32-32h448a32 32 0 1 1 0 64h-448A32.64 32.64 0 0 1 256 512z",
  "M480 288a32 32 0 1 1 64 0v448a32 32 0 1 1-64 0z",
  "M512 0a512 512 0 1 0 512 512 512 512 0 0 0-512-512z m0 960a448 448 0 1 1 448-448 448 448 0 0 1-448 448z",
] as const;

export function paintAddButton(btn: HTMLButtonElement): void {
  if (btn.querySelector('svg[data-kind="add"]') && btn.childElementCount === 1) return;
  btn.replaceChildren(addIconSvg());
}

export function paintAddButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>("button.btn-add-icon").forEach(paintAddButton);
}

function addIconSvg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.kind = "add";
  for (const d of ADD_ICON_PATHS) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
