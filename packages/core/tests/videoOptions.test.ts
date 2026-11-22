import { describe, it, expect } from "vitest";
import {
  defaultVideoModelOptions,
  normalizeVideoModelOptions,
  videoConstraintsOf,
} from "../src/config/videoOptions.js";
import { toAgentConfig } from "../src/config/loadConfig.js";

describe("video model options", () => {
  it("lists resolution and duration bounds per model", () => {
    expect(videoConstraintsOf("MiniMax-H3-Lite")).toMatchObject({
      resolutions: ["480P", "768P"],
      durationMin: 4,
      durationMax: 15,
      adaptiveAllowed: false,
    });
    expect(videoConstraintsOf("MiniMax-H3")).toMatchObject({
      resolutions: ["768P", "2K"],
      durationMin: 4,
    });
    expect(videoConstraintsOf("MiniMax-H3-Max").durationMin).toBe(5);
  });

  it("defaults to all legal choices checked", () => {
    const opts = defaultVideoModelOptions("MiniMax-H3-Lite");
    expect(opts.modes).toEqual(["text", "first_frame", "last_frame", "first_last", "reference"]);
    expect(opts.resolutions).toEqual(["480P", "768P"]);
    expect(opts.durations[0]).toBe(4);
    expect(opts.durations.at(-1)).toBe(15);
    expect(opts.ratios).toContain("16:9");
    expect(opts.ratios).toContain("adaptive");
    expect(opts.mode).toBe("text");
    expect(opts.resolution).toBe("480P");
    expect(opts.duration).toBe(4);
    expect(opts.ratio).toBe("16:9");
  });

  it("expands legacy single-value config into full enabled sets", () => {
    const opts = normalizeVideoModelOptions("MiniMax-H3-Lite", {
      mode: "first_frame",
      resolution: "768P",
      duration: 6,
      ratio: "9:16",
    });
    expect(opts.modes).toContain("first_frame");
    expect(opts.modes.length).toBeGreaterThan(1);
    expect(opts.resolutions).toEqual(["480P", "768P"]);
    expect(opts.mode).toBe("first_frame");
    expect(opts.resolution).toBe("768P");
    expect(opts.duration).toBe(6);
  });

  it("rejects empty enabled sets and text without a fixed ratio", () => {
    expect(() =>
      normalizeVideoModelOptions("MiniMax-H3-Lite", {
        modes: [],
        resolutions: ["480P"],
        durations: [4],
        ratios: ["16:9"],
      }),
    ).toThrow(/素材模式/);
    expect(() =>
      normalizeVideoModelOptions("MiniMax-H3-Lite", {
        modes: ["text"],
        resolutions: ["480P"],
        durations: [4],
        ratios: ["adaptive"],
      }),
    ).toThrow(/非 adaptive/);
  });

  it("carries video options into AgentConfig", () => {
    const video = defaultVideoModelOptions("MiniMax-H3-Lite");
    const agent = toAgentConfig({
      baseUrl: "https://api.ppio.com",
      model: "MiniMax-H3-Lite",
      apiKey: "sk",
      models: [
        {
          id: "m1",
          name: "派欧云",
          baseUrl: "https://api.ppio.com",
          model: "MiniMax-H3-Lite",
          apiKey: "sk",
          kind: "video",
          video,
        },
      ],
      currentModelId: "m1",
    });
    expect(agent.kind).toBe("video");
    expect(agent.video).toEqual(video);
  });
});
