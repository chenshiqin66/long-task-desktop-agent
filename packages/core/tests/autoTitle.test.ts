import { describe, it, expect } from "vitest";
import {
  sanitizeSessionTitle,
  titleFromFirstUserMessage,
  generateSessionTitle,
  SESSION_TITLE_MAX_CHARS,
} from "../src/session/autoTitle.js";
import type { Message } from "../src/types.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";

function msg(role: Message["role"], content: string): Message {
  return {
    id: "m",
    session_id: "s",
    turn_id: "t",
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

describe("autoTitle", () => {
  it("sanitizeSessionTitle truncates to 12 chars and strips quotes", () => {
    expect(sanitizeSessionTitle("「上海亲子公园推荐」")).toBe("上海亲子公园推荐");
    expect(sanitizeSessionTitle("一二三四五六七八九十一二三").length).toBe(
      SESSION_TITLE_MAX_CHARS,
    );
    expect(sanitizeSessionTitle("标题\n第二行")).toBe("标题");
  });

  it("titleFromFirstUserMessage uses first user text", () => {
    const title = titleFromFirstUserMessage([
      msg("assistant", "hi"),
      msg("user", "帮我查一下明天的乒乓球赛程安排如何"),
    ]);
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    expect(title.startsWith("帮我查")).toBe(true);
  });

  it("generateSessionTitle uses model output when present", async () => {
    async function* stream(): AsyncIterable<LlmStreamChunk> {
      yield { type: "text", text: "WTT蒙彼利埃赛程" };
    }
    const provider: LlmProvider = { chatStream: () => stream() };
    const title = await generateSessionTitle({
      provider,
      model: "test",
      messages: [msg("user", "赛程")],
    });
    expect(title).toBe("WTT蒙彼利埃赛程");
  });

  it("generateSessionTitle falls back on LLM error", async () => {
    async function* stream(): AsyncIterable<LlmStreamChunk> {
      yield { type: "error", error: "boom" };
    }
    const provider: LlmProvider = { chatStream: () => stream() };
    const title = await generateSessionTitle({
      provider,
      model: "test",
      messages: [msg("user", "修改权限策略为默认允许")],
    });
    expect(title).toBe("修改权限策略为默认允许".slice(0, SESSION_TITLE_MAX_CHARS));
  });
});
