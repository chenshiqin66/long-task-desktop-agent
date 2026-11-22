/** Data-directory label: settings modal + first-run prompt when siblings are named. */

export interface HomeInfoView {
  path: string;
  key: string;
  label: string;
  decided?: boolean;
  repoRoot: string | null;
  siblings: Array<{ key: string; path: string; label: string }>;
  needsLabel: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyDocumentTitle(label: string): void {
  document.title = label ? `Long-Task Agent · ${label}` : "Long-Task Agent";
}

function paintHomeLabelCard(host: HTMLElement, info: HomeInfoView): void {
  host.replaceChildren();
  const card = el("article", { class: "home-label-card" });

  const row = el("div", { class: "home-label-row" });
  const input = el("input", {
    class: "memory-input home-label-input",
    type: "text",
    maxlength: "40",
    "aria-label": "版本名称",
    placeholder: "正式版留空；克隆版例如 agent-labs",
  }) as HTMLInputElement;
  input.value = info.label;
  const save = el("button", { type: "button", class: "mcp-btn" }, "保存");
  const note = el("p", { class: "skills-note home-label-note", hidden: "true" });

  const pathRow = el("div", { class: "home-label-path-row" });
  const path = el("span", { class: "memory-file-path", title: info.path }, info.path);
  const open = el("button", { type: "button", class: "mcp-btn" }, "打开文件夹");

  save.addEventListener("click", () => {
    void (async () => {
      note.hidden = true;
      try {
        const next = (await window.agent.setHomeLabel(input.value)) as HomeInfoView;
        input.value = next.label;
        path.textContent = next.path;
        path.title = next.path;
        applyDocumentTitle(next.label);
        note.hidden = false;
        note.textContent = next.label ? "已保存。" : "已保存为空（正式版）。";
      } catch (err) {
        note.hidden = false;
        note.textContent = err instanceof Error ? err.message : String(err);
      }
    })();
  });
  open.addEventListener("click", () => {
    void window.agent.openHomeDir().catch((err: unknown) => {
      note.hidden = false;
      note.textContent = err instanceof Error ? err.message : String(err);
    });
  });

  row.append(input, save);
  pathRow.append(path, open);
  card.append(row, pathRow, note);
  host.append(card);
  input.focus();
  input.select();
}

/** Sidebar「设置」: modal with the data-directory card. */
export async function showSettingsModal(): Promise<void> {
  if (!window.agent?.getHomeInfo) return;
  const existing = document.querySelector(".home-settings-prompt");
  if (existing) {
    existing.querySelector<HTMLInputElement>(".home-label-input")?.focus();
    return;
  }

  const info = (await window.agent.getHomeInfo()) as HomeInfoView;
  const backdrop = el("div", {
    class: "home-label-prompt home-settings-prompt",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "设置版本名称",
  });
  const panel = el("div", { class: "home-label-prompt-panel home-settings-panel" });
  const head = el("div", { class: "home-settings-head" });
  head.append(el("h3", { class: "home-label-prompt-title" }, "设置版本名称"));
  const closeBtn = el("button", {
    type: "button",
    class: "home-settings-close",
    "aria-label": "关闭",
  }, "×");
  head.append(closeBtn);
  const host = el("div", { class: "home-label-host" });
  panel.append(head, host);
  backdrop.append(panel);
  document.body.append(backdrop);
  paintHomeLabelCard(host, info);
  applyDocumentTitle(info.label);

  const close = () => backdrop.remove();
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) close();
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || ev.isComposing) return;
    ev.preventDefault();
    window.removeEventListener("keydown", onKey, true);
    close();
  };
  window.addEventListener("keydown", onKey, true);
}

/** Modal when this home has never decided a name but siblings already have one. */
export function showHomeLabelPrompt(info: HomeInfoView): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "home-label-prompt", role: "dialog", "aria-modal": "true" });
    const panel = el("div", { class: "home-label-prompt-panel" });
    panel.append(
      el("h3", { class: "home-label-prompt-title" }, "给这份数据目录起个名字"),
      el(
        "p",
        { class: "memory-muted" },
        `本机已有：${info.siblings.map((row) => row.label).join("、")}。克隆版请起名；若这是正式版，可留空后保存。`,
      ),
    );
    const input = el("input", {
      class: "memory-input home-label-input",
      type: "text",
      maxlength: "40",
      placeholder: "克隆版例如 agent-labs；正式版留空",
    }) as HTMLInputElement;
    const error = el("p", { class: "skills-note", hidden: "true" });
    const actions = el("div", { class: "home-label-prompt-actions" });
    const skip = el("button", { type: "button", class: "btn btn-ghost" }, "稍后");
    const ok = el("button", { type: "button", class: "btn btn-accent" }, "保存");

    const close = (value: string | null) => {
      backdrop.remove();
      resolve(value);
    };

    skip.addEventListener("click", () => {
      void (async () => {
        // Persist empty label so the official home is not prompted again every launch.
        try {
          await window.agent.setHomeLabel("");
          applyDocumentTitle("");
        } catch {
          /* still dismiss */
        }
        close(null);
      })();
    });
    ok.addEventListener("click", () => {
      void (async () => {
        error.hidden = true;
        try {
          const next = (await window.agent.setHomeLabel(input.value)) as HomeInfoView;
          applyDocumentTitle(next.label);
          close(next.label);
        } catch (err) {
          error.hidden = false;
          error.textContent = err instanceof Error ? err.message : String(err);
        }
      })();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        ok.click();
      }
    });

    actions.append(skip, ok);
    panel.append(input, error, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    input.focus();
  });
}
