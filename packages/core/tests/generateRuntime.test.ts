import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type {
  ImageGenRequest,
  LlmChatRequest,
  LlmProvider,
  SpeechGenRequest,
  TranscribeRequest,
  VideoGenRequest,
} from "../src/provider/types.js";
import type { ModelKind } from "../src/config/modelKind.js";
import { defaultVideoModelOptions, type VideoModelOptions } from "../src/config/videoOptions.js";
import { defaultImageModelOptions, type ImageModelOptions } from "../src/config/imageOptions.js";
import { defaultTtsModelOptions } from "../src/config/speechOptions.js";
import type { RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_ALT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const VIDEO = Buffer.from("fake-mp4").toString("base64");
const AUDIO = Buffer.from("fake-mp3").toString("base64");

type ImageProvider = LlmProvider & {
  generateImage: (req: ImageGenRequest) => Promise<{ mime: "image/png"; base64: string }>;
};
type VideoProvider = LlmProvider & {
  generateVideo: (req: VideoGenRequest) => Promise<{ mime: "video/mp4"; base64: string }>;
};
type SpeechProvider = LlmProvider & {
  generateSpeech: (req: SpeechGenRequest) => Promise<{ mime: "audio/mpeg"; base64: string }>;
  transcribeAudio: (req: TranscribeRequest) => Promise<string>;
};

function makeRuntime(
  workspace: string,
  kind: ModelKind,
  provider: LlmProvider,
  video?: VideoModelOptions,
  image?: ImageModelOptions,
): AgentRuntime {
  return new AgentRuntime({
    workspacePath: workspace,
    config: {
      baseUrl: "http://localhost",
      model:
        kind === "image"
          ? "draw"
          : kind === "video"
            ? "MiniMax-H3-Lite"
            : kind === "tts"
              ? "seed-tts-2.0"
              : kind === "asr"
                ? "bigmodel"
                : "test",
      apiKey: "sk-test",
      ...DEFAULT_AGENT_CONFIG,
      kind,
      ...(kind === "video"
        ? {
            video: video ?? defaultVideoModelOptions("MiniMax-H3-Lite"),
          }
        : {}),
      ...(kind === "tts" ? { tts: defaultTtsModelOptions() } : {}),
      ...(kind === "image"
        ? { image: image ?? defaultImageModelOptions("Doubao-Seedream-5.0-pro") }
        : {}),
    },
    provider,
  });
}

function imageProvider(opts?: {
  generate?: (req: ImageGenRequest) => Promise<{ mime: "image/png"; base64: string }>;
  onChat?: (req: LlmChatRequest) => void;
}): { provider: ImageProvider; generateCalls: ImageGenRequest[]; chatCalls: LlmChatRequest[] } {
  const generateCalls: ImageGenRequest[] = [];
  const chatCalls: LlmChatRequest[] = [];
  const provider: ImageProvider = {
    chatStream(req) {
      chatCalls.push(req);
      opts?.onChat?.(req);
      throw new Error("chatStream should not be called");
    },
    async generateImage(req) {
      generateCalls.push(req);
      if (opts?.generate) return opts.generate(req);
      return { mime: "image/png", base64: PNG };
    },
  };
  return { provider, generateCalls, chatCalls };
}

function textProvider(): { provider: LlmProvider; chatCalls: LlmChatRequest[] } {
  const chatCalls: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    chatStream(req) {
      chatCalls.push(req);
      return (async function* () {
        yield { type: "text" as const, text: "看到了" };
      })();
    },
  };
  return { provider, chatCalls };
}

function videoProvider(opts?: {
  generate?: (req: VideoGenRequest) => Promise<{ mime: "video/mp4"; base64: string }>;
}): { provider: VideoProvider; generateCalls: VideoGenRequest[]; chatCalls: LlmChatRequest[] } {
  const generateCalls: VideoGenRequest[] = [];
  const chatCalls: LlmChatRequest[] = [];
  const provider: VideoProvider = {
    chatStream(req) {
      chatCalls.push(req);
      throw new Error("chatStream should not be called");
    },
    async generateVideo(req) {
      generateCalls.push(req);
      if (opts?.generate) return opts.generate(req);
      return { mime: "video/mp4", base64: VIDEO };
    },
  };
  return { provider, generateCalls, chatCalls };
}

function errorMessage(events: RuntimeEvent[], thrown: unknown): string {
  const fromEvent = events.find((event) => event.type === "error")?.message ?? "";
  const fromThrow = thrown instanceof Error ? thrown.message : "";
  return fromEvent || fromThrow;
}

describe("runtime routing by model kind", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-gen-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("generates an image from the prompt and does not call chatStream", async () => {
    const { provider, generateCalls, chatCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫");

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({ model: "draw", prompt: "一只猫" });
    expect(generateCalls[0]?.images).toBeUndefined();

    const stored = await rt.loadMessages(meta.session_id);
    const assistant = stored.find((message) => message.role === "assistant");
    expect(assistant?.images?.[0]?.path).toMatch(/^images\/img_[a-f0-9]+\.png$/);
    expect(events.some((event) => event.type === "generated_images")).toBe(true);
    const generated = events.find((event) => event.type === "generated_images");
    expect(generated && generated.type === "generated_images" ? generated.images[0]?.path : undefined).toMatch(
      /^images\/img_[a-f0-9]+\.png$/,
    );
    expect(events.some((event) => event.type === "status" && event.phase === "generating_image")).toBe(true);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
    const { context } = await rt.loadSessionArtifacts(meta.session_id);
    expect(context).toEqual([
      expect.objectContaining({
        type: "request",
        kind: "image",
        model: "draw",
        messages: [{ role: "user", text: "一只猫" }],
      }),
    ]);
    expect((context[0] as { tools_sha256?: unknown }).tools_sha256).toBeUndefined();
  });

  it("sends this turn's user images as reference data URLs", async () => {
    const { provider, generateCalls, chatCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫", [{ mime: "image/png", base64: PNG }]);

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.images).toEqual([{ dataUrl: `data:image/png;base64,${PNG}` }]);
    const user = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "user");
    expect(JSON.stringify(user)).not.toContain(PNG);
    const { context } = await rt.loadSessionArtifacts(meta.session_id);
    expect(context).toEqual([
      expect.objectContaining({
        type: "request",
        kind: "image",
        messages: [
          {
            role: "user",
            text: "一只猫",
                        images: [expect.objectContaining({ path: expect.stringMatching(/^images\/img_[a-f0-9]+\.png$/) })],
          },
        ],
      }),
    ]);
  });

  it("rejects an empty image prompt without calling the provider", async () => {
    const { provider, generateCalls, chatCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "");
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toBe("生图请先输入提示词");
    expect((await rt.loadSessionArtifacts(meta.session_id)).context).toEqual([]);
  });

  it("rejects image generation when this turn includes a video", async () => {
    const { provider, generateCalls, chatCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "一只猫", undefined, [{ mime: "video/mp4", base64: VIDEO }]);
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toBe("生图不发送视频，请先去掉视频，或改用生文模型");
    expect((await rt.loadSessionArtifacts(meta.session_id)).context).toEqual([]);
  });

  it("synthesizes speech and does not call chatStream", async () => {
    const speechCalls: SpeechGenRequest[] = [];
    const chatCalls: LlmChatRequest[] = [];
    const provider: SpeechProvider = {
      chatStream(req) {
        chatCalls.push(req);
        throw new Error("chatStream should not be called");
      },
      async generateSpeech(req) {
        speechCalls.push(req);
        return { mime: "audio/mpeg", base64: AUDIO };
      },
      async transcribeAudio() {
        throw new Error("transcribeAudio should not be called");
      },
    };
    const rt = makeRuntime(workspace, "tts", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "你好世界");

    expect(chatCalls).toHaveLength(0);
    expect(speechCalls).toHaveLength(1);
    expect(speechCalls[0]?.text).toBe("你好世界");
    const assistant = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "assistant");
    expect(assistant?.audios?.[0]?.path).toMatch(/^audios\/aud_[a-f0-9]+\.mp3$/);
    expect(events.some((event) => event.type === "generated_audios")).toBe(true);
    expect(events.some((event) => event.type === "status" && event.phase === "generating_speech")).toBe(true);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
  });

  it("rejects ASR without an audio attachment", async () => {
    const provider: SpeechProvider = {
      chatStream() {
        throw new Error("chatStream should not be called");
      },
      async generateSpeech() {
        throw new Error("generateSpeech should not be called");
      },
      async transcribeAudio() {
        throw new Error("transcribeAudio should not be called");
      },
    };
    const rt = makeRuntime(workspace, "asr", provider);
    const meta = await rt.createSession();
    await expect(rt.submit(meta.session_id, "备注")).rejects.toThrow("语音识别请先添加一段音频");
  });

  it("transcribes an uploaded audio and does not call chatStream", async () => {
    const asrCalls: TranscribeRequest[] = [];
    const chatCalls: LlmChatRequest[] = [];
    const provider: SpeechProvider = {
      chatStream(req) {
        chatCalls.push(req);
        throw new Error("chatStream should not be called");
      },
      async generateSpeech() {
        throw new Error("generateSpeech should not be called");
      },
      async transcribeAudio(req) {
        asrCalls.push(req);
        return "转写结果";
      },
    };
    const rt = makeRuntime(workspace, "asr", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "", undefined, undefined, [{ mime: "audio/mpeg", base64: AUDIO }]);

    expect(chatCalls).toHaveLength(0);
    expect(asrCalls).toHaveLength(1);
    expect(asrCalls[0]?.format).toBe("mp3");
    const assistant = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("转写结果");
    expect(events.some((event) => event.type === "status" && event.phase === "transcribing")).toBe(true);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
  });

  it("generates a video from the prompt and does not call chatStream", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫在跑");

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({ model: "MiniMax-H3-Lite", prompt: "一只猫在跑" });
    expect(generateCalls[0]?.images).toBeUndefined();

    const stored = await rt.loadMessages(meta.session_id);
    const assistant = stored.find((message) => message.role === "assistant");
    expect(assistant?.videos?.[0]?.path).toMatch(/^videos\/vid_[a-f0-9]+\.mp4$/);
    expect(events.some((event) => event.type === "generated_videos")).toBe(true);
    expect(events.some((event) => event.type === "status" && event.phase === "generating_video")).toBe(true);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
    const { context } = await rt.loadSessionArtifacts(meta.session_id);
    expect(context).toEqual([
      expect.objectContaining({
        type: "request",
        kind: "video",
        model: "MiniMax-H3-Lite",
        messages: [{ role: "user", text: "一只猫在跑" }],
      }),
    ]);
  });

  it("sends this turn's user image as the video first frame", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "镜头推进", [{ mime: "image/png", base64: PNG }]);

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.images).toEqual([{ dataUrl: `data:image/png;base64,${PNG}` }]);
    expect(generateCalls[0]?.mode).toBe("text");
  });

  it("sends last_frame mode with one image", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider, {
      ...defaultVideoModelOptions("MiniMax-H3-Lite"),
      mode: "last_frame",
      ratio: "adaptive",
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "定格结尾", [{ mime: "image/png", base64: PNG }]);

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.mode).toBe("last_frame");
    expect(generateCalls[0]?.images).toHaveLength(1);
  });

  it("sends first_last mode with two images in order", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider, {
      ...defaultVideoModelOptions("MiniMax-H3-Lite"),
      mode: "first_last",
      ratio: "adaptive",
    });
    const meta = await rt.createSession();
    const PNG2 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await rt.submit(meta.session_id, "从站到走", [
      { mime: "image/png", base64: PNG },
      { mime: "image/png", base64: PNG2 },
    ]);

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.mode).toBe("first_last");
    expect(generateCalls[0]?.images).toEqual([
      { dataUrl: `data:image/png;base64,${PNG}` },
      { dataUrl: `data:image/png;base64,${PNG2}` },
    ]);
  });

  it("rejects first_last when only one image is attached", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider, {
      ...defaultVideoModelOptions("MiniMax-H3-Lite"),
      mode: "first_last",
      ratio: "adaptive",
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "从站到走", [{ mime: "image/png", base64: PNG }]);
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toMatch(/两张图/);
  });

  it("rejects an empty video prompt without calling the provider", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "");
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toBe("生视频请先输入提示词");
  });

  it("rejects a reference video when the default mode is not reference", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "一只猫", undefined, [{ mime: "video/mp4", base64: VIDEO }]);
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toMatch(/参考视频/);
  });

  it("sends reference images and videos when mode is reference", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider, {
      ...defaultVideoModelOptions("MiniMax-H3-Lite"),
      mode: "reference",
      ratio: "16:9",
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(
      meta.session_id,
      "<Picture 1> 跳舞",
      [{ mime: "image/png", base64: PNG }],
      [{ mime: "video/mp4", base64: VIDEO }],
      [{ mime: "audio/mpeg", base64: AUDIO }],
    );

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.mode).toBe("reference");
    expect(generateCalls[0]?.images).toHaveLength(1);
    expect(generateCalls[0]?.videos).toHaveLength(1);
    expect(generateCalls[0]?.audios).toHaveLength(1);
    expect(generateCalls[0]?.ratio).toBe("16:9");
    expect(events.some((event) => event.type === "generated_videos")).toBe(true);
    const assistant = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "assistant");
    expect(assistant?.videos?.[0]?.path).toMatch(/^videos\/vid_[a-f0-9]+\.mp4$/);
  });

  it("rejects reference mode with audio only", async () => {
    const { provider, generateCalls, chatCalls } = videoProvider();
    const rt = makeRuntime(workspace, "video", provider, {
      ...defaultVideoModelOptions("MiniMax-H3-Lite"),
      mode: "reference",
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    let thrown: unknown;
    try {
      await rt.submit(meta.session_id, "只有声音", undefined, undefined, [
        { mime: "audio/mpeg", base64: AUDIO },
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(errorMessage(events, thrown)).toMatch(/参考音频需同时/);
  });

  it("inlines a video_url on the latest user message for a text model", async () => {
    const { provider, chatCalls } = textProvider();
    const rt = makeRuntime(workspace, "text", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "请看", undefined, [{ mime: "video/mp4", base64: VIDEO }]);

    expect(chatCalls).toHaveLength(1);
    const user = [...(chatCalls[0]?.messages ?? [])].reverse().find((message) => message.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    if (!Array.isArray(user?.content)) return;
    expect(user.content.some((part) => part.type === "video_url")).toBe(true);
    const stored = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "user");
    expect(stored?.videos?.[0]?.path).toMatch(/^videos\/vid_[a-f0-9]+\.mp4$/);
    expect(JSON.stringify(stored)).not.toContain(VIDEO);
  });

  it("resends a stored video when the user message is replayed", async () => {
    const { provider, chatCalls } = textProvider();
    const rt = makeRuntime(workspace, "text", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "请看", undefined, [{ mime: "video/mp4", base64: VIDEO }]);
    const first = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "user");
    const video = first?.videos?.[0];
    expect(video).toBeTruthy();

    await rt.replay(meta.session_id, "请看", [], [video!]);

    expect(chatCalls).toHaveLength(2);
    const latest = [...(chatCalls[1]?.messages ?? [])].reverse().find((message) => message.role === "user");
    expect(Array.isArray(latest?.content)).toBe(true);
    if (!Array.isArray(latest?.content)) return;
    expect(latest.content.some((part) => part.type === "video_url")).toBe(true);
    const users = (await rt.loadMessages(meta.session_id)).filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users.every((message) => message.videos?.[0]?.path === video?.path)).toBe(true);
  });

  it("leaves no assistant image message when generateImage fails with HTTP 400", async () => {
    const { provider, generateCalls, chatCalls } = imageProvider({
      generate: async () => {
        throw new Error("HTTP 400: nope");
      },
    });
    const rt = makeRuntime(workspace, "image", provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫");

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(1);
    const stored = await rt.loadMessages(meta.session_id);
    expect(stored.some((message) => message.role === "assistant")).toBe(false);
    expect(errorMessage(events, undefined)).toMatch(/HTTP 400/);
    expect(events.some((event) => event.type === "done" && event.reason === "error")).toBe(true);
  });

  it("sends the configured image options", async () => {
    const { provider, generateCalls } = imageProvider();
    const image = {
      ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
      size: "1.5K" as const,
      ratio: "16:9" as const,
      format: "png" as const,
      background: "transparent" as const,
      watermark: false,
      promptMode: "fast" as const,
    };
    const rt = makeRuntime(workspace, "image", provider, undefined, image);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫", [{ mime: "image/png", base64: PNG }]);

    expect(generateCalls[0]).toMatchObject({
      size: "1920x1080",
      outputFormat: "png",
      background: "transparent",
      watermark: false,
      promptMode: "fast",
    });
  });

  it("applies this turn's image overrides", async () => {
    const { provider, generateCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫", [{ mime: "image/png", base64: PNG }], undefined, undefined, {
      image: {
        size: "1.5K",
        ratio: "9:16",
        format: "png",
        background: "transparent",
        watermark: false,
        promptMode: "fast",
      },
    });

    expect(generateCalls[0]).toMatchObject({
      size: "1080x1920",
      outputFormat: "png",
      background: "transparent",
      watermark: false,
      promptMode: "fast",
    });
  });

  it("ignores image overrides the model does not enable", async () => {
    const { provider, generateCalls } = imageProvider();
    const rt = makeRuntime(workspace, "image", provider);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫", undefined, undefined, undefined, {
      image: { size: "4K", ratio: "21:9", format: "gif" },
    });

    expect(generateCalls[0]).toMatchObject({ size: "2K", outputFormat: "jpeg" });
  });

  it("forces png when the configured background is transparent", async () => {
    const { provider, generateCalls } = imageProvider();
    const image = {
      ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
      background: "transparent" as const,
      format: "jpeg" as const,
    };
    const rt = makeRuntime(workspace, "image", provider, undefined, image);
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫", [{ mime: "image/png", base64: PNG }]);

    expect(generateCalls[0]).toMatchObject({ background: "transparent", outputFormat: "png" });
  });

  it("does not send prompt mode for a model without fast", async () => {
    const { provider, generateCalls } = imageProvider();
    const rt = makeRuntime(
      workspace,
      "image",
      provider,
      undefined,
      defaultImageModelOptions("Doubao-Seedream-5.5"),
    );
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "一只猫");

    expect(generateCalls[0]?.promptMode).toBeUndefined();
  });

  it("only sends transparent background with exactly one reference image", async () => {
    const { provider, generateCalls } = imageProvider();
    const image = {
      ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
      background: "transparent" as const,
      format: "png" as const,
    };
    const rt = makeRuntime(workspace, "image", provider, undefined, image);
    const meta = await rt.createSession();

    await rt.submit(meta.session_id, "无参考图");
    expect(generateCalls[0]?.background).toBe("opaque");

    await rt.submit(meta.session_id, "一张参考图", [{ mime: "image/png", base64: PNG }]);
    expect(generateCalls[1]?.background).toBe("transparent");

    await rt.submit(meta.session_id, "两张参考图", [
      { mime: "image/png", base64: PNG },
      { mime: "image/png", base64: PNG_ALT },
    ]);
    expect(generateCalls[2]?.background).toBe("opaque");
  });
});
