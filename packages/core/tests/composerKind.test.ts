import { describe, it, expect } from "vitest";
import {
  COMPOSER_KIND_LABELS,
  COMPOSER_SEND_LABELS,
  parseComposerKind,
} from "../src/config/composerKind.js";
import {
  composerKindOf,
  currentModelOf,
  modelsForComposerKind,
  normalizeStoredConfig,
  withComposerKind,
  withCurrentModel,
} from "../src/config/loadConfig.js";
import type { StoredConfig, StoredModel } from "../src/config/types.js";
import { inferVideoGenMode } from "../src/config/videoOptions.js";

function model(over: Partial<StoredModel> & Pick<StoredModel, "id" | "kind">): StoredModel {
  return {
    name: over.id,
    baseUrl: "https://example.com",
    model: over.id,
    apiKey: "k",
    ...over,
  };
}

function cfg(over: Partial<StoredConfig> & { models: StoredModel[] }): StoredConfig {
  return normalizeStoredConfig({
    baseUrl: "",
    model: "",
    apiKey: "",
    ...over,
  });
}

describe("composerKind", () => {
  it("parses and labels composer categories", () => {
    expect(parseComposerKind(undefined)).toBe("text");
    expect(parseComposerKind("video")).toBe("video");
    expect(COMPOSER_KIND_LABELS.video).toBe("生视频");
    expect(COMPOSER_SEND_LABELS.image).toBe("生成图片");
  });

  it("keeps current model inside the active composer kind", () => {
    const stored = cfg({
      models: [
        model({ id: "t1", kind: "text" }),
        model({ id: "v1", kind: "video" }),
        model({ id: "i1", kind: "image" }),
      ],
      composerKind: "video",
      currentModelId: "t1",
    });
    expect(composerKindOf(stored)).toBe("video");
    expect(currentModelOf(stored)?.id).toBe("v1");
    expect(modelsForComposerKind(stored, "text").map((m) => m.id)).toEqual(["t1"]);
  });

  it("withComposerKind restores the remembered model for that kind", () => {
    let stored = cfg({
      models: [
        model({ id: "t1", kind: "text" }),
        model({ id: "t2", kind: "text" }),
        model({ id: "v1", kind: "video" }),
      ],
      composerKind: "text",
      currentModelId: "t2",
    });
    stored = withComposerKind(stored, "video");
    expect(stored.composerKind).toBe("video");
    expect(stored.currentModelId).toBe("v1");
    stored = withComposerKind(stored, "text");
    expect(stored.currentModelId).toBe("t2");
  });

  it("withCurrentModel switches composerKind to that model's kind", () => {
    const stored = withCurrentModel(
      cfg({
        models: [model({ id: "t1", kind: "text" }), model({ id: "i1", kind: "image" })],
        composerKind: "text",
        currentModelId: "t1",
      }),
      "i1",
    );
    expect(stored.composerKind).toBe("image");
    expect(stored.currentModelId).toBe("i1");
    expect(stored.currentModelByKind?.image).toBe("i1");
  });

  it("infers video mode from attachments", () => {
    expect(inferVideoGenMode(0, 0, 0)).toBe("text");
    expect(inferVideoGenMode(1, 0, 0)).toBe("first_frame");
    expect(inferVideoGenMode(2, 0, 0)).toBe("first_last");
    expect(inferVideoGenMode(3, 0, 0)).toBe("reference");
    expect(inferVideoGenMode(0, 1, 0)).toBe("reference");
    expect(inferVideoGenMode(1, 0, 1)).toBe("reference");
  });
});
