import { describe, it, expect } from "vitest";
import {
  buildVideoGenerationBody,
  defaultVideoDuration,
  defaultVideoResolution,
  normalizeVideoModelId,
  parseVideoTaskId,
  parseVideoTaskQuery,
  videoApiRoot,
} from "../src/provider/videoGeneration.js";

describe("video generation helpers", () => {
  it("strips a trailing /v1 from OpenAI-style base URLs", () => {
    expect(videoApiRoot("https://api.ppio.com/v1")).toBe("https://api.ppio.com");
    expect(videoApiRoot("https://api.ppio.com/v1/")).toBe("https://api.ppio.com");
    expect(videoApiRoot("https://api.ppio.com")).toBe("https://api.ppio.com");
  });

  it("normalizes marketing labels to API model ids", () => {
    expect(normalizeVideoModelId("MiniMax H3 Lite")).toBe("MiniMax-H3-Lite");
    expect(normalizeVideoModelId("minimax-h3-lite")).toBe("MiniMax-H3-Lite");
    expect(normalizeVideoModelId("MiniMax H3")).toBe("MiniMax-H3");
    expect(buildVideoGenerationBody({ model: "MiniMax H3 Lite", prompt: "一只猫在跑" }).model).toBe(
      "MiniMax-H3-Lite",
    );
  });

  it("defaults resolution and duration by model", () => {
    expect(defaultVideoResolution("MiniMax-H3")).toBe("768P");
    expect(defaultVideoResolution("MiniMax-H3-Lite")).toBe("480P");
    expect(defaultVideoDuration("MiniMax-H3-Max")).toBe(5);
    expect(defaultVideoDuration("MiniMax-H3-Lite")).toBe(4);
  });

  it("builds a text-to-video body with a fixed ratio", () => {
    expect(buildVideoGenerationBody({ model: "MiniMax-H3-Lite", prompt: "一只猫在跑" })).toEqual({
      model: "MiniMax-H3-Lite",
      content: [{ type: "text", text: "一只猫在跑" }],
      resolution: "480P",
      duration: 4,
      ratio: "16:9",
    });
  });

  it("uses the first image as first_frame with adaptive ratio", () => {
    expect(
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "镜头推进",
        images: [{ dataUrl: "data:image/png;base64,AAA" }],
      }),
    ).toEqual({
      model: "MiniMax-H3-Lite",
      content: [
        { type: "text", text: "镜头推进" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAA" },
          role: "first_frame",
        },
      ],
      resolution: "480P",
      duration: 4,
      ratio: "adaptive",
    });
  });

  it("builds last_frame and first_last bodies", () => {
    expect(
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "定格",
        mode: "last_frame",
        images: [{ dataUrl: "data:image/png;base64,BBB" }],
      }).content,
    ).toEqual([
      { type: "text", text: "定格" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,BBB" },
        role: "last_frame",
      },
    ]);
    expect(
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "从站到走",
        mode: "first_last",
        images: [{ dataUrl: "data:image/png;base64,AAA" }, { dataUrl: "data:image/png;base64,BBB" }],
      }).content,
    ).toEqual([
      { type: "text", text: "从站到走" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAA" },
        role: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,BBB" },
        role: "last_frame",
      },
    ]);
  });

  it("rejects empty prompts and wrong image counts for frame modes", () => {
    expect(() => buildVideoGenerationBody({ model: "MiniMax-H3-Lite", prompt: "  " })).toThrow(
      /提示词/,
    );
    expect(() =>
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "x",
        images: [{ dataUrl: "a" }, { dataUrl: "b" }],
      }),
    ).toThrow(/首尾帧/);
    expect(() =>
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "x",
        mode: "last_frame",
        images: [],
      }),
    ).toThrow(/尾帧/);
    expect(() =>
      buildVideoGenerationBody({
        model: "MiniMax-H3-Lite",
        prompt: "x",
        mode: "first_last",
        images: [{ dataUrl: "a" }],
      }),
    ).toThrow(/两张/);
  });

  it("reads task_id from the create response", () => {
    expect(parseVideoTaskId({ task_id: "427916141998479" })).toBe("427916141998479");
    expect(() => parseVideoTaskId({})).toThrow(/task_id/);
  });

  it("parses query snapshots for running, success, and failure", () => {
    expect(
      parseVideoTaskQuery({
        task: { status: "running" },
      }),
    ).toEqual({ status: "running" });
    expect(
      parseVideoTaskQuery({
        task: { status: "succeeded", content: { url: "https://cdn.example/out.mp4" } },
      }),
    ).toEqual({ status: "succeeded", url: "https://cdn.example/out.mp4" });
    expect(
      parseVideoTaskQuery({
        task: { status: "failed", error: { code: "bad", message: "nope" } },
      }),
    ).toEqual({ status: "failed", error: "bad: nope" });
  });
});
