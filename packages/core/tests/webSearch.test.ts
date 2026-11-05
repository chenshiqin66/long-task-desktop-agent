import { describe, it, expect } from "vitest";
import { ToolHost, createBuiltinTools, resolveWebSearchUrl } from "../src/tools/host.js";
import type { ToolContext } from "../src/tools/types.js";

function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspacePath: "/tmp/ws",
    bashTimeoutMs: 5_000,
    maxToolOutputChars: 8_000,
    maxReadChars: 50,
    maxSearchResults: 10,
    apiKey: "sk-test",
    llmBaseUrl: "https://api.deepseek.com/v1",
    ...over,
  };
}

describe("web_search", () => {
  it("resolveWebSearchUrl derives /v1/tools/search from chat base", () => {
    expect(resolveWebSearchUrl({ llmBaseUrl: "https://api.deepseek.com/v1" })).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(resolveWebSearchUrl({ llmBaseUrl: "https://api.deepseek.com" })).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(resolveWebSearchUrl({ searchBaseUrl: "https://gw.example/v1" })).toBe(
      "https://gw.example/v1/tools/search",
    );
  });

  it("errors without api key", async () => {
    const host = new ToolHost(createBuiltinTools());
    const r = await host.execute(
      "web_search",
      JSON.stringify({ query: "hello" }),
      baseCtx({ apiKey: "" }),
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/api key/i);
  });

  it("posts to DeepSeek search and formats results", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "DeepSeek V4",
              url: "https://example.com/v4",
              snippet: "short",
              summary: "DeepSeek released V4 with tools.",
              content: "",
              authority: 3,
              rerank_score: 2.1,
              date: "2026-06-01T00:00:00+00:00",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const host = new ToolHost(createBuiltinTools());
    const r = await host.execute(
      "web_search",
      JSON.stringify({ query: "DeepSeek V4", count: 5 }),
      baseCtx({ fetchImpl }),
    );
    expect(r.is_error).toBe(false);
    expect(r.content).toContain("DeepSeek V4");
    expect(r.content).toContain("https://example.com/v4");
    expect(r.content).toContain("DeepSeek released V4");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      query: string;
      count: number;
      need_content: boolean;
    };
    expect(body.query).toBe("DeepSeek V4");
    expect(body.count).toBe(5);
    expect(body.need_content).toBe(false);
  });

  it("surfaces HTTP errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429 });
    const host = new ToolHost(createBuiltinTools());
    const r = await host.execute(
      "web_search",
      JSON.stringify({ query: "x" }),
      baseCtx({ fetchImpl }),
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/429/);
  });

  it("truncates overlong query to 128 chars", async () => {
    let sent = "";
    const fetchImpl: typeof fetch = async (_u, init) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const host = new ToolHost(createBuiltinTools());
    const long = "字".repeat(200);
    await host.execute("web_search", JSON.stringify({ query: long }), baseCtx({ fetchImpl }));
    const body = JSON.parse(sent) as { query: string };
    expect([...body.query].length).toBe(128);
  });
});
