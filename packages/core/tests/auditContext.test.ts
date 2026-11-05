import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { imageOmissionNote } from "../src/context/images.js";
import type { LlmProvider } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { rmWorkspace } from "./rmWorkspace.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG, "base64").length;

function textOnly(text: string): LlmProvider {
  return {
    chatStream() {
      return (async function* () {
        yield { type: "text" as const, text };
      })();
    },
  };
}

describe("outbound context audit", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-audit-"));
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("records the sent text and image path, not pixels or the api key", async () => {
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: {
        baseUrl: "http://localhost",
        model: "test-model",
        apiKey: "sk-test",
        ...DEFAULT_AGENT_CONFIG,
      },
      provider: textOnly("好"),
    });
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "看图", [{ mime: "image/png", base64: PNG }]);
    await rt.submit(meta.session_id, "继续");

    const raw = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "context.jsonl"),
      "utf8",
    );
    expect(raw).not.toContain(PNG);
    expect(raw).not.toContain("sk-test");
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain("Authorization");

    const rows = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const tools = rows.filter((row) => row.type === "tools");
    const requests = rows.filter((row) => row.type === "request");
    expect(tools).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools_sha256).toBe(tools[0]?.sha256);
    expect(requests[1]?.tools_sha256).toBe(tools[0]?.sha256);
    expect(requests[1]).not.toHaveProperty("tools");

    const firstMessages = requests[0]?.messages as Array<{
      role: string;
      text: string;
      images?: Array<{ path: string; bytes: number }>;
    }>;
    const seen = firstMessages.find((message) => message.role === "user");
    expect(seen?.text).toBe("看图");
    expect(seen?.images?.[0]?.path).toMatch(/^images\/img_[a-f0-9]+\.png$/);
    expect(seen?.images?.[0]?.bytes).toBe(PNG_BYTES);

    const secondMessages = requests[1]?.messages as Array<{
      role: string;
      text: string;
      images?: unknown;
    }>;
    const older = secondMessages.find((message) => message.text.includes("看图"));
    expect(older?.text).toBe(`看图\n${imageOmissionNote(1)}`);
    expect(older).not.toHaveProperty("images");

    const stored = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "messages.jsonl"),
      "utf8",
    );
    expect(stored).not.toContain("像素未再次发送");
    expect(stored).not.toContain(PNG);

    const traces = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "trace.jsonl"),
      "utf8",
    );
    const llm = traces
      .split("\n")
      .filter((line) => line.includes('"llm_request"'))
      .map((line) => JSON.parse(line) as { id: string; detail?: { context_id?: string } });
    expect(llm.map((row) => row.detail?.context_id)).toEqual(requests.map((row) => row.id));

    const artifacts = await rt.loadSessionArtifacts(meta.session_id);
    expect(artifacts.context).toEqual(rows);
  });
});
