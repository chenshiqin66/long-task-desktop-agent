/** Short work status that sits to the right of the robot avatar while a turn is in flight. */

export const MSG_RUN_STATUS_CLASS = "is-run-status";
export const MSG_RUN_STATUS_TEXT_CLASS = "msg-run-status";
export const MSG_RUN_STATUS_DOTS_CLASS = "msg-run-dots";

export const RUN_STATUS_THINKING = "正在思考…";
export const RUN_STATUS_TOOL = "正在使用工具";

export type AssistantRunPhase = "thinking" | "tool" | "streaming" | "idle";

export function assistantRunStatusLabel(phase: AssistantRunPhase): string | null {
  if (phase === "thinking") return RUN_STATUS_THINKING;
  if (phase === "tool") return RUN_STATUS_TOOL;
  return null;
}

export function assistantRunPhase(opts: {
  running: boolean;
  hasTools?: boolean;
  hasStreamText?: boolean;
  stopping?: boolean;
  asking?: boolean;
  placeholder?: boolean;
}): AssistantRunPhase {
  if (!opts.running || opts.stopping || opts.asking || opts.hasStreamText || opts.placeholder) {
    return opts.hasStreamText ? "streaming" : "idle";
  }
  if (opts.hasTools) return "tool";
  return "thinking";
}

/** Stem shown before the animated dots, so the thinking label does not grow a second ellipsis. */
export function assistantRunStatusStem(phase: "thinking" | "tool"): string {
  return phase === "thinking" ? "正在思考" : RUN_STATUS_TOOL;
}

export function paintMessageRunStatus(body: HTMLElement, phase: "thinking" | "tool"): void {
  const msg = body.closest(".msg");
  if (!(msg instanceof HTMLElement)) return;
  msg.classList.add(MSG_RUN_STATUS_CLASS);
  msg.classList.remove("is-blank");
  delete body.dataset.rawMd;
  const existing = body.querySelector(`:scope > .${MSG_RUN_STATUS_TEXT_CLASS}`);
  const row = existing instanceof HTMLElement ? existing : document.createElement("span");
  if (row !== existing) {
    row.className = MSG_RUN_STATUS_TEXT_CLASS;
    body.replaceChildren(row);
  }
  const label = assistantRunStatusLabel(phase) ?? "";
  row.setAttribute("data-phase", phase);
  row.setAttribute("aria-live", "polite");
  row.setAttribute("aria-label", label);
  if (row.dataset.painted === phase && row.querySelector(`.${MSG_RUN_STATUS_DOTS_CLASS}`)) return;
  row.dataset.painted = phase;
  row.replaceChildren();
  row.append(document.createTextNode(assistantRunStatusStem(phase)));
  const dots = document.createElement("span");
  dots.className = MSG_RUN_STATUS_DOTS_CLASS;
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) dots.append(document.createElement("span"));
  row.append(dots);
}

/** Strip the waiting chrome. Returns true when the bubble has no leftover reply and should be removed. */
export function clearMessageRunStatus(msg: HTMLElement): boolean {
  msg.classList.remove(MSG_RUN_STATUS_CLASS);
  for (const node of Array.from(msg.querySelectorAll(`.${MSG_RUN_STATUS_TEXT_CLASS}`))) {
    node.remove();
  }
  const body = msg.querySelector(":scope > .msg-body");
  const text = (body?.textContent ?? "").trim();
  const media = msg.querySelector(".msg-images img, .msg-videos video, .msg-audios audio");
  return !text && !media;
}
