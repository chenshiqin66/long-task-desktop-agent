/** Composer send / stop icon button. Paths come from the icons the user supplied. */

export type SendButtonMode = "send" | "stop" | "stopping" | "answer";

export const SEND_ICON_PATH =
  "M512 0a512 512 0 1 0 0 1024A512 512 0 0 0 512 0z m256.704 489.664a28.224 28.224 0 0 1-39.872 0L540.096 300.928v489.664a28.16 28.16 0 1 1-56.256 0.384V300.992L295.104 489.664a28.48 28.48 0 0 1-39.808 0 28.48 28.48 0 0 1 0-39.808l236.8-236.8a28.544 28.544 0 0 1 39.808 0l236.8 236.8a28.48 28.48 0 0 1 0 39.808z";

export const STOP_ICON_PATH =
  "M512.085642 1023.939139c-279.049295-1.251342-511.23014-229.109369-512.026448-511.91269-0.796309-282.746443 229.223127-512.026449 511.969569-512.026449a512.026449 512.026449 0 0 1 511.96957 512.026449c0 282.803322-259.14158 513.050274-511.912691 511.91269z m175.984208-639.890863a48.006035 48.006035 0 0 0-48.006035-48.006034h-255.956345a48.062914 48.062914 0 0 0-48.006035 48.006034v255.956345c0 26.505702 21.557212 48.006035 48.006035 48.006035h255.956345a48.006035 48.006035 0 0 0 48.006035-48.006035v-255.956345z";

export function sendButtonLabel(
  mode: SendButtonMode,
  enabled = true,
  sendNoun = "发送",
): string {
  if (mode === "answer") return "回答";
  if (mode === "stopping") return "正在停止";
  if (mode === "stop") return "停止";
  return enabled ? sendNoun : `${sendNoun}已禁用`;
}

export function sendIconKind(mode: SendButtonMode): "send" | "stop" | null {
  if (mode === "send") return "send";
  if (mode === "stop" || mode === "stopping") return "stop";
  return null;
}

export function paintSendButton(
  btn: HTMLButtonElement,
  mode: SendButtonMode,
  opts?: { sendNoun?: string },
): void {
  const enabled = !btn.disabled && mode !== "stopping";
  const label = sendButtonLabel(mode, enabled, opts?.sendNoun ?? "发送");
  btn.classList.toggle("is-stop", mode === "stop");
  btn.classList.toggle("is-stopping", mode === "stopping");
  btn.classList.toggle("is-answer", mode === "answer");
  btn.setAttribute("aria-label", label);
  const kind = sendIconKind(mode);
  if (kind == null) {
    if (btn.textContent !== "回答") btn.textContent = "回答";
    return;
  }
  const existing = btn.querySelector("svg");
  if (existing instanceof SVGElement && existing.dataset.kind === kind && btn.childElementCount === 1) return;
  btn.replaceChildren(iconSvg(kind));
}

function iconSvg(kind: "send" | "stop"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.kind = kind;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "send" ? SEND_ICON_PATH : STOP_ICON_PATH);
  svg.append(path);
  return svg;
}
