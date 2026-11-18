import { describe, it, expect } from "vitest";
import type { StoredConfig, StoredModel } from "../src/config/types.js";
import { textModelForMemory } from "../src/config/loadConfig.js";

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

function stored(models: StoredModel[], currentModelId: string): StoredConfig {
  return { baseUrl: "", model: "", apiKey: "", models, currentModelId };
}

describe("textModelForMemory", () => {
  it("uses the current model when it is a text model", () => {
    const current = model({ id: "text-2", model: "flash" });
    const picked = textModelForMemory(
      stored([model({ id: "text-1", model: "other" }), current, model({ id: "image-1", kind: "image" })], "text-2"),
    );
    expect(picked?.id).toBe("text-2");
    expect(picked?.model).toBe("flash");
  });

  it("treats a missing kind as text", () => {
    const current = model({ id: "legacy" });
    delete (current as { kind?: string }).kind;
    expect(textModelForMemory(stored([current], "legacy"))?.id).toBe("legacy");
  });

  it("falls back to the first text model when the current one is not text", () => {
    const picked = textModelForMemory(
      stored(
        [
          model({ id: "image-1", kind: "image", model: "draw" }),
          model({ id: "text-a", model: "a" }),
          model({ id: "text-b", model: "b" }),
        ],
        "image-1",
      ),
    );
    expect(picked?.id).toBe("text-a");
  });

  it("returns null when no text model is configured", () => {
    expect(
      textModelForMemory(stored([model({ id: "draw", kind: "image" }), model({ id: "clip", kind: "video" })], "draw")),
    ).toBeNull();
    expect(textModelForMemory(null)).toBeNull();
  });
});
