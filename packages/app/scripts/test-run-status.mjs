import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MSG_RUN_STATUS_CLASS,
  MSG_RUN_STATUS_DOTS_CLASS,
  MSG_RUN_STATUS_TEXT_CLASS,
  RUN_STATUS_THINKING,
  RUN_STATUS_TOOL,
  assistantRunPhase,
  assistantRunStatusLabel,
  assistantRunStatusStem,
} from "../dist/src/renderer/runStatus.js";

assert.equal(MSG_RUN_STATUS_CLASS, "is-run-status");
assert.equal(MSG_RUN_STATUS_TEXT_CLASS, "msg-run-status");
assert.equal(MSG_RUN_STATUS_DOTS_CLASS, "msg-run-dots");
assert.equal(RUN_STATUS_THINKING, "正在思考…");
assert.equal(RUN_STATUS_TOOL, "正在使用工具");
assert.equal(assistantRunStatusLabel("thinking"), "正在思考…");
assert.equal(assistantRunStatusLabel("tool"), "正在使用工具");
assert.equal(assistantRunStatusLabel("streaming"), null);
assert.equal(assistantRunStatusLabel("idle"), null);

// The thinking label keeps the ellipsis in aria text; the painted stem does not,
// so the bouncing dots do not grow a second set of dots.
assert.equal(assistantRunStatusStem("thinking"), "正在思考");
assert.equal(assistantRunStatusStem("tool"), "正在使用工具");

assert.equal(assistantRunPhase({ running: true }), "thinking");
assert.equal(assistantRunPhase({ running: true, hasTools: false, hasStreamText: false }), "thinking");
assert.equal(assistantRunPhase({ running: true, hasTools: true }), "tool");
assert.equal(assistantRunPhase({ running: true, hasTools: true, hasStreamText: false }), "tool");
assert.equal(assistantRunPhase({ running: true, hasTools: true, hasStreamText: true }), "streaming");
assert.equal(assistantRunPhase({ running: true, hasStreamText: true }), "streaming");
assert.equal(assistantRunPhase({ running: false, hasStreamText: true }), "streaming");
assert.equal(assistantRunPhase({ running: false }), "idle");
assert.equal(assistantRunPhase({ running: true, stopping: true }), "idle");
assert.equal(assistantRunPhase({ running: true, stopping: true, hasStreamText: true }), "streaming");
assert.equal(assistantRunPhase({ running: true, asking: true }), "idle");
assert.equal(assistantRunPhase({ running: true, placeholder: true }), "idle");
assert.equal(assistantRunPhase({ running: true, hasTools: true, placeholder: true }), "idle");
assert.equal(assistantRunPhase({ running: true, hasTools: true, stopping: true }), "idle");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statusSrc = readFileSync(join(root, "src/renderer/runStatus.ts"), "utf8");
const uiSrc = readFileSync(join(root, "src/renderer/ui.ts"), "utf8");
const mainSrc = readFileSync(join(root, "src/renderer/main.ts"), "utf8");
const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");

assert.doesNotMatch(statusSrc, /正在输入/);
assert.doesNotMatch(uiSrc, /正在输入/);
assert.doesNotMatch(mainSrc, /正在输入/);
assert.doesNotMatch(css, /正在输入/);

// Waiting row is never treated as a hidden blank gap, so the robot stays visible.
assert.match(uiSrc, /function isBlankGap[\s\S]*classList\.contains\(MSG_RUN_STATUS_CLASS\)\) return false/);

// Status is painted on send/replay, follows tool and text events, and is cleared on end.
assert.match(mainSrc, /paintMessageRunStatus\(next\.streamingEl, "thinking"\)/);
assert.match(mainSrc, /paintMessageRunStatus\(run\.streamingEl, "thinking"\)/);
assert.match(mainSrc, /function syncAssistantRunStatus/);
assert.match(mainSrc, /showRunStatus[\s\S]*syncAssistantRunStatus\(run\)/);
assert.match(mainSrc, /if \(run\.streamBuffer\.trim\(\)\) syncAssistantRunStatus\(run, host\)/);
assert.match(mainSrc, /syncAssistantRunStatus\(run, host, true\)/);
assert.match(mainSrc, /clearMessageRunStatus/);

// Composer copy stays on its own labels; the row does not invent a conflicting phrase.
assert.match(mainSrc, /思考中/);

assert.match(css, /\.msg\.assistant\.is-run-status\s*\{/);
assert.match(css, /\.msg-run-status\s*\{/);
assert.match(css, /\.msg-run-dots\s*\{/);
assert.match(css, /@keyframes\s+msg-run-dot/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /\.msg-run-dots span\s*\{[\s\S]*background:\s*var\(--accent\)/);
assert.match(css, /\.msg\.assistant\.is-run-status\s*\{[\s\S]*min-height:\s*30px/);

// Fold cue and first-visible-reply avatar must still be in the same stylesheet.
assert.match(css, /#main \.turn > \.msg\.assistant:not\(\.is-blank\)::before/);
assert.match(css, /#main \.turn > \.tool-group::after/);
assert.match(css, /\.msg-collapse-toggle\s*\{/);
assert.match(css, /\.msg\.assistant \.msg-body\.is-collapsed::after\s*\{/);

console.log("run status tests ok");
