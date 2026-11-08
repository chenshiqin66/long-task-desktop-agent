export type TaskPanelGroup = "in_progress" | "blocked" | "pending" | "completed";

export interface TaskPanelBlocker {
  id: string;
  missing: boolean;
}

export interface TaskPanelRow {
  id: string;
  subject: string;
  description: string;
  group: TaskPanelGroup;
  owner: string | null;
  ownerStopped: boolean;
  blockers: TaskPanelBlocker[];
}

export interface TaskPanelView {
  rows: TaskPanelRow[];
  unreadable: string[];
  attention: number;
}

const GROUP_LABEL: Record<Exclude<TaskPanelGroup, "completed">, string> = {
  in_progress: "进行中",
  blocked: "被挡住",
  pending: "待做",
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ownerText(owner: string | null): string {
  if (!owner) return "还没有人领取";
  if (owner === "main") return "主会话";
  return owner;
}

function blockerText(blockers: TaskPanelBlocker[]): string {
  return blockers
    .map((blocker) => (blocker.missing ? `#${blocker.id}（文件不在）` : `#${blocker.id}`))
    .join("、");
}

function rowNode(row: TaskPanelRow, descriptionOpen: boolean): HTMLElement {
  const item = el("li", row.ownerStopped || row.group === "blocked" ? "task-row is-attention" : "task-row");
  const head = el("div", "task-row-head");
  head.append(el("span", "task-id", `#${row.id}`));
  head.append(el("span", "task-subject", row.subject));
  item.append(head);
  const meta = el("p", "task-meta");
  meta.append(el("span", "task-owner", ownerText(row.owner)));
  if (row.ownerStopped) meta.append(el("span", "task-flag", "领取者已结束"));
  if (row.blockers.length) meta.append(el("span", "task-flag", `挡住：${blockerText(row.blockers)}`));
  item.append(meta);
  const description = row.description.trim();
  if (description) {
    const details = document.createElement("details");
    details.className = "task-desc";
    details.open = descriptionOpen;
    const summary = document.createElement("summary");
    summary.textContent = "说明";
    const body = el("p", "task-desc-body", description);
    details.append(summary, body);
    item.append(details);
  }
  return item;
}

function groupList(rows: TaskPanelRow[], openDescriptions: ReadonlySet<string>): HTMLElement {
  const list = el("ul", "task-list");
  for (const row of rows) list.append(rowNode(row, openDescriptions.has(row.id)));
  return list;
}

/** Rebuild the panel. Keeps the completed section and any open 说明 in their previous state. */
export function renderTaskPanel(host: HTMLElement, view: TaskPanelView): void {
  const completedWasOpen = host.querySelector(".task-completed") instanceof HTMLDetailsElement
    ? (host.querySelector(".task-completed") as HTMLDetailsElement).open
    : false;
  const openDescriptions = new Set<string>();
  host.querySelectorAll(".task-desc").forEach((node) => {
    if (!(node instanceof HTMLDetailsElement) || !node.open) return;
    const id = node.closest(".task-row")?.querySelector(".task-id")?.textContent?.replace(/^#/, "");
    if (id) openDescriptions.add(id);
  });

  host.replaceChildren();
  const head = el("div", "task-panel-head");
  head.append(el("h2", "task-panel-title", "本会话"));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "task-panel-close";
  close.setAttribute("aria-label", "关闭任务");
  close.textContent = "×";
  head.append(close);
  host.append(head);

  if (view.unreadable.length) {
    host.append(el("p", "task-unreadable", `${view.unreadable.length} 个任务文件读不出来`));
  }

  const active: Exclude<TaskPanelGroup, "completed">[] = ["in_progress", "blocked", "pending"];
  for (const group of active) {
    const rows = view.rows.filter((row) => row.group === group);
    if (!rows.length) continue;
    const section = el("section", "task-group");
    section.append(el("h3", "task-group-title", GROUP_LABEL[group]));
    section.append(groupList(rows, openDescriptions));
    host.append(section);
  }

  const done = view.rows.filter((row) => row.group === "completed");
  if (done.length) {
    const details = document.createElement("details");
    details.className = "task-completed";
    details.open = completedWasOpen;
    const summary = document.createElement("summary");
    summary.textContent = `已完成（${done.length}）`;
    details.append(summary, groupList(done, openDescriptions));
    host.append(details);
  }
}
