import { describe, it, expect } from "vitest";
import { liveMediaMessageIndex, prepareOutbound, videoOmissionNote } from "../src/context/images.js";
import type { AssembledMessage } from "../src/context/assemble.js";

const video = { id: "vid_1", mime: "video/mp4" as const, path: "videos/vid_1.mp4" };
const image = { id: "img_1", mime: "image/png" as const, path: "images/img_1.png" };

describe("outbound media", () => {
  it("inlines only the latest user video as a video_url part", async () => {
    const messages: AssembledMessage[] = [
      { role: "user", content: "先看这个", videos: [video] },
      { role: "assistant", content: "好" },
      { role: "user", content: "再看这个", videos: [{ ...video, id: "vid_2", path: "videos/vid_2.mp4" }] },
    ];
    const prepared = await prepareOutbound(
      messages,
      async () => null,
      async (relativePath) =>
        relativePath === "videos/vid_2.mp4"
          ? { dataUrl: "data:video/mp4;base64,AAA", bytes: 3 }
          : null,
    );
    expect(prepared.messages[0]?.content).toBe(`先看这个\n${videoOmissionNote(1)}`);
    const last = prepared.messages[2];
    expect(Array.isArray(last?.content)).toBe(true);
    if (!Array.isArray(last?.content)) return;
    expect(last.content[0]).toEqual({ type: "text", text: "再看这个" });
    expect(last.content[1]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } });
    expect(last).not.toHaveProperty("videos");
  });

  it("returns the exact video omission note", () => {
    expect(videoOmissionNote(1)).toBe("（此轮附有 1 个视频，未再次发送。）");
    expect(videoOmissionNote(3)).toBe("（此轮附有 3 个视频，未再次发送。）");
  });

  it("uses 请看视频。 when the latest user message has only a video and no text", async () => {
    const prepared = await prepareOutbound(
      [{ role: "user", content: "  ", videos: [video] }],
      async () => null,
      async () => ({ dataUrl: "data:video/mp4;base64,AAA", bytes: 3 }),
    );
    expect(prepared.messages[0]?.content).toEqual([
      { type: "text", text: "请看视频。" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } },
    ]);
  });

  it("uses 请看附件。 when the latest user message has images and a video but no text", async () => {
    const prepared = await prepareOutbound(
      [{ role: "user", content: "", images: [image], videos: [video] }],
      async () => ({ dataUrl: "data:image/png;base64,IMG", bytes: 2 }),
      async () => ({ dataUrl: "data:video/mp4;base64,AAA", bytes: 3 }),
    );
    expect(prepared.messages[0]?.content).toEqual([
      { type: "text", text: "请看附件。" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } },
    ]);
    expect(prepared.messages[0]).not.toHaveProperty("images");
    expect(prepared.messages[0]).not.toHaveProperty("videos");
  });

  it("keeps 请看图片。 when the latest user message has only images and no text", async () => {
    const prepared = await prepareOutbound(
      [{ role: "user", content: "", images: [image] }],
      async () => ({ dataUrl: "data:image/png;base64,IMG", bytes: 2 }),
    );
    expect(prepared.messages[0]?.content).toEqual([
      { type: "text", text: "请看图片。" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
    ]);
  });

  it("orders text, then successfully read images, then successfully read videos", async () => {
    const prepared = await prepareOutbound(
      [
        {
          role: "user",
          content: "一起看",
          images: [image, { ...image, id: "img_2", path: "images/img_2.png" }],
          videos: [video],
        },
      ],
      async (relativePath) =>
        relativePath === "images/img_2.png" ? { dataUrl: "data:image/png;base64,TWO", bytes: 2 } : null,
      async () => ({ dataUrl: "data:video/mp4;base64,AAA", bytes: 3 }),
    );
    expect(prepared.messages[0]?.content).toEqual([
      { type: "text", text: "一起看" },
      { type: "image_url", image_url: { url: "data:image/png;base64,TWO" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } },
    ]);
  });

  it("still inlines images when only readImage is passed", async () => {
    const prepared = await prepareOutbound(
      [
        { role: "user", content: "旧图", images: [{ id: "old", mime: "image/png", path: "images/old.png" }] },
        { role: "assistant", content: "好" },
        { role: "user", content: "新图", images: [image] },
      ],
      async (relativePath) =>
        relativePath === image.path ? { dataUrl: "data:image/png;base64,IMG", bytes: 2 } : null,
    );
    expect(prepared.messages[0]?.content).toBe(`旧图\n（此轮附有 1 张图片，像素未再次发送。）`);
    expect(prepared.messages[2]?.content).toEqual([
      { type: "text", text: "新图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
    ]);
  });

  it("liveMediaMessageIndex follows the last user message", () => {
    expect(
      liveMediaMessageIndex([
        { role: "user", content: "先看", videos: [video] },
        { role: "assistant", content: "好" },
        { role: "user", content: "再看", images: [image] },
      ]),
    ).toBe(2);
    expect(
      liveMediaMessageIndex([
        { role: "user", content: "先看", videos: [video] },
        { role: "assistant", content: "好" },
        { role: "user", content: "继续" },
      ]),
    ).toBe(-1);
    expect(
      liveMediaMessageIndex([
        { role: "user", content: "看视频", videos: [video] },
        { role: "tool", content: "ok", tool_call_id: "call_1" },
      ]),
    ).toBe(0);
    expect(liveMediaMessageIndex([{ role: "assistant", content: "好" }])).toBe(-1);
  });

  it("notes older images and older videos on the same omitted message", async () => {
    const prepared = await prepareOutbound(
      [
        { role: "user", content: "上次", images: [image], videos: [video] },
        { role: "assistant", content: "好" },
        { role: "user", content: "继续" },
      ],
      async () => {
        throw new Error("should not read pixels");
      },
      async () => {
        throw new Error("should not read video");
      },
    );
    expect(prepared.messages[0]?.content).toBe(
      `上次\n（此轮附有 1 张图片，像素未再次发送。）\n${videoOmissionNote(1)}`,
    );
    expect(prepared.messages[0]).not.toHaveProperty("images");
    expect(prepared.messages[0]).not.toHaveProperty("videos");
    expect(prepared.messages[2]?.content).toBe("继续");
  });
});
