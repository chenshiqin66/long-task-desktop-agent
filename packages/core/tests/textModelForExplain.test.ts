import { describe, it, expect } from "vitest";
import type { StoredConfig, StoredModel } from "../src/config/types.js";
import { normalizeStoredConfig, textModelForExplain, withExplainModel } from "../src/config/loadConfig.js";

function model(over: Partial<StoredModel> & Pick<StoredModel, "id">): StoredModel {
  return {
    name: over.name ?? over.id,
    baseUrl: "https://example.com",
    model: over.model ?? over.id,
    apiKey: "k",
    kind: "text",
    ...over,
  };
}

function stored(models: StoredModel[], currentModelId: string, currentExplainModelId?: string): StoredConfig {
  return { baseUrl: "", model: "", apiKey: "", models, currentModelId, currentExplainModelId };
}

describe("textModelForExplain", () => {
  it("uses the saved explain text model even when the current chat model is not text", () => {
    const picked = textModelForExplain(
      stored(
        [
          model({ id: "image-1", kind: "image" }),
          model({ id: "text-a", model: "a" }),
          model({ id: "text-b", model: "b" }),
        ],
        "image-1",
        "text-b",
      ),
    );
    expect(picked?.id).toBe("text-b");
  });

  it("falls back to the current model when it is text and no explain model is saved", () => {
    expect(
      textModelForExplain(stored([model({ id: "text-1" }), model({ id: "text-2" })], "text-2"))?.id,
    ).toBe("text-2");
  });

  it("falls back to the first text model when the saved explain model is missing or not text", () => {
    expect(
      textModelForExplain(
        stored(
          [model({ id: "image-1", kind: "image" }), model({ id: "text-a" }), model({ id: "text-b" })],
          "image-1",
          "image-1",
        ),
      )?.id,
    ).toBe("text-a");
  });

  it("returns null when no text model is configured", () => {
    expect(textModelForExplain(stored([model({ id: "draw", kind: "image" })], "draw"))).toBeNull();
    expect(textModelForExplain(null)).toBeNull();
  });
});

describe("withExplainModel", () => {
  it("saves a text model as the explain model without changing the current chat model", () => {
    const next = withExplainModel(
      stored([model({ id: "image-1", kind: "image" }), model({ id: "text-a" })], "image-1"),
      "text-a",
    );
    expect(next.currentModelId).toBe("image-1");
    expect(next.currentExplainModelId).toBe("text-a");
    expect(next.model).toBe("image-1");
  });

  it("rejects a non-text model", () => {
    expect(() =>
      withExplainModel(stored([model({ id: "image-1", kind: "image" }), model({ id: "text-a" })], "image-1"), "image-1"),
    ).toThrow("请选择生文模型");
  });
});

describe("normalizeStoredConfig explain model", () => {
  it("drops an explain model that is missing or not text", () => {
    const cleaned = normalizeStoredConfig(
      stored([model({ id: "image-1", kind: "image" }), model({ id: "text-a" })], "image-1", "image-1"),
    );
    expect(cleaned.currentExplainModelId).toBeUndefined();
    expect(cleaned.currentModelId).toBe("image-1");
  });
});
