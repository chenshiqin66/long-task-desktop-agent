import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { imageOmissionNote, materializeImages } from "../src/context/images.js";
import type { LlmProvider, LlmChatRequest } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("prompt images", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-img-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("stores bytes beside the session and sends them as image parts", async () => {
    let seen: LlmChatRequest["messages"] = [];
    const provider: LlmProvider = {
      chatStream(req) {
        seen = req.messages;
        return (async function* () {
          yield { type: "text" as const, text: "看到了" };
        })();
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: {
        baseUrl: "http://localhost",
        model: "test",
        apiKey: "sk-test",
        ...DEFAULT_AGENT_CONFIG,
      },
      provider,
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "这是什么", [{ mime: "image/png", base64: PNG }]);

    const user = seen.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    if (!Array.isArray(user?.content)) return;
    expect(user.content[0]).toEqual({ type: "text", text: "这是什么" });
    expect(user.content[1]).toMatchObject({ type: "image_url" });
    const url = (user.content[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(user).not.toHaveProperty("images");

    const stored = await rt.loadMessages(meta.session_id);
    const row = stored.find((m) => m.role === "user");
    expect(row?.content).toBe("这是什么");
    expect(row?.images?.[0]?.path).toMatch(/^images\/img_[a-f0-9]+\.png$/);
    expect(JSON.stringify(row)).not.toContain(PNG);
  });

  it("refuses a path that escapes the session image folder", async () => {
    const store = new SessionStore(workspace);
    const meta = await store.createSession();
    await expect(store.readImageDataUrl(meta.session_id, "images/../../meta.json")).rejects.toThrow(
      /invalid image path/i,
    );
  });

  it("materializeImages leaves text messages unchanged", async () => {
    const out = await materializeImages(
      [{ role: "user", content: "只有字" }],
      async () => "data:image/png;base64,xx",
    );
    expect(out[0]?.content).toBe("只有字");
    expect(out[0]).not.toHaveProperty("images");
  });

  it("keeps pixels on the current user image and notes any older one", async () => {
    const reads: string[] = [];
    const out = await materializeImages(
      [
        { role: "user", content: "第一张", images: [{ id: "a", mime: "image/png", path: "images/old.png" }] },
        { role: "assistant", content: "看过了" },
        { role: "user", content: "第二张", images: [{ id: "b", mime: "image/png", path: "images/new.png" }] },
        { role: "tool", content: "ok", tool_call_id: "call_1" },
      ],
      async (path) => {
        reads.push(path);
        return `data:image/png;base64,${path}`;
      },
    );
    expect(reads).toEqual(["images/new.png"]);
    expect(out[0]?.content).toBe(`第一张\n${imageOmissionNote(1)}`);
    expect(out[0]).not.toHaveProperty("images");
    expect(out[2]?.content).toEqual([
      { type: "text", text: "第二张" },
      { type: "image_url", image_url: { url: "data:image/png;base64,images/new.png" } },
    ]);
  });

  it("drops pixels once a later user message has no image", async () => {
    const out = await materializeImages(
      [
        { role: "user", content: "看图", images: [{ id: "a", mime: "image/png", path: "images/old.png" }] },
        { role: "assistant", content: "好" },
        { role: "user", content: "继续" },
      ],
      async () => {
        throw new Error("should not read pixels");
      },
    );
    expect(out[0]?.content).toBe(`看图\n${imageOmissionNote(1)}`);
    expect(JSON.stringify(out)).not.toContain("image_url");
  });

  it("does not resend an older image on the next user turn", async () => {
    const seen: LlmChatRequest["messages"][] = [];
    const provider: LlmProvider = {
      chatStream(req) {
        seen.push(req.messages);
        return (async function* () {
          yield { type: "text" as const, text: "好" };
        })();
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: {
        baseUrl: "http://localhost",
        model: "test",
        apiKey: "sk-test",
        ...DEFAULT_AGENT_CONFIG,
      },
      provider,
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "看图", [{ mime: "image/png", base64: PNG }]);
    await rt.submit(meta.session_id, "继续");

    const second = JSON.stringify(seen[1]);
    expect(second).not.toContain(PNG);
    expect(second).toContain(imageOmissionNote(1));
    const stored = await rt.loadMessages(meta.session_id);
    const first = stored.find((m) => m.role === "user" && m.content === "看图");
    expect(first?.images).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("像素未再次发送");
  });
});
