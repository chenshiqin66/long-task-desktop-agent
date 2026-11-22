import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getHomeInfo,
  homeWindowTitle,
  normalizeHomeLabel,
  readHomeMeta,
  writeHomeMeta,
} from "../src/config/homeMeta.js";

describe("homeMeta", () => {
  let legacy: string;
  let homeA: string;
  let homeB: string;

  beforeEach(async () => {
    legacy = await mkdtemp(join(tmpdir(), "legacy-home-"));
    homeA = join(legacy, "aaaa111111111111");
    homeB = join(legacy, "bbbb222222222222");
    await mkdir(homeA, { recursive: true });
    await mkdir(homeB, { recursive: true });
  });

  afterEach(async () => {
    await rm(legacy, { recursive: true, force: true });
  });

  it("normalizes and persists a label", async () => {
    expect(normalizeHomeLabel("  long-task-agent\n")).toBe("long-task-agent");
    expect(normalizeHomeLabel("x".repeat(50)).length).toBe(40);
    expect(readHomeMeta(homeA)).toEqual({ label: "" });
    await writeHomeMeta(homeA, { label: "  long-task-agent  " });
    expect(readHomeMeta(homeA)).toEqual({ label: "long-task-agent" });
    expect(homeWindowTitle("long-task-agent")).toBe("Long-Task Agent · long-task-agent");
    expect(homeWindowTitle("")).toBe("Long-Task Agent");
  });

  it("needsLabel only before home.json exists; empty label is an intentional official home", async () => {
    await writeHomeMeta(homeA, { label: "agent-labs" });
    const fresh = getHomeInfo(homeB, { legacyHome: legacy });
    expect(fresh.decided).toBe(false);
    expect(fresh.needsLabel).toBe(true);
    expect(fresh.siblings).toEqual([{ key: "aaaa111111111111", path: homeA, label: "agent-labs" }]);

    await writeHomeMeta(homeB, { label: "" });
    const official = getHomeInfo(homeB, { legacyHome: legacy });
    expect(official.decided).toBe(true);
    expect(official.needsLabel).toBe(false);
    expect(official.label).toBe("");
    expect(homeWindowTitle(official.label)).toBe("Long-Task Agent");
  });
});
