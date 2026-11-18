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
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools[0].function.name).toBe("bash");
  });

  it("yields usage only when the stream sends it", async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
      `data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200 });
    const p = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: "sk", fetchImpl });
    const chunks = [];
    for await (const chunk of p.chatStream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" })) {
      chunks.push(chunk);
    }
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });

  it("retries once without stream_options when the gateway rejects that field", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.stream_options) {
        return new Response("unknown field stream_options", { status: 400 });
      }
      return new Response(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`, { status: 200 });
    };
    const p = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: "sk", fetchImpl });
    const texts: string[] = [];
    for await (const chunk of p.chatStream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" })) {
      if (chunk.type === "text" && chunk.text) texts.push(chunk.text);
      if (chunk.type === "error") texts.push(chunk.error ?? "");
    }
    expect(bodies).toHaveLength(2);
    expect((bodies[1] as { stream_options?: unknown }).stream_options).toBeUndefined();
    expect(texts).toEqual(["ok"]);
  });

  it("posts generateImage to images/generations without tools and returns b64_json", async () => {
    const seen: { url?: string; body?: unknown } = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.url = String(input);
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), { status: 200 });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1/",
      apiKey: "sk-test",
      fetchImpl,
    });
    const result = await p.generateImage({ model: "draw", prompt: "一只猫" });
    expect(seen.url).toBe("https://example.com/v1/images/generations");
    expect(seen.body).toEqual({ model: "draw", prompt: "一只猫" });
    expect(result).toEqual({ mime: "image/png", base64: "QUJD" });
  });

  it("downloads a url result and surfaces HTTP errors", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.png" }] }), { status: 200 });
      }
      return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    const result = await p.generateImage({ model: "draw", prompt: "x" });
    expect(result.mime).toBe("image/png");
    expect(Buffer.from(result.base64, "base64").equals(png)).toBe(true);

    const failing = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl: async () => new Response("nope", { status: 400 }),
    });
    await expect(failing.generateImage({ model: "draw", prompt: "x" })).rejects.toThrow(/HTTP 400: nope/);
  });

  it("includes a single image or an image array in the generateImage body", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), { status: 200 });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    await p.generateImage({
      model: "draw",
      prompt: "一只猫",
      images: [{ dataUrl: "data:image/png;base64,AAA" }],
    });
    await p.generateImage({
      model: "draw",
      prompt: "一只猫",
      images: [
        { dataUrl: "data:image/png;base64,AAA" },
        { dataUrl: "data:image/png;base64,BBB" },
      ],
    });
    expect(bodies[0]).toEqual({
      model: "draw",
      prompt: "一只猫",
      image: "data:image/png;base64,AAA",
    });
    expect(bodies[1]).toEqual({
      model: "draw",
      prompt: "一只猫",
      image: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
    });
  });

  it("infers mime from the image URL suffix when Content-Type is missing", async () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.webp?x=1" }] }), { status: 200 });
      }
      return new Response(webp, { status: 200 });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    const result = await p.generateImage({ model: "draw", prompt: "x" });
    expect(result.mime).toBe("image/webp");
    expect(Buffer.from(result.base64, "base64").equals(webp)).toBe(true);
  });

  it("treats a non-2xx or empty image download as a generation failure", async () => {
    const notFound = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/images/generations")) {
          return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/missing.png" }] }), { status: 200 });
        }
        return new Response("gone", { status: 404 });
      },
    });
    await expect(notFound.generateImage({ model: "draw", prompt: "x" })).rejects.toThrow(/HTTP 404: gone/);

    const empty = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/images/generations")) {
          return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/empty.png" }] }), { status: 200 });
        }
        return new Response(new Uint8Array(), { status: 200, headers: { "Content-Type": "image/png" } });
      },
    });
    await expect(empty.generateImage({ model: "draw", prompt: "x" })).rejects.toThrow(/empty/i);
  });

  it("rethrows abort errors from generateImage without wrapping them", async () => {
    const ac = new AbortController();
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fetchImpl: typeof fetch = async () => {
      ac.abort();
      throw abortErr;
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    await expect(p.generateImage({ model: "draw", prompt: "x", signal: ac.signal })).rejects.toBe(abortErr);
  });

  it("does not put the api key into a generateImage error", async () => {
    const failing = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-secret-key",
      fetchImpl: async () => new Response("nope", { status: 400 }),
    });
    await expect(failing.generateImage({ model: "draw", prompt: "x" })).rejects.toSatisfy((err: unknown) => {
      const message = String(err);
      return /HTTP 400: nope/.test(message) && !message.includes("sk-secret-key");
    });
  });
});
