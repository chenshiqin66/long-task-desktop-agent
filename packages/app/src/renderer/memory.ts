import { appendAfterFinishedTurn, el } from "./ui.js";
import {
  ageText,
  canUndo,
  groupByType,
  instructionStateText,
  journalText,
  originText,
  plainError,
  savedLineGroups,
  scopeTitle,
  sourceWorkspace,
  stampText,
  type InstructionFileView,
  type MemoryActionResult,
  type MemoryEntryView,
  type MemoryPageData,
  type MemorySavedEvent,
  type MemoryScope,
} from "./memoryView.js";

export interface MemoryPageDeps {
  /** The workspace selected in the sidebar, or null. */
  workspace(): string | null;
  /** Workspaces in the sidebar. A source session elsewhere is shown as a path only. */
  knownWorkspaces(): readonly string[];
  /** Closes the memory page and opens the session. Resolves to an error message, or null. */
  openSession(workspace: string, sessionId: string): Promise<string | null>;
}

export interface MemoryPage {
  /** Drops any message and edit in progress, then reads the page again. */
  open(): Promise<void>;
  /** Reads the page again and keeps an edit in progress. */
  refresh(): Promise<void>;
}

type Draft = { key: string; description: string; body: string };

function textButton(label: string, onClick: () => void, extra = ""): HTMLButtonElement {
  const button = el("button", { type: "button", class: extra ? `memory-action ${extra}` : "memory-action" }, label);
  button.addEventListener("click", onClick);
  return button;
}

function section(title: string): { box: HTMLElement; head: HTMLElement } {
  const box = el("section", { class: "memory-section" });
  const head = el("div", { class: "memory-section-head" });
  head.append(el("h3", { class: "memory-section-title" }, title));
  box.append(head);
  return { box, head };
}

export function mountMemoryPage(view: HTMLElement, note: HTMLElement, deps: MemoryPageDeps): MemoryPage {
  let data: MemoryPageData | null = null;
  let draft: Draft | null = null;
  let busy = false;

  function setNote(text: string): void {
    note.hidden = !text;
    note.textContent = text;
  }

  async function refresh(): Promise<void> {
    try {
      const next = await window.agent.memoryLoad(deps.workspace());
      data = next;
      if (draft && !next.entries.some((entry) => `${entry.scope}/${entry.name}` === draft?.key)) draft = null;
      paint();
    } catch (err) {
      setNote(plainError(err));
    }
  }

  async function act(run: () => Promise<MemoryActionResult | void>): Promise<void> {
    if (busy) return;
    busy = true;
    setNote("");
    try {
      const result = await run();
      if (result && !result.ok) {
        setNote(result.error);
        return;
      }
      await refresh();
    } catch (err) {
      setNote(plainError(err));
    } finally {
      busy = false;
    }
  }

  function switchRow(page: MemoryPageData): HTMLElement {
    const row = el("div", { class: "memory-switch-row" });
    const text = el("div", { class: "memory-switch-text" });
    text.append(
      el("span", { class: "memory-switch-title" }, "自动记忆"),
      el(
        "span",
        { class: "memory-muted" },
        page.autoMemory ? "每轮正常结束后，在后台从你说的话里提取记忆。" : "已关闭：不再写入新记忆，已有的照常使用。",
      ),
    );
    const toggle = el("button", {
      type: "button",
      class: "skill-switch",
      role: "switch",
      "aria-checked": page.autoMemory ? "true" : "false",
      "aria-label": "自动记忆",
    });
    toggle.append(el("span", { class: "skill-switch-knob", "aria-hidden": "true" }));
    toggle.addEventListener("click", () => void act(() => window.agent.setAutoMemory(!page.autoMemory)));
    row.append(text, toggle);
    return row;
  }

  function instructionSection(page: MemoryPageData): HTMLElement {
    const { box } = section("指令文件");
    const files = [page.instructions.user, page.instructions.project].filter(
      (file): file is InstructionFileView => file !== null,
    );
    files.forEach((file) => {
      const row = el("div", { class: "memory-file-row" });
      const text = el("div", { class: "memory-file-text" });
      text.append(
        el("span", { class: "memory-file-scope" }, scopeTitle(file.scope)),
        el("span", { class: "memory-file-path", title: file.path }, file.path),
        el("span", { class: "memory-muted" }, instructionStateText(file.state)),
      );
      row.append(
        text,
        textButton("在文件夹中显示", () => void act(() => window.agent.memoryRevealInstructions(page.workspace, file.scope))),
      );
      box.append(row);
    });
    return box;
  }

  function editor(page: MemoryPageData, entry: MemoryEntryView, current: Draft): HTMLElement {
    const form = el("div", { class: "memory-editor" });
    const description = el("input", { class: "memory-input", "aria-label": "描述" });
    description.value = current.description;
    description.addEventListener("input", () => {
      current.description = description.value;
    });
    const body = el("textarea", { class: "memory-input memory-textarea", rows: "6", "aria-label": "正文" });
    body.value = current.body;
    body.addEventListener("input", () => {
      current.body = body.value;
    });
    const cancel = (): void => {
      draft = null;
      setNote("");
      paint();
    };
    form.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.isComposing) return;
      ev.preventDefault();
      cancel();
    });
    const actions = el("div", { class: "memory-card-actions" });
    actions.append(
      textButton(
        "保存",
        () =>
          void act(async () => {
            const result = await window.agent.memorySave(page.workspace, entry.scope, entry.name, {
              description: current.description,
              body: current.body,
            });
            if (result.ok) draft = null;
            return result;
          }),
      ),
      textButton("取消", cancel),
    );
    form.append(description, body, actions);
    return form;
  }

  function card(page: MemoryPageData, entry: MemoryEntryView): HTMLElement {
    const key = `${entry.scope}/${entry.name}`;
    const box = el("article", { class: "memory-card" });
    const head = el("div", { class: "memory-card-head" });
    head.append(
      el("span", { class: "memory-card-name" }, entry.name),
      el("span", { class: "memory-muted" }, `${ageText(entry.modified, new Date())} · ${originText(entry.origin)}`),
    );
    box.append(head);
    if (draft?.key === key) {
      box.append(editor(page, entry, draft));
      return box;
    }
    box.append(el("p", { class: "memory-card-desc" }, entry.description), el("p", { class: "memory-card-body" }, entry.body));
    const actions = el("div", { class: "memory-card-actions" });
    const source = entry.source;
    if (source) {
      const workspace = sourceWorkspace(source, deps.knownWorkspaces());
      if (workspace) {
        actions.append(
          textButton("来源会话", () => {
            void deps.openSession(workspace, source.session).then((error) => {
              if (error) setNote(error);
            });
          }),
        );
      } else {
        actions.append(el("span", { class: "memory-muted", title: source.workspace }, `来源：${source.workspace}`));
      }
    }
    actions.append(
      textButton("编辑", () => {
        draft = { key, description: entry.description, body: entry.body };
        paint();
        view.querySelector<HTMLInputElement>(".memory-editor input")?.focus();
      }),
      textButton("删除", () => void act(() => window.agent.memoryDelete(page.workspace, entry.scope, entry.name)), "is-danger"),
    );
    box.append(actions);
    return box;
  }

  function scopeSection(page: MemoryPageData, scope: MemoryScope): HTMLElement {
    const { box, head } = section(scopeTitle(scope));
    if (scope === "project" && page.projectRoot) head.append(el("span", { class: "memory-muted" }, page.projectRoot));
    head.append(textButton("打开文件夹", () => void act(() => window.agent.memoryOpenDir(page.workspace, scope))));
    const groups = groupByType(page.entries, scope);
    if (!groups.length) box.append(el("p", { class: "memory-empty" }, "还没有记忆。在文件夹里新建一个 .md 文件，就是手写一条。"));
    groups.forEach((group) => {
      box.append(el("h4", { class: "memory-type" }, group.label));
      group.entries.forEach((entry) => box.append(card(page, entry)));
    });
    return box;
  }

  function journalSection(page: MemoryPageData): HTMLElement {
    const { box } = section("最近变更");
    if (!page.journal.length) box.append(el("p", { class: "memory-empty" }, "还没有变更。"));
    page.journal.forEach((row) => {
      const line = el("div", { class: "memory-journal-row" });
      line.append(
        el("span", { class: "memory-muted" }, stampText(row.at)),
        el("span", { class: "memory-muted" }, scopeTitle(row.scope)),
        el("span", {}, journalText(row)),
      );
      if (canUndo(row)) {
        line.append(textButton("撤销", () => void act(() => window.agent.memoryUndo(page.workspace, row.scope, row.id))));
      }
      box.append(line);
    });
    return box;
  }

  function unreadableSection(page: MemoryPageData): HTMLElement {
    const { box } = section("无法读取");
    page.unreadable.forEach((item) => {
      box.append(el("div", { class: "memory-journal-row" }, `${scopeTitle(item.scope)} · ${item.file}：${item.reason}`));
    });
    return box;
  }

  function paint(): void {
    const page = data;
    view.replaceChildren();
    if (!page) return;
    view.append(switchRow(page), instructionSection(page));
    if (page.dirs.project) view.append(scopeSection(page, "project"));
    else view.append(el("p", { class: "memory-empty" }, "侧栏没有选中工作区，这里只显示所有项目的记忆。"));
    view.append(scopeSection(page, "user"), journalSection(page));
    if (page.unreadable.length) view.append(unreadableSection(page));
  }

  return {
    open: async () => {
      setNote("");
      draft = null;
      await refresh();
    },
    refresh,
  };
}

/** The grey 已记住 line. It is not saved with the session, so reopening the session drops it. */
export function appendMemorySaved(
  container: HTMLElement,
  event: MemorySavedEvent,
  opts: { turnRunning: boolean; openMemory(): void },
): void {
  const line = el("div", { class: "memory-saved" });
  savedLineGroups(event.items).forEach((group) => {
    const part = el("span", { class: "memory-saved-group" }, `${group.label}：`);
    group.items.forEach((item, index) => {
      if (index > 0) part.append("、");
      const name = el("button", { type: "button", class: "memory-saved-name" }, item.name);
      name.addEventListener("click", () => opts.openMemory());
      const undo = el("button", { type: "button", class: "memory-saved-undo" }, "撤销");
      const error = el("span", { class: "memory-saved-error" });
      undo.addEventListener("click", () => {
        undo.disabled = true;
        error.textContent = "";
        void window.agent
          .memoryUndo(event.workspace, item.scope, item.journal_id)
          .then(
            (result) => (result.ok ? "" : result.error),
            (err: unknown) => plainError(err),
          )
          .then((message) => {
            if (message) {
              error.textContent = message;
              undo.disabled = false;
              return;
            }
            undo.replaceWith(el("span", { class: "memory-muted" }, "已撤销"));
          });
      });
      part.append(name, undo, error);
    });
    line.append(part);
  });
  appendAfterFinishedTurn(container, line, opts.turnRunning);
}
