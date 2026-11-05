import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../src/provider/openaiCompatible.js";

describe("OpenAICompatibleProvider", () => {
  it("parses SSE text deltas", async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"!"}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      fetchImpl,
    });
    const texts: string[] = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      if (c.type === "text" && c.text) texts.push(c.text);
    }
    expect(texts.join("")).toBe("Hi!");
  });

  it("surfaces HTTP auth errors as error chunk", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
      });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "bad",
      fetchImpl,
    });
    const chunks = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === "error")).toBe(true);
  });

  it("maps tool_calls deltas into tool_call_delta chunks", async () => {
    const args = JSON.stringify({ command: "pwd" }).replace(/"/g, '\\"');
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"${args}"}}]}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200 });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    const tools = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      if (c.type === "tool_call_delta") tools.push(c.tool_call);
    }
    expect(tools[0]?.function.name).toBe("bash");
  });

  it("merges fragmented tool_call argument deltas before emitting", async () => {
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"com"}}]}}]}\n\n` +
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\\":\\"pwd\\"}"}}]}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200 });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1/",
      apiKey: "sk",
      fetchImpl,
    });
    const tools = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      if (c.type === "tool_call_delta") tools.push(c.tool_call);
    }
    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBe("call_1");
    expect(tools[0]?.function.name).toBe("bash");
    expect(JSON.parse(tools[0]!.function.arguments)).toEqual({ command: "pwd" });
  });

  it("passes AbortSignal to fetch and stops cleanly when aborted", async () => {
    const ac = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sawSignal = init?.signal ?? undefined;
      ac.abort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    const chunks = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
      signal: ac.signal,
    })) {
      chunks.push(c);
    }
    expect(sawSignal).toBe(ac.signal);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("posts to baseUrl/chat/completions with bearer auth (no trailing slash double)", async () => {
    let url = "";
    let auth = "";
    let body: any;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      body = JSON.parse(String(init?.body));
      const sse = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200 });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1/",
      apiKey: "sk-secret-key",
      fetchImpl,
    });
    for await (const _ of p.chatStream({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "bash",
          description: "run",
          parameters: { type: "object", properties: {} },
        },
      ],
      model: "gpt-x",
    })) {
      /* drain */
    }
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(auth).toBe("Bearer sk-secret-key");
    expect(body.model).toBe("gpt-x");
    expect(body.stream).toBe(true);
    expect(body.tools[0].function.name).toBe("bash");
  });
});
