import { attachComposerModelSizing, fitComposerModelEmpty, fitComposerModelSelect } from "./composerModelFit.js";

type ModelKind = "text" | "image" | "video" | "audio" | "search";

const MODEL_KINDS: readonly ModelKind[] = ["text", "image", "video", "audio", "search"];

type StoredModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  kind?: ModelKind;
};

type StoredConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: StoredModel[];
  currentModelId?: string;
  /** web_search's model. Separate from currentModelId: both are in use at the same time. */
  currentSearchModelId?: string;
  [key: string]: unknown;
};

export type KindedModel = { id: string; kind?: unknown };

/** Models the composer picker lists. Search models are left out: they only serve web_search. */
export function chatModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) !== "search");
}

export function searchModelsOf<T extends KindedModel>(models: readonly T[] | undefined): T[] {
  return (models ?? []).filter((entry) => parseModelKind(entry.kind) === "search");
}

/** The id in use within one pool: the saved id when it belongs to the pool, else the pool's first. */
export function inUseId(pool: readonly KindedModel[], savedId: string | undefined): string | undefined {
  return (pool.find((entry) => entry.id === savedId) ?? pool[0])?.id;
}

export interface ModelsHost {
  onOpen: () => void;
  onClose: () => void;
}

export function modelRowHeading(name: string, kindLabel: string): string {
  return `${name} · ${kindLabel}`;
}

export function composerModelOptionText(name: string, kindLabel: string): string {
  return `${name}（${kindLabel}）`;
}

function parseModelKind(raw: unknown): ModelKind {
  return typeof raw === "string" && (MODEL_KINDS as readonly string[]).includes(raw)
    ? (raw as ModelKind)
    : "text";
}

function modelKindOf(entry: { kind?: unknown } | null | undefined): ModelKind {
  return parseModelKind(entry?.kind);
}

function modelLabel(entry: StoredModel): string {
  return entry.name || entry.model || "未命名模型";
}

function kindLabelFromSelect(select: HTMLSelectElement, kind: ModelKind): string {
  for (let i = 0; i < select.options.length; i++) {
    const option = select.options[i];
    if (option && option.value === kind) return option.textContent || "生文";
  }
  return "生文";
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

function duplicateModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = [...(stored.models ?? [])];
  const source = models.find((entry) => entry.id === modelId);
  if (!source) throw new Error("找不到这个模型");
  const copy: StoredModel = {
    ...source,
    id: newModelId(),
    name: `${source.name}（副本）`,
    kind: modelKindOf(source),
  };
  return {
    ...stored,
    models: [...models, copy],
    currentModelId: stored.currentModelId,
  };
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
  const kindSelect = page.querySelector("#model-kind") as HTMLSelectElement;
  const baseUrlInput = page.querySelector("#model-baseUrl") as HTMLInputElement;
  const modelInput = page.querySelector("#model-model") as HTMLInputElement;
  const apiKeyInput = page.querySelector("#model-apiKey") as HTMLInputElement;
  const cancelBtn = page.querySelector("#models-cancel") as HTMLButtonElement;
  const kindHint = page.querySelector("#model-kind-hint") as HTMLElement | null;

  let editing: string | null = null;
  let painting = false;

  /** The search kind has no model name to fill, and its Base URL has a default worth showing. */
  function syncKindFields(): void {
    const search = parseModelKind(kindSelect.value) === "search";
    modelInput.placeholder = search ? "可留空：搜索接口不使用模型名" : "";
    baseUrlInput.placeholder = search ? "https://api.deepseek.com" : "";
    if (kindHint) kindHint.hidden = !search;
  }

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = err instanceof Error ? err.message : String(err);
  };

  function closeForm(): void {
    editing = null;
    form.hidden = true;
    form.reset();
    syncKindFields();
  }

  function openForm(entry?: StoredModel): void {
    editing = entry?.id ?? null;
    nameInput.value = entry?.name ?? "";
    kindSelect.value = modelKindOf(entry);
    syncKindFields();
    baseUrlInput.value = entry?.baseUrl ?? "";
    modelInput.value = entry?.model ?? "";
    apiKeyInput.value = entry?.apiKey ?? "";
    form.hidden = false;
    nameInput.focus();
  }

  function paintPicker(cfg: StoredConfig | null): void {
    // Search models never appear here: they only serve web_search and have their own "use" in the models page.
    const models = chatModelsOf(cfg?.models);
    const currentId = inUseId(models, cfg?.currentModelId) ?? "";
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
        option.textContent = composerModelOptionText(modelLabel(entry), kindLabelFromSelect(kindSelect, modelKindOf(entry)));
        select.append(option);
      }
      select.value = models.some((entry) => entry.id === currentId) ? currentId : models[0]!.id;
      select.hidden = false;
      select.disabled = false;
      emptyBtn.hidden = true;
    }
    painting = false;
    fitComposerModelSelect(select);
    fitComposerModelEmpty(emptyBtn);
    window.dispatchEvent(new Event("agent-models-changed"));
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
    // A search model has its own "current", so one chat model and one search model are in use at once.
    const isSearch = modelKindOf(entry) === "search";
    const current = isSearch
      ? entry.id === inUseId(searchModelsOf(cfg.models), cfg.currentSearchModelId)
      : entry.id === inUseId(chatModelsOf(cfg.models), cfg.currentModelId);
    const row = document.createElement("article");
    row.className = current ? "mcp-row is-current-model" : "mcp-row";
    const main = document.createElement("div");
    main.className = "mcp-row-main";
    const title = document.createElement("div");
    title.className = "mcp-row-title";
    const heading = document.createElement("span");
    heading.className = "mcp-label";
    heading.textContent = modelRowHeading(modelLabel(entry), kindLabelFromSelect(kindSelect, modelKindOf(entry)));
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
    const hover = document.createElement("div");
    hover.className = "mcp-actions-hover";
    hover.append(
      textButton("复制", () => {
        void run(async () => {
          const cur = (await loadConfig()) ?? emptyConfig();
          const before = new Set((cur.models ?? []).map((row) => row.id));
          const next = duplicateModel(cur, entry.id);
          await persist(next);
          const copied = next.models?.find((row) => !before.has(row.id));
          if (copied) openForm(copied);
        });
      }),
      textButton("修改", () => openForm(entry)),
      textButton("移除", () => {
        void run(async () => {
          if (editing === entry.id) closeForm();
          await deleteModel(entry.id);
        });
      }, true),
    );
    actions.append(hover);
    if (!current) {
      actions.append(
        textButton("使用", () => {
          void run(async () => {
            await selectModel(entry.id);
          });
        }),
      );
    }
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
    if (modelKindOf(chosen) === "search") {
      // Only web_search's model changes. The chat model stays exactly as it was.
      await persist({ ...cur, models, currentSearchModelId: chosen.id });
      return;
    }
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
    // The chat model and the search model are picked from their own pools.
    const chat = chatModelsOf(models);
    const chosen = chat.find((entry) => entry.id === cur.currentModelId) ?? chat[0];
    await persist({
      ...cur,
      models,
      currentModelId: chosen?.id,
      baseUrl: chosen?.baseUrl ?? "",
      model: chosen?.model ?? "",
      apiKey: chosen?.apiKey ?? "",
      currentSearchModelId: inUseId(searchModelsOf(models), cur.currentSearchModelId),
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
  kindSelect.addEventListener("change", syncKindFields);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void run(async () => {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const model = modelInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      const kind = parseModelKind(kindSelect.value);
      if (!name) throw new Error("请填写显示名");
      if (!baseUrl) throw new Error("请填写 Base URL");
      // The search API takes no model name, but it cannot work without a key.
      if (kind !== "search" && !model) throw new Error("请填写 Model");
      if (kind === "search" && !apiKey) throw new Error("网搜模型需要填写 API Key");
      const cur = (await loadConfig()) ?? emptyConfig();
      const models = [...(cur.models ?? [])];
      const id = editing ?? newModelId();
      const entry: StoredModel = { id, name, baseUrl, model, apiKey, kind };
      const index = models.findIndex((item) => item.id === id);
      if (index >= 0) models[index] = entry;
      else models.push(entry);
      // A new chat model becomes current when none is. A search model never takes over as the chat model.
      const chat = chatModelsOf(models);
      const chosen = chat.find((item) => item.id === cur.currentModelId) ?? (kind === "search" ? chat[0] : entry);
      await persist({
        ...cur,
        models,
        currentModelId: chosen?.id,
        baseUrl: chosen?.baseUrl ?? "",
        model: chosen?.model ?? "",
        apiKey: chosen?.apiKey ?? "",
        currentSearchModelId: inUseId(searchModelsOf(models), cur.currentSearchModelId),
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

  attachComposerModelSizing(select);

  return {
    reload: () => reload().catch(showNote),
  };
}
