import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

const QUERY_MAX = 128;

export function resolveWebSearchUrl(opts: {
  searchBaseUrl?: string;
  llmBaseUrl?: string;
}): string {
  const explicit = opts.searchBaseUrl?.trim().replace(/\/$/, "");
  if (explicit) {
    if (explicit.endsWith("/tools/search")) return explicit;
    if (explicit.endsWith("/v1")) return `${explicit}/tools/search`;
    return `${explicit}/v1/tools/search`;
  }
  const chat = (opts.llmBaseUrl ?? "https://api.deepseek.com/v1").trim().replace(/\/$/, "");
  if (chat.endsWith("/v1")) return `${chat}/tools/search`;
  return `${chat}/v1/tools/search`;
}

interface SearchHit {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  date?: string | null;
  authority?: number;
  rerank_score?: number;
}

function formatResults(results: SearchHit[]): string {
  if (!results.length) return "No search results.";
  return results
    .map((r, i) => {
      const lines = [
        `[${i + 1}] ${r.title ?? "(no title)"}`,
        `URL: ${r.url ?? ""}`,
      ];
      if (r.date) lines.push(`Date: ${r.date}`);
      if (typeof r.authority === "number") lines.push(`Authority: ${r.authority}`);
      if (typeof r.rerank_score === "number") lines.push(`Score: ${r.rerank_score}`);
      const body = (r.summary || r.snippet || "").trim();
      if (body) lines.push(body);
      return lines.join("\n");
    })
    .join("\n\n");
}

export const webSearchTool: Tool = {
  definition: {
    name: "web_search",
    description:
      "Search the live web via DeepSeek Search API. Use for current events or facts not in the workspace. Query max 128 characters. After using this tool, you MUST cite sources inline with [n] and end with a 来源 list of [n] [title](url) from the tool results (title is the link; do not print bare URLs).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (1–128 Unicode characters)",
        },
        count: {
          type: "integer",
          description: "Number of results (1–50, default 8)",
        },
        ori_question: {
          type: "string",
          description: "Optional original user question for better intent (≤128 chars)",
        },
      },
      required: ["query"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      return {
        content: "web_search requires an API key in agent config",
        is_error: true,
      };
    }

    let query = String(args.query ?? "").trim();
    if (!query) return { content: "Missing query", is_error: true };
    if ([...query].length > QUERY_MAX) {
      query = [...query].slice(0, QUERY_MAX).join("");
    }

    let count = Number(args.count ?? 8);
    if (!Number.isFinite(count)) count = 8;
    count = Math.min(50, Math.max(1, Math.floor(count)));

    const body: Record<string, unknown> = {
      query,
      count,
      need_content: false,
    };
    const ori = args.ori_question != null ? String(args.ori_question).trim() : "";
    if (ori) {
      body.ori_question = [...ori].slice(0, QUERY_MAX).join("");
    }

    const url = resolveWebSearchUrl({
      searchBaseUrl: ctx.searchBaseUrl,
      llmBaseUrl: ctx.llmBaseUrl,
    });
    const fetchImpl = ctx.fetchImpl ?? fetch;

    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: truncateOutput(
            `web_search HTTP ${res.status}: ${text}`,
            ctx.maxToolOutputChars,
          ),
          is_error: true,
        };
      }
      let parsed: { results?: SearchHit[] };
      try {
        parsed = JSON.parse(text) as { results?: SearchHit[] };
      } catch {
        return { content: `Invalid JSON from search API: ${text.slice(0, 200)}`, is_error: true };
      }
      const formatted = formatResults(Array.isArray(parsed.results) ? parsed.results : []);
      return {
        content: truncateOutput(formatted, ctx.maxToolOutputChars),
        is_error: false,
      };
    } catch (err) {
      if (ctx.signal?.aborted) {
        return { content: "web_search cancelled", is_error: true };
      }
      return { content: `web_search failed: ${String(err)}`, is_error: true };
    }
  },
};
