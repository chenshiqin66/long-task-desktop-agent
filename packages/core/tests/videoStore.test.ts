import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, MAX_VIDEO_BYTES, sessionDir } from "../src/store/sessionStore.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("video attachments", () => {
  let workspace: string;
  let store: SessionStore;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-vid-"));
    store = new SessionStore(workspace);
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("stores a small mp4 under videos/ and reads it back as a data URL", async () => {
    const meta = await store.createSession();
    const bytes = Buffer.from("fake-mp4");
    const saved = await store.saveVideo(meta.session_id, "video/mp4", bytes.toString("base64"));
    expect(saved.id).toMatch(/^vid_[a-f0-9]+$/);
    expect(saved.mime).toBe("video/mp4");
    expect(saved.path).toBe(`videos/${saved.id}.mp4`);
    const onDisk = await readFile(join(sessionDir(workspace, meta.session_id), saved.path));
    expect(onDisk.equals(bytes)).toBe(true);
    const { dataUrl } = await store.readVideoForSend(meta.session_id, saved.path);
    expect(dataUrl).toBe(`data:video/mp4;base64,${bytes.toString("base64")}`);
  });

  it("rejects an empty or oversized video and an unknown type", async () => {
    const meta = await store.createSession();
    await expect(store.saveVideo(meta.session_id, "video/mp4", "")).rejects.toThrow(/empty or larger/i);
    const big = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1).toString("base64");
    await expect(store.saveVideo(meta.session_id, "video/mp4", big)).rejects.toThrow(/empty or larger/i);
    await expect(store.saveVideo(meta.session_id, "video/avi" as "video/mp4", "YQ==")).rejects.toThrow(/Unsupported video type/i);
  });

  it("rejects a path outside videos/", async () => {
    const meta = await store.createSession();
    await expect(store.readVideoForSend(meta.session_id, "images/img_ab.mp4")).rejects.toThrow(/Invalid video path/);
    await expect(store.readVideoForSend(meta.session_id, "videos/../meta.json")).rejects.toThrow(/Invalid video path/);
  });
});