type StoredModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

type StoredConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: StoredModel[];
  currentModelId?: string;
  [key: string]: unknown;
};

export interface ModelsHost {
  onOpen: () => void;
  onClose: () => void;
}

function textButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "mcp-btn mcp-btn-danger" : "mcp-btn";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function newModelId(): string {
  return `model_${crypto.randomUUID().replace(/-/g, "")}`;
}

function emptyConfig(): StoredConfig {
  return { baseUrl: "", model: "", apiKey: "", models: [], currentModelId: undefined };
}

export function attachModelsLibrary(
  button: HTMLButtonElement,
  page: HTMLElement,
  select: HTMLSelectElement,
  emptyBtn: HTMLButtonElement,
  host: ModelsHost,
): { reload(): Promise<void> } {
  const list = page.querySelector("#models-list") as HTMLElement;
  const note = page.querySelector("#models-note") as HTMLElement;
  const count = page.querySelector("#models-count") as HTMLElement;
  const addBtn = page.querySelector("#models-add") as HTMLButtonElement;
  const form = page.querySelector("#models-form") as HTMLFormElement;
  const nameInput = page.querySelector("#model-name") as HTMLInputElement;
  const baseUrlInput = page.querySelector("#model-baseUrl") as HTMLInputElement;
  const modelInput = page.querySelector("#model-model") as HTMLInputElement;
  const apiKeyInput = page.querySelector("#model-apiKey") as HTMLInputElement;
  const cancelBtn = page.querySelector("#models-cancel") as HTMLButtonElement;

  let editing: string | null = null;
  let painting = false;

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = err instanceof Error ? err.message : String(err);
  };

  function closeForm(): void {
    editing = null;
    form.hidden = true;
    form.reset();
  }

  function openForm(entry?: StoredModel): void {
    editing = entry?.id ?? null;
    nameInput.value = entry?.name ?? "";
    baseUrlInput.value = entry?.baseUrl ?? "";
    modelInput.value = entry?.model ?? "";
    apiKeyInput.value = entry?.apiKey ?? "";
    form.hidden = false;
    nameInput.focus();
  }

  function paintPicker(cfg: StoredConfig | null): void {
    const models = cfg?.models ?? [];
    const currentId = cfg?.currentModelId ?? models[0]?.id ?? "";
    painting = true;
    select.replaceChildren();
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未配置模型";
      select.append(option);
      select.value = "";
      select.hidden = true;
      select.disabled = true;
      emptyBtn.hidden = false;
    } else {
      for (const entry of models) {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.name || entry.model || "未命名模型";
        select.append(option);
      }
      select.value = models.some((entry) => entry.id === currentId) ? currentId : models[0]!.id;
      select.hidden = false;
      select.disabled = false;
      emptyBtn.hidden = true;
    }
    painting = false;
  }

  async function loadConfig(): Promise<StoredConfig | null> {
    return ((await window.agent.getConfig()) as StoredConfig | null) ?? null;
  }

  async function reload(): Promise<void> {
    const cfg = await loadConfig();
    const models = cfg?.models ?? [];
    count.textContent = `已配置(${models.length})`;
    paintPicker(cfg);
    list.replaceChildren();
    if (!models.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty";
      empty.textContent = "还没有配置模型。添加后，可在输入框旁选择，下一轮对话会使用选中的这一条。";
      list.append(empty);
      return;
    }
    for (const entry of models) list.append(modelRow(entry, cfg!));
  }

  function modelRow(entry: StoredModel, cfg: StoredConfig): HTMLElement {
    const current = entry.id === (cfg.currentModelId ?? cfg.models?.[0]?.id);
    const row = document.createElement("article");
    row.className = current ? "mcp-row is-current-model" : "mcp-row";
    const main = document.createElement("div");
    main.className = "mcp-row-main";
    const title = document.createElement("div");
    title.className = "mcp-row-title";
    const heading = document.createElement("span");
    heading.className = "mcp-label";
    heading.textContent = entry.name || entry.model || "未命名模型";
    const modelId = document.createElement("span");
    modelId.className = "mcp-id";
    modelId.textContent = entry.model;
    title.append(heading, modelId);
    if (current) {
      const badge = document.createElement("span");
      badge.className = "mcp-state is-ok";
      badge.textContent = "当前";
      title.append(badge);
    }
    const summary = document.createElement("p");
    summary.className = "mcp-summary";
    summary.textContent = entry.baseUrl || "未填写 Base URL";
    const actions = document.createElement("div");
    actions.className = "mcp-actions";
    if (!current) {
      actions.append(
        textButton("使用", () => {
          void run(async () => {
            await selectModel(entry.id);
          });
        }),
      );
    }
    actions.append(
      textButton("修改", () => openForm(entry)),
      textButton("移除", () => {
        void run(async () => {
          if (editing === entry.id) closeForm();
          await deleteModel(entry.id);
        });
      }, true),
    );
    main.append(title, summary, actions);
    row.append(main);
    return row;
  }

  async function persist(next: StoredConfig): Promise<void> {
    await window.agent.saveConfig(next);
    await reload();
  }

  async function selectModel(id: string): Promise<void> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const models = cur.models ?? [];
    const chosen = models.find((entry) => entry.id === id);
    if (!chosen) throw new Error("找不到这个模型");
    await persist({
      ...cur,
      models,
      currentModelId: chosen.id,
      baseUrl: chosen.baseUrl,
      model: chosen.model,
      apiKey: chosen.apiKey,
    });
  }

  async function deleteModel(id: string): Promise<void> {
    const cur = (await loadConfig()) ?? emptyConfig();
    const models = (cur.models ?? []).filter((entry) => entry.id !== id);
    const current =
      cur.currentModelId && cur.currentModelId !== id
        ? models.find((entry) => entry.id === cur.currentModelId)
        : undefined;
    const chosen = current ?? models[0];
    await persist({
      ...cur,
      models,
      currentModelId: chosen?.id,
      baseUrl: chosen?.baseUrl ?? "",
      model: chosen?.model ?? "",
      apiKey: chosen?.apiKey ?? "",
    });
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      note.hidden = true;
    } catch (err) {
      showNote(err);
    }
  }

  button.onclick = () => {
    if (!page.hidden) {
      closeForm();
      host.onClose();
      return;
    }
    note.hidden = true;
    host.onOpen();
    void reload().catch(showNote);
  };

  addBtn.onclick = () => {
    if (page.hidden) {
      note.hidden = true;
      host.onOpen();
      void reload().catch(showNote);
    }
    openForm();
  };

  cancelBtn.onclick = () => closeForm();

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void run(async () => {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const model = modelInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      if (!name) throw new Error("请填写显示名");
      if (!baseUrl) throw new Error("请填写 Base URL");
      if (!model) throw new Error("请填写 Model");
      const cur = (await loadConfig()) ?? emptyConfig();
      const models = [...(cur.models ?? [])];
      const id = editing ?? newModelId();
      const entry: StoredModel = { id, name, baseUrl, model, apiKey };
      const index = models.findIndex((item) => item.id === id);
      if (index >= 0) models[index] = entry;
      else models.push(entry);
      const currentId =
        cur.currentModelId && models.some((item) => item.id === cur.currentModelId) ? cur.currentModelId : id;
      const chosen = models.find((item) => item.id === currentId) ?? entry;
      await persist({
        ...cur,
        models,
        currentModelId: chosen.id,
        baseUrl: chosen.baseUrl,
        model: chosen.model,
        apiKey: chosen.apiKey,
      });
      closeForm();
    });
  });

  select.addEventListener("change", () => {
    if (painting) return;
    const id = select.value;
    if (!id) return;
    void run(async () => {
      await selectModel(id);
    });
  });

  emptyBtn.addEventListener("click", () => {
    note.hidden = true;
    host.onOpen();
    void reload().catch(showNote);
  });

  return {
    reload: () => reload().catch(showNote),
  };
}
