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
    searchApiKey: "sk-test",
    ...over,
  };
}

describe("web_search", () => {
  it("resolveWebSearchUrl defaults to DeepSeek and ignores the chat model", () => {
    expect(resolveWebSearchUrl({})).toBe("https://api.deepseek.com/v1/tools/search");
    expect(resolveWebSearchUrl({ searchBaseUrl: "   " })).toBe("https://api.deepseek.com/v1/tools/search");
    expect(resolveWebSearchUrl({ searchBaseUrl: "https://gw.example/v1" })).toBe(
      "https://gw.example/v1/tools/search",
    );
    expect(resolveWebSearchUrl({ searchBaseUrl: "https://gw.example/v1/tools/search" })).toBe(
      "https://gw.example/v1/tools/search",
    );
  });

  it("errors without searchApiKey and sends no request", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const host = new ToolHost(createBuiltinTools());
    const r = await host.execute(
      "web_search",
      JSON.stringify({ query: "hello" }),
      baseCtx({ searchApiKey: "", fetchImpl }),
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/API key/);
    expect(called).toBe(false);
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

  it("uses searchBaseUrl and searchApiKey, and defaults the URL to DeepSeek when blank", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), auth: headers.Authorization ?? "" });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const host = new ToolHost(createBuiltinTools());
    await host.execute(
      "web_search",
      JSON.stringify({ query: "q" }),
      baseCtx({
        fetchImpl,
        searchBaseUrl: "https://search.example/v1",
        searchApiKey: "sk-search",
      }),
    );
    await host.execute(
      "web_search",
      JSON.stringify({ query: "q" }),
      baseCtx({ fetchImpl, searchBaseUrl: "  ", searchApiKey: "sk-search" }),
    );
    expect(calls[0]).toEqual({
      url: "https://search.example/v1/tools/search",
      auth: "Bearer sk-search",
    });
    expect(calls[1]).toEqual({
      url: "https://api.deepseek.com/v1/tools/search",
      auth: "Bearer sk-search",
    });
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

  it("three calls in flight at once each get their own answer, and one 429 does not affect the others", async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // If the calls were sequential, the first would wait here forever. The timer
    // stops that from hanging the suite and makes peak < 3 fail the assertion.
    const guard = setTimeout(release, 3_000);
    const fetchImpl: typeof fetch = async (_u, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 3) release();
      await gate;
      inFlight -= 1;
      if (query === "fail") return new Response("quota exceeded", { status: 429 });
      return new Response(JSON.stringify({ results: [{ title: `T-${query}`, url: `https://e.example/${query}` }] }), {
        status: 200,
      });
    };
    const host = new ToolHost(createBuiltinTools());
    const ctx = baseCtx({ fetchImpl });
    const [a, b, c] = await Promise.all(
      ["alpha", "fail", "gamma"].map((query) => host.execute("web_search", JSON.stringify({ query }), ctx)),
    );
    clearTimeout(guard);
    expect(peak).toBe(3);
    expect(a!.is_error).toBe(false);
    expect(a!.content).toContain("T-alpha");
    expect(b!.is_error).toBe(true);
    expect(b!.content).toMatch(/429/);
    expect(c!.is_error).toBe(false);
    expect(c!.content).toContain("T-gamma");
  });

  it("each call honors only its own abort signal", async () => {
    const fetchImpl: typeof fetch = (_u, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })), 80);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const host = new ToolHost(createBuiltinTools());
    const stopped = new AbortController();
    const kept = new AbortController();
    const pending = Promise.all([
      host.execute("web_search", JSON.stringify({ query: "stop me" }), baseCtx({ fetchImpl, signal: stopped.signal })),
      host.execute("web_search", JSON.stringify({ query: "keep me" }), baseCtx({ fetchImpl, signal: kept.signal })),
    ]);
    setTimeout(() => stopped.abort(), 10);
    const [s, k] = await pending;
    expect(s!.is_error).toBe(true);
    expect(s!.content).toBe("web_search cancelled");
    expect(k!.is_error).toBe(false);
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
