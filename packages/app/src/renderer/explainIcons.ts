/** Robot and slide-right icons for the explain toggle, title, and collapse control. */

type IconPath = {
  d: string;
  fill: string;
  opacity?: string;
};

export const ROBOT_ICON_VIEWBOX = "0 0 1069 1024";

export const ROBOT_ICON_PATHS: readonly IconPath[] = [
  {
    d: "M534.755556 1001.244444C302.262044 1001.244444 113.777778 822.954667 113.777778 603.022222S302.262044 204.8 534.755556 204.8 955.733333 383.089778 955.733333 603.022222 767.249067 1001.244444 534.755556 1001.244444zM728.177778 455.111111c-202.774756-29.855289-364.088889 0-364.088889 0-71.361422 14.108444-113.777778 73.705244-113.777778 136.533333v22.755556c0 62.850844 50.949689 136.533333 113.777778 136.533333 0 0 168.823467 30.378667 364.088889 0 70.815289-12.014933 113.777778-73.682489 113.777778-136.533333v-22.755556c0-62.828089-44.782933-119.671467-113.777778-136.533333z",
    fill: "#14b8a6",
  },
  {
    d: "M276.115911 52.4288l39.412622-22.755556 136.533334 236.475734-39.412623 22.778311-136.533333-236.498489z",
    fill: "#14b8a6",
  },
  {
    d: "M307.2 79.644444m-79.644444 0a79.644444 79.644444 0 1 0 159.288888 0 79.644444 79.644444 0 1 0-159.288888 0Z",
    fill: "#14b8a6",
  },
  {
    d: "M815.536356 54.135467l-39.913245-23.278934-138.262755 241.891556 39.913244 23.278933 138.262756-241.891555z",
    fill: "#14b8a6",
  },
  {
    d: "M703.2832 81.419378a81.419378 80.713956 90 1 0 161.427911 0 81.419378 80.713956 90 1 0-161.427911 0Z",
    fill: "#14b8a6",
  },
  {
    d: "M113.777778 455.111111s-108.384711 6.257778-113.777778 113.777778v91.022222s17.954133 106.723556 113.777778 91.022222c0 0-71.293156-139.628089 0-295.822222zM955.733333 455.111111s108.384711 6.235022 113.777778 113.231645v90.589866s-17.954133 106.222933-113.777778 90.589867c0 0 71.293156-138.968178 0-294.411378zM409.6 568.888889a45.511111 45.511111 0 1 1 0.022756 90.999467A45.511111 45.511111 0 0 1 409.6 568.888889z",
    fill: "#14b8a6",
  },
  {
    d: "M682.666667 614.4m-68.266667 0a68.266667 68.266667 0 1 0 136.533333 0 68.266667 68.266667 0 1 0-136.533333 0Z",
    fill: "#14b8a6",
  },
];

export const SLIDE_RIGHT_ICON_VIEWBOX = "0 0 1024 1024";

export const SLIDE_RIGHT_ICON_PATHS: readonly IconPath[] = [
  {
    d: "M341.333333 341.333333c-94.250667 0-170.666667 76.416-170.666666 170.666667s76.416 170.666667 170.666666 170.666667c14.734222 0 29.027556-1.863111 42.666667-5.376-73.614222-18.944-128-85.76-128-165.290667s54.385778-146.346667 128-165.290667A170.908444 170.908444 0 0 0 341.333333 341.333333z",
    fill: "#14b8a6",
    opacity: ".2",
  },
  {
    d: "M341.333333 512a170.666667 170.666667 0 1 0 341.333334 0 170.666667 170.666667 0 1 0-341.333334 0Z",
    fill: "#14b8a6",
  },
  {
    d: "M426.666667 341.333333c-94.250667 0-170.666667 76.416-170.666667 170.666667s76.416 170.666667 170.666667 170.666667c14.734222 0 29.027556-1.863111 42.666666-5.376-73.614222-18.944-128-85.76-128-165.290667s54.385778-146.346667 128-165.290667A170.908444 170.908444 0 0 0 426.666667 341.333333z",
    fill: "#14b8a6",
    opacity: ".4",
  },
  {
    d: "M609.991111 522.666667l-49.493333 42.808889c-9.102222 7.964444-23.466667 1.422222-23.466667-10.808889v-85.475556c0-12.231111 14.364444-18.773333 23.466667-10.808889l49.493333 42.808889c6.542222 5.688889 6.542222 15.786667 0 21.475556z",
    fill: "#FFFFFF",
  },
  {
    d: "M579.754667 526.222222v-28.444444h-71.111111v28.444444zM480.199111 526.222222v-28.444444h-42.666667v28.444444zM423.310222 526.293333v-28.444444h-14.222222v28.444444z",
    fill: "#FFFFFF",
  },
];

export function paintExplainIcons(root: ParentNode = document): void {
  const toggle = root.querySelector("#explain-toggle");
  if (toggle instanceof HTMLButtonElement) paintIconButton(toggle, "robot", "解释");
  const title = root.querySelector(".explain-title");
  if (title instanceof HTMLElement) paintExplainTitle(title);
  const collapse = root.querySelector("#explain-collapse");
  if (collapse instanceof HTMLButtonElement) paintIconButton(collapse, "slide-right", "收起");
}

function paintIconButton(btn: HTMLButtonElement, kind: "robot" | "slide-right", label: string): void {
  btn.setAttribute("aria-label", label);
  if (btn.querySelector(`svg[data-kind="${kind}"]`) && btn.childElementCount === 1) return;
  btn.replaceChildren(iconSvg(kind));
}

function paintExplainTitle(el: HTMLElement): void {
  if (el.querySelector('svg[data-kind="robot"]')) return;
  const label = document.createElement("span");
  label.className = "sr-only";
  label.textContent = "答案解释";
  el.replaceChildren(iconSvg("robot"), label);
}

function iconSvg(kind: "robot" | "slide-right"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", kind === "robot" ? ROBOT_ICON_VIEWBOX : SLIDE_RIGHT_ICON_VIEWBOX);
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.kind = kind;
  const paths = kind === "robot" ? ROBOT_ICON_PATHS : SLIDE_RIGHT_ICON_PATHS;
  for (const entry of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", entry.d);
    path.setAttribute("fill", entry.fill);
    if (entry.opacity) path.setAttribute("fill-opacity", entry.opacity);
    svg.append(path);
  }
  return svg;
}
