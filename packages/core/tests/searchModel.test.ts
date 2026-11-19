import { describe, it, expect } from "vitest";
import type { StoredConfig, StoredModel } from "../src/config/types.js";
import {
  currentModelOf,
  duplicateModel,
  modelsOf,
  normalizeStoredConfig,
  removeModel,
  searchModelOf,
  textModelForExplain,
  textModelForMemory,
  toAgentConfig,
  upsertModel,
  withCurrentModel,
  withSearchModel,
} from "../src/config/loadConfig.js";
import { MODEL_KINDS, isSearchModel, modelKindLabel, modelKindOf } from "../src/config/modelKind.js";

function model(over: Partial<StoredModel> & Pick<StoredModel, "id">): StoredModel {
  return {
    name: over.name ?? over.id,
    baseUrl: `https://${over.id}.example/v1`,
    model: over.model ?? over.id,
    apiKey: `key-${over.id}`,
    kind: "text",
    ...over,
  };
}

function stored(models: StoredModel[], over: Partial<StoredConfig> = {}): StoredConfig {
  return { baseUrl: "", model: "", apiKey: "", models, ...over };
}

describe("search kind", () => {
  it("is a fifth kind labelled 网搜", () => {
    expect(MODEL_KINDS).toContain("search");
    expect(modelKindOf({ kind: "search" })).toBe("search");
    expect(modelKindLabel("search")).toBe("网搜");
    expect(isSearchModel({ kind: "search" })).toBe(true);
    expect(isSearchModel({ kind: "text" })).toBe(false);
    expect(isSearchModel({})).toBe(false);
  });

  it("survives reading the model list", () => {
    const models = modelsOf(stored([model({ id: "web", kind: "search" })]));
    expect(models[0]?.kind).toBe("search");
  });
});

describe("the chat model never lands on a search model", () => {
  it("skips a search model even when it is first or is named by currentModelId", () => {
    const config = stored([model({ id: "web", kind: "search" }), model({ id: "chat" })], {
      currentModelId: "web",
    });
    expect(currentModelOf(config)?.id).toBe("chat");
    expect(normalizeStoredConfig(config).currentModelId).toBe("chat");
    expect(normalizeStoredConfig(config).apiKey).toBe("key-chat");
  });

  it("has no chat model when only search models exist, and keeps them in the list", () => {
    const config = stored([model({ id: "web", kind: "search" })], { currentModelId: "web" });
    expect(currentModelOf(config)).toBeNull();
    const normalized = normalizeStoredConfig(config);
    expect(normalized.models?.map((entry) => entry.id)).toEqual(["web"]);
    expect(normalized.currentModelId).toBeUndefined();
    expect(normalized.apiKey).toBe("");
  });

  it("ignores a search id passed to withCurrentModel", () => {
    const config = stored([model({ id: "web", kind: "search" }), model({ id: "chat" })], {
      currentModelId: "chat",
    });
    expect(withCurrentModel(config, "web").currentModelId).toBe("chat");
  });

  it("does not make a newly added search model the chat model", () => {
    const withChat = stored([model({ id: "chat" })], { currentModelId: "chat" });
    const added = upsertModel(withChat, model({ id: "web", kind: "search" }));
    expect(added.currentModelId).toBe("chat");
    const onlySearch = upsertModel(stored([]), model({ id: "web", kind: "search" }));
    expect(onlySearch.currentModelId).toBeUndefined();
    expect(onlySearch.models?.map((entry) => entry.id)).toEqual(["web"]);
  });

  it("keeps memory and explain on text models", () => {
    const config = stored([model({ id: "web", kind: "search" }), model({ id: "chat" })], {
      currentModelId: "chat",
    });
    expect(textModelForMemory(config)?.id).toBe("chat");
    expect(textModelForExplain(config)?.id).toBe("chat");
    expect(textModelForMemory(stored([model({ id: "web", kind: "search" })]))).toBeNull();
  });
});

describe("the current search model is separate from the current chat model", () => {
  it("defaults to the first search model and keeps the chat model", () => {
    const config = normalizeStoredConfig(
      stored([model({ id: "chat" }), model({ id: "web-a", kind: "search" }), model({ id: "web-b", kind: "search" })], {
        currentModelId: "chat",
      }),
    );
    expect(config.currentModelId).toBe("chat");
    expect(config.currentSearchModelId).toBe("web-a");
  });

  it("switches the search model without touching the chat model", () => {
    const base = stored(
      [model({ id: "chat" }), model({ id: "web-a", kind: "search" }), model({ id: "web-b", kind: "search" })],
      { currentModelId: "chat" },
    );
    const next = withSearchModel(base, "web-b");
    expect(next.currentSearchModelId).toBe("web-b");
    expect(next.currentModelId).toBe("chat");
    expect(searchModelOf(next)?.id).toBe("web-b");
  });

  it("rejects a model that is not a search model", () => {
    const base = stored([model({ id: "chat" }), model({ id: "web", kind: "search" })], { currentModelId: "chat" });
    expect(() => withSearchModel(base, "chat")).toThrow("请选择网搜模型");
    expect(() => withSearchModel(base, "missing")).toThrow("请选择网搜模型");
  });

  it("drops a search id that is missing or no longer a search model", () => {
    const stale = normalizeStoredConfig(
      stored([model({ id: "chat" })], { currentModelId: "chat", currentSearchModelId: "chat" }),
    );
    expect(stale.currentSearchModelId).toBeUndefined();
    const wrongKind = normalizeStoredConfig(
      stored([model({ id: "chat" }), model({ id: "web", kind: "search" })], {
        currentModelId: "chat",
        currentSearchModelId: "chat",
      }),
    );
    expect(wrongKind.currentSearchModelId).toBe("web");
  });

  it("moves to another search model when the current one is removed", () => {
    const base = normalizeStoredConfig(
      stored(
        [model({ id: "chat" }), model({ id: "web-a", kind: "search" }), model({ id: "web-b", kind: "search" })],
        { currentModelId: "chat", currentSearchModelId: "web-a" },
      ),
    );
    const next = removeModel(base, "web-a");
    expect(next.currentSearchModelId).toBe("web-b");
    expect(next.currentModelId).toBe("chat");
    expect(removeModel(next, "web-b").currentSearchModelId).toBeUndefined();
  });

  it("copies a search model as a search model", () => {
    const base = stored([model({ id: "chat" }), model({ id: "web", kind: "search" })], { currentModelId: "chat" });
    const copied = duplicateModel(base, "web").models?.find((entry) => entry.name === "web（副本）");
    expect(copied?.kind).toBe("search");
    expect(copied?.apiKey).toBe("key-web");
  });
});

describe("toAgentConfig search target", () => {
  it("points web_search at the current search model, whatever the chat model is", () => {
    const config = stored(
      [
        model({ id: "chat", baseUrl: "https://chat.example/v1", apiKey: "chat-key" }),
        model({ id: "web", kind: "search", baseUrl: "https://api.deepseek.com", apiKey: "search-key" }),
      ],
      { currentModelId: "chat" },
    );
    const agent = toAgentConfig(config);
    expect(agent.baseUrl).toBe("https://chat.example/v1");
    expect(agent.apiKey).toBe("chat-key");
    expect(agent.searchBaseUrl).toBe("https://api.deepseek.com");
    expect(agent.searchApiKey).toBe("search-key");
    const other = toAgentConfig({
      ...config,
      models: [model({ id: "draw", kind: "image", apiKey: "draw-key" }), ...(config.models ?? [])],
      currentModelId: "draw",
    });
    expect(other.kind).toBe("image");
    expect(other.searchApiKey).toBe("search-key");
  });

  it("uses the chosen search model when there are several", () => {
    const config = stored(
      [
        model({ id: "chat" }),
        model({ id: "web-a", kind: "search", apiKey: "a-key" }),
        model({ id: "web-b", kind: "search", apiKey: "b-key" }),
      ],
      { currentModelId: "chat", currentSearchModelId: "web-b" },
    );
    expect(toAgentConfig(config).searchApiKey).toBe("b-key");
  });

  it("keeps the chat model usable when only a search model exists", () => {
    const agent = toAgentConfig(stored([model({ id: "web", kind: "search", apiKey: "search-key" })]));
    expect(agent.kind).toBe("text");
    expect(agent.apiKey).toBe("");
    expect(agent.searchApiKey).toBe("search-key");
  });

  it("falls back to the older searchBaseUrl / searchApiKey only when there is no search model", () => {
    const legacy = stored([model({ id: "chat" })], {
      currentModelId: "chat",
      searchBaseUrl: " https://old.example/v1 ",
      searchApiKey: " old-key ",
    });
    const agent = toAgentConfig(legacy);
    expect(agent.searchBaseUrl).toBe("https://old.example/v1");
    expect(agent.searchApiKey).toBe("old-key");
    const both = toAgentConfig({
      ...legacy,
      models: [...(legacy.models ?? []), model({ id: "web", kind: "search", apiKey: "new-key" })],
    });
    expect(both.searchApiKey).toBe("new-key");
    expect(both.searchBaseUrl).toBe("https://web.example/v1");
  });

  it("never borrows the chat model's address or key", () => {
    const agent = toAgentConfig(stored([model({ id: "chat", apiKey: "chat-key" })], { currentModelId: "chat" }));
    expect(agent.searchBaseUrl).toBeUndefined();
    expect(agent.searchApiKey).toBeUndefined();
  });
});
