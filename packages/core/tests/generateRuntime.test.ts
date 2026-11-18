import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { ImageGenRequest, LlmChatRequest, LlmProvider } from "../src/provider/types.js";
import type { ModelKind } from "../src/config/modelKind.js";
import type { RuntimeEvent } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VIDEO = Buffer.from("fake-mp4").toString("base64");
const UNSUPPORTED_KIND_TEXT = "这个类型第一版还不能用，请改选生文或生图";

type ImageProvider = LlmProvider & { generateImage: (req: ImageGenRequest) => Promise<{ mime: "image/png"; base64: string }> };

function makeRuntime(workspace: string, kind: ModelKind, provider: LlmProvider): AgentRuntime {
  return new AgentRuntime({
    workspacePath: workspace,
    config: {
      baseUrl: "http://localhost",
      model: kind === "image" ? "draw" : "test",
      apiKey: "sk-test",
      ...DEFAULT_AGENT_CONFIG,
      kind,
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
  });

  it.each(["video", "audio"] as const)("does not call the provider for %s models", async (kind) => {
    const { provider, generateCalls, chatCalls } = imageProvider();
    const rt = makeRuntime(workspace, kind, provider);
    const events: RuntimeEvent[] = [];
    rt.onEvent((event) => events.push(event));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "请生成");

    expect(chatCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    const assistant = (await rt.loadMessages(meta.session_id)).find((message) => message.role === "assistant");
    expect(assistant?.content).toBe(UNSUPPORTED_KIND_TEXT);
    expect(events.some((event) => event.type === "done" && event.reason === "completed")).toBe(true);
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
});
