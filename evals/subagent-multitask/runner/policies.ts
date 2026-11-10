import type { LiveProviderPolicy } from "./provider.js";
import type { EvalCase } from "./types.js";

export type RunMode = "scripted" | "live";

/**
 * How much of a live case to execute before observing. The case file decides
 * this through `layer`; a handful of cases need one extra nudge:
 *
 * - Most model cases only judge the parent's first choice, so the batch is
 *   cancelled before any tool runs.
 * - mt-07 and mt-15 need the parent to read or run a command before delegating.
 * - mt-01 and mt-11 need list_dir to run in the same batch as the deferred
 *   worker; the worker itself is stubbed so no receipt can reach the parent
 *   early.
 */
const LIVE_POLICIES: Record<string, LiveProviderPolicy> = {
  "mt-01": { stubSubagents: true },
  "mt-02": { stopBeforeTools: true },
  "mt-03": { stopBeforeTools: true },
  "mt-04": { stopBeforeTools: true },
  "mt-11": { stubSubagents: true },
  "mt-12": { stopAtWrite: true, stopAtSubagent: true },
  "mt-14": { stopBeforeTools: true },
  "mt-15": { stopAtSubagent: true },
};

export function policyFor(c: EvalCase): LiveProviderPolicy {
  return LIVE_POLICIES[c.id] ?? {};
}

export function modeFor(c: EvalCase, liveAvailable: boolean): RunMode | "skip" {
  if (c.layer === "runtime") return "scripted";
  return liveAvailable ? "live" : "skip";
}

/** Wall-clock budget. Full live cases may run several subagents. */
export function timeoutFor(c: EvalCase): number {
  if (c.layer === "runtime") return 30_000;
  if (c.id === "mt-06") return 300_000;
  if (c.layer === "both") return 240_000;
  return 180_000;
}

/**
 * cases.json deliberately ships a test stub instead of the answer. For mt-06
 * the parent must see `npm test` pass before it completes the third task, so
 * give that one fixture a pass-through script. Every other case keeps its
 * fixture exactly as written: mt-07 and mt-15 want a failing command.
 */
export const SCAFFOLD_NPM_TEST = new Set(["mt-06"]);

/**
 * mt-13 runs the child loop directly instead of going through the parent's
 * tool batch. The case file names the child id and the work, but not the
 * directory; the prior task says docs/one/page.md, so writeRoot is docs/one.
 */
export interface DirectSubagentSetup {
  subagentType: "explore" | "worker";
  agentId: string;
  outputDir?: string;
  taskId?: string;
  task: string;
  description: string;
}

export const DIRECT_SUBAGENT: Record<string, DirectSubagentSetup> = {
  "mt-13": {
    subagentType: "worker",
    agentId: "subagent_self",
    outputDir: "docs/one",
    taskId: "1",
    task: "只写 docs/one/page.md，内容写 only。不要写别的文件。",
    description: "写一页说明",
  },
};

/** Cases whose deferred run must be allowed to settle before grading. */
export const WAIT_FOR_DEFERRED = new Set(["mt-16"]);
