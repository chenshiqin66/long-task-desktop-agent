import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  getDefaultConfigPath,
  loadStoredConfig,
  saveStoredConfig,
  takeConfigQuarantine,
  toAgentConfig,
  LEGACY_MODEL_ID,
  modelsOf,
  currentModelOf,
  chatModelProblem,
  normalizeStoredConfig,
  withCurrentModel,
  upsertModel,
  removeModel,
  duplicateModel,
} from "../src/config/loadConfig.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips config outside workspace .agent", async () => {
    const path = join(dir, "config.json");
    await saveStoredConfig(
      {
        baseUrl: "https://api.example.com/v1",
        model: "gpt-x",
        apiKey: "sk-secret",
        maxSteps: 50,
      },
      path,
    );
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("sk-secret");
    expect(path.includes(`${join(".agent")}`)).toBe(false);
    const loaded = await loadStoredConfig(path);
    expect(loaded?.model).toBe("gpt-x");
    const agent = toAgentConfig(loaded!);
    expect(agent.maxSteps).toBe(50);
    expect(agent.bashTimeoutMs).toBe(60_000);
    expect(agent.apiKey).toBe("sk-secret");
    expect(agent.searchBaseUrl).toBeUndefined();
    expect(agent.searchApiKey).toBeUndefined();
    await saveStoredConfig(
      {
        baseUrl: " https://api.example.com/v1 ",
        model: "gpt-x",
        apiKey: "sk-secret",
        searchBaseUrl: " https://search.example/v1 ",
        searchApiKey: "  ",
      },
      path,
    );
    const searched = toAgentConfig((await loadStoredConfig(path))!);
    expect(searched.searchBaseUrl).toBe("https://search.example/v1");
    expect(searched.searchApiKey).toBeUndefined();
  });

  it("replaces config.json and leaves no temp file", async () => {
    const path = join(dir, "config.json");
    const base = { baseUrl: "https://api.example.com/v1", model: "gpt-x" };
    await saveStoredConfig({ ...base, apiKey: "sk-first" }, path);
    await saveStoredConfig({ ...base, apiKey: "sk-second" }, path);
    expect((await readdir(dir)).sort()).toEqual(["config.json", "config.json.bak"]);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("sk-second");
    expect(raw).not.toContain("sk-first");
    expect(await readFile(`${path}.bak`, "utf8")).toContain("sk-first");
  });

  it("renames corrupt JSON aside so a later save does not erase it", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not json", "utf8");
    expect(await loadStoredConfig(path)).toBeNull();
    await expect(readFile(path, "utf8")).rejects.toThrow();
    const notice = takeConfigQuarantine();
    expect(notice && "movedTo" in notice ? notice.movedTo : "").toMatch(/config\.json\.broken-\d+$/);
    const backup = notice && "movedTo" in notice ? notice.movedTo : "";
    expect(await readFile(backup, "utf8")).toBe("{ not json");
    expect(takeConfigQuarantine()).toBeNull();
    await saveStoredConfig(
      { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-new" },
      path,
    );
    expect(await readFile(backup, "utf8")).toBe("{ not json");
    expect(await readFile(path, "utf8")).toContain("sk-new");
  });

  it("returns null when config file missing", async () => {
    const loaded = await loadStoredConfig(join(dir, "missing.json"));
    expect(loaded).toBeNull();
    expect(takeConfigQuarantine()).toBeNull();
  });

  it("loads config even when file has UTF-8 BOM", async () => {
    const path = join(dir, "bom-config.json");
    const body = JSON.stringify({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      apiKey: "sk-test",
    });
    await writeFile(path, `\uFEFF${body}`, "utf8");
    const loaded = await loadStoredConfig(path);
    expect(loaded?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(loaded?.model).toBe("deepseek-flash");
  });

  it("default path is under the agent home for this checkout, not workspace .agent", () => {
    const prev = process.env.LONG_TASK_AGENT_HOME;
    process.env.LONG_TASK_AGENT_HOME = join(dir, "forced-home");
    try {
      const p = getDefaultConfigPath();
      expect(p).toBe(join(dir, "forced-home", "config.json"));
      expect(p.includes(`${sep}.agent${sep}`)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LONG_TASK_AGENT_HOME;
      else process.env.LONG_TASK_AGENT_HOME = prev;
    }
  });

  it("saveStoredConfig sets config file mode 0o600 and directory 0o700 on POSIX", async () => {
    if (process.platform === "win32") return;
    const path = join(dir, "secure", "config.json");
    await saveStoredConfig(
      { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" },
      path,
    );
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(dirname(path))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("treats a legacy top-level model as one list entry", () => {
    const stored = {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-x",
      apiKey: "sk-secret",
    };
    expect(modelsOf(stored)).toEqual([
      {
        id: LEGACY_MODEL_ID,
        name: "gpt-x",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-x",
        apiKey: "sk-secret",
        kind: "text",
      },
    ]);
    expect(currentModelOf(stored)?.id).toBe(LEGACY_MODEL_ID);
    const agent = toAgentConfig(stored);
    expect(agent.baseUrl).toBe("https://api.example.com/v1");
    expect(agent.model).toBe("gpt-x");
    expect(agent.apiKey).toBe("sk-secret");
  });

  it("defaults a model kind to text and keeps a valid kind", () => {
    const stored = {
      baseUrl: "https://api.example.com/v1",
      model: "chat",
      apiKey: "sk",
      models: [
        { id: "a", name: "对话", baseUrl: "https://api.example.com/v1", model: "chat", apiKey: "sk" },
        { id: "b", name: "画图", baseUrl: "https://api.example.com/v1", model: "draw", apiKey: "sk", kind: "image" as const },
      ],
      currentModelId: "b",
    };
    const models = modelsOf(stored);
    expect(models[0]?.kind).toBe("text");
    expect(models[1]?.kind).toBe("image");
    expect(toAgentConfig(stored).kind).toBe("image");
    expect(toAgentConfig({ ...stored, currentModelId: "a" }).kind).toBe("text");
  });
  it("uses the selected list entry even when top-level fields are stale", () => {
    const stored = {
      baseUrl: "https://old.example/v1",
      model: "old-model",
      apiKey: "sk-old",
      currentModelId: "fast",
      models: [
        {
          id: "slow",
          name: "慢模型",
          baseUrl: "https://slow.example/v1",
          model: "slow-1",
          apiKey: "sk-slow",
        },
        {
          id: "fast",
          name: "快模型",
          baseUrl: " https://fast.example/v1 ",
          model: " fast-1 ",
          apiKey: " sk-fast ",
        },
      ],
    };
    expect(currentModelOf(stored)?.name).toBe("快模型");
    const agent = toAgentConfig(stored);
    expect(agent.baseUrl).toBe("https://fast.example/v1");
    expect(agent.model).toBe("fast-1");
    expect(agent.apiKey).toBe("sk-fast");
  });

  it("falls back to the first model when currentModelId is missing or unknown", () => {
    const stored = {
      baseUrl: "",
      model: "",
      apiKey: "",
      currentModelId: "missing",
      models: [
        {
          id: "one",
          name: "One",
          baseUrl: "https://one.example/v1",
          model: "one",
          apiKey: "sk-one",
        },
        {
          id: "two",
          name: "Two",
          baseUrl: "https://two.example/v1",
          model: "two",
          apiKey: "sk-two",
        },
      ],
    };
    expect(currentModelOf(stored)?.id).toBe("one");
    expect(currentModelOf({ ...stored, currentModelId: undefined })?.id).toBe("one");
  });

  it("copies the current entry into the top-level fields on normalize", () => {
    const stored = {
      baseUrl: "https://stale.example/v1",
      model: "stale",
      apiKey: "sk-stale",
      workspacePaths: ["/tmp/proj"],
      models: [
        {
          id: "a",
          name: "A",
          baseUrl: "https://a.example/v1",
          model: "model-a",
          apiKey: "sk-a",
        },
      ],
    };
    const normalized = normalizeStoredConfig(stored);
    expect(normalized.baseUrl).toBe("https://a.example/v1");
    expect(normalized.model).toBe("model-a");
    expect(normalized.apiKey).toBe("sk-a");
    expect(normalized.currentModelId).toBe("a");
    expect(normalized.workspacePaths).toEqual(["/tmp/proj"]);
  });

  it("switches the current model and keeps the list", () => {
    const stored = {
      baseUrl: "https://a.example/v1",
      model: "model-a",
      apiKey: "sk-a",
      models: [
        {
          id: "a",
          name: "A",
          baseUrl: "https://a.example/v1",
          model: "model-a",
          apiKey: "sk-a",
        },
        {
          id: "b",
          name: "B",
          baseUrl: "https://b.example/v1",
          model: "model-b",
          apiKey: "sk-b",
        },
      ],
      currentModelId: "a",
    };
    const switched = withCurrentModel(stored, "b");
    expect(switched.currentModelId).toBe("b");
    expect(switched.baseUrl).toBe("https://b.example/v1");
    expect(switched.model).toBe("model-b");
    expect(switched.apiKey).toBe("sk-b");
    expect(switched.models).toHaveLength(2);
    expect(toAgentConfig(switched).model).toBe("model-b");
  });

  it("adds, edits, and removes models, including a legacy file", () => {
    const legacy = {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-x",
      apiKey: "sk-secret",
    };
    const added = upsertModel(legacy, {
      id: "other",
      name: "备用",
      baseUrl: "https://other.example/v1",
      model: "other-1",
      apiKey: "sk-other",
    });
    expect(added.models?.map((row) => row.id)).toEqual([LEGACY_MODEL_ID, "other"]);
    expect(added.currentModelId).toBe(LEGACY_MODEL_ID);
    expect(added.model).toBe("gpt-x");

    const edited = upsertModel(added, {
      id: LEGACY_MODEL_ID,
      name: "主模型",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-x",
      apiKey: "sk-new",
    });
    expect(edited.apiKey).toBe("sk-new");
    expect(edited.models).toHaveLength(2);
    expect(edited.models?.find((row) => row.id === LEGACY_MODEL_ID)?.name).toBe("主模型");

    const dropped = removeModel(edited, LEGACY_MODEL_ID);
    expect(dropped.models?.map((row) => row.id)).toEqual(["other"]);
    expect(dropped.currentModelId).toBe("other");
    expect(dropped.model).toBe("other-1");
    expect(dropped.apiKey).toBe("sk-other");

    const empty = removeModel(dropped, "other");
    expect(empty.models).toEqual([]);
    expect(empty.currentModelId).toBeUndefined();
    expect(empty.baseUrl).toBe("");
    expect(empty.model).toBe("");
    expect(empty.apiKey).toBe("");
    expect(modelsOf(empty)).toEqual([]);
    expect(toAgentConfig(empty).model).toBe("");
  });

  it("keeps an explicit empty models list from becoming the top-level fields again", () => {
    const stored = {
      baseUrl: "https://stale.example/v1",
      model: "stale",
      apiKey: "sk-stale",
      models: [] as [],
    };
    expect(modelsOf(stored)).toEqual([]);
    const normalized = normalizeStoredConfig(stored);
    expect(normalized.models).toEqual([]);
    expect(normalized.baseUrl).toBe("");
  });

  it("round-trips a model list and leaves the current entry at the top level", async () => {
    const path = join(dir, "models.json");
    const saved = normalizeStoredConfig({
      baseUrl: "https://ignored.example/v1",
      model: "ignored",
      apiKey: "sk-ignored",
      currentModelId: "b",
      models: [
        {
          id: "a",
          name: "A",
          baseUrl: "https://a.example/v1",
          model: "model-a",
          apiKey: "sk-a",
        },
        {
          id: "b",
          name: "B",
          baseUrl: "https://b.example/v1",
          model: "model-b",
          apiKey: "sk-b",
        },
      ],
    });
    await saveStoredConfig(saved, path);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.baseUrl).toBe("https://b.example/v1");
    expect(raw.model).toBe("model-b");
    expect(raw.apiKey).toBe("sk-b");
    expect(raw.currentModelId).toBe("b");
    expect(raw.models).toHaveLength(2);
    const loaded = await loadStoredConfig(path);
    expect(toAgentConfig(loaded!).model).toBe("model-b");
    expect(currentModelOf(loaded)?.name).toBe("B");
  });

  it("duplicates a model with a new id and a copy suffix, without changing the current model", () => {
    const stored = {
      baseUrl: "https://api.example.com/v1",
      model: "draw",
      apiKey: "sk",
      currentModelId: "b",
      models: [
        { id: "a", name: "对话", baseUrl: "https://a.example/v1", model: "chat", apiKey: "sk-a", kind: "text" as const },
        { id: "b", name: "画图", baseUrl: "https://b.example/v1", model: "draw", apiKey: "sk-b", kind: "image" as const },
      ],
    };
    const next = duplicateModel(stored, "b");
    expect(next.currentModelId).toBe("b");
    expect(next.models).toHaveLength(3);
    const copied = next.models?.find((row) => row.id !== "a" && row.id !== "b");
    expect(copied?.id).toMatch(/^model_[a-f0-9]+$/);
    expect(copied?.name).toBe("画图（副本）");
    expect(copied?.baseUrl).toBe("https://b.example/v1");
    expect(copied?.model).toBe("draw");
    expect(copied?.apiKey).toBe("sk-b");
    expect(copied?.kind).toBe("image");
    expect(next.models?.find((row) => row.id === "b")?.name).toBe("画图");
  });

  it("throws when the model to duplicate is missing", () => {
    expect(() =>
      duplicateModel(
        { baseUrl: "", model: "", apiKey: "", models: [], currentModelId: undefined },
        "missing",
      ),
    ).toThrow("找不到这个模型");
  });

  it("names the missing or incomplete chat model before a turn starts", () => {
    expect(chatModelProblem(null)).toBe("还没有配置模型，请先在「模型」页添加");
    expect(chatModelProblem({ baseUrl: "", model: "", apiKey: "", models: [] })).toBe(
      "还没有配置模型，请先在「模型」页添加",
    );
    expect(
      chatModelProblem({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "",
        models: [
          {
            id: "a",
            name: "空密钥",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            apiKey: "",
          },
        ],
        currentModelId: "a",
      }),
    ).toBe("当前模型还没有填写 API Key，请打开「模型」页补全");
    expect(
      chatModelProblem({
        baseUrl: "https://example.com/v1",
        model: "chat",
        apiKey: "sk",
        models: [
          {
            id: "a",
            name: "对话",
            baseUrl: "https://example.com/v1",
            model: "chat",
            apiKey: "sk",
          },
        ],
        currentModelId: "a",
      }),
    ).toBeNull();
  });

});
