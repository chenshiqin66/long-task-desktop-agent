import type { TaskStatus } from "@agent/core";
import type { EvalCase, ExpectedTask } from "./types.js";
import type { Observation, ObservedCall } from "./observe.js";
import { taskById, textArg } from "./observe.js";

export interface Check {
  id: string;
  description: string;
  passed: boolean;
  detail?: string;
}

export interface Grade {
  caseId: string;
  title: string;
  layer: EvalCase["layer"];
  mode: Observation["mode"];
  passed: boolean;
  checks: Check[];
  notes: string[];
}

export interface GraderContext {
  observation: Observation;
  case: EvalCase;
}

export interface GraderResult {
  checks: Check[];
  notes?: string[];
}

export type Grader = (ctx: GraderContext) => GraderResult;

export function add(
  checks: Check[],
  id: string,
  description: string,
  passed: boolean,
  detail?: string,
): void {
  checks.push({
    id,
    description,
    passed,
    ...(passed || !detail ? {} : { detail }),
  });
}

export function normalizePath(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

export function subagents(o: Observation): ObservedCall[] {
  return o.parentCalls.filter((call) => call.call.function.name === "subagent");
}

export function parentNamed(o: Observation, name: string): ObservedCall[] {
  return o.parentCalls.filter((call) => call.call.function.name === name);
}

export function parentCallsInFirstBatch(o: Observation): ObservedCall[] {
  const first = o.exchanges.find((exchange) => exchange.kind === "parent");
  const ids = new Set((first?.toolCalls ?? []).map((call) => call.id));
  return o.parentCalls.filter((call) => ids.has(call.call.id));
}

export function callIndex(o: Observation, call: ObservedCall): number {
  return o.parentCalls.indexOf(call);
}

export function after(a: ObservedCall, b: ObservedCall): boolean {
  return a.batch > b.batch || (a.batch === b.batch && a.eventIndex > b.eventIndex);
}

export function taskText(call: ObservedCall): string {
  return textArg(call.args, "task");
}

export function resultOf(call: ObservedCall): { content: string; isError: boolean } {
  return { content: call.result?.content ?? "", isError: call.result?.is_error ?? false };
}

export function resultMentions(call: ObservedCall, needles: readonly string[]): boolean {
  const content = resultOf(call).content;
  return needles.some((needle) => content.includes(needle));
}

export function subagentTaskTexts(o: Observation): string[] {
  return subagents(o).map(taskText);
}

export function noChildTaskMutations(o: Observation): boolean {
  return !o.subagentCalls.some((call) =>
    ["task_create", "task_update", "task_delete"].includes(call.call.function.name),
  );
}

export function childCallsNamed(o: Observation, name: string): ObservedCall[] {
  return o.subagentCalls.filter((call) => call.call.function.name === name);
}

export function parentHasCall(
  o: Observation,
  name: string,
  predicate: (call: ObservedCall) => boolean = () => true,
): boolean {
  return parentNamed(o, name).some(predicate);
}

export function writesByParent(o: Observation, under?: string): ObservedCall[] {
  const prefix = under ? normalizePath(under).toLowerCase() : "";
  return o.parentCalls.filter((call) => {
    const name = call.call.function.name;
    if (name !== "write_file" && name !== "str_replace" && name !== "delete_file") return false;
    if (!prefix) return true;
    const path = normalizePath(call.args.path).toLowerCase();
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

export function taskStatus(o: Observation, id: string): TaskStatus | "missing" {
  return taskById(o, id)?.status ?? "missing";
}

/**
 * `tasks_when_done` uses a word from the case's own task names to find a task.
 * A model may name the test step "跑 npm test" instead of "测试"; both identify
 * the same step, so accept the common synonym.
 */
function subjectMatches(subject: string, needle: string | undefined): boolean {
  if (!needle) return true;
  if (subject.includes(needle)) return true;
  return needle === "测试" && /npm\s+test|测试|test/i.test(subject);
}

export function taskOwner(o: Observation, id: string): string {
  return taskById(o, id)?.owner ?? "";
}

export function checkNoTasks(o: Observation, checks: Check[], id = "no-tasks"): void {
  add(
    checks,
    id,
    "no task list is created",
    o.tasks.length === 0,
    `tasks: ${o.tasks.map((task) => `#${task.id} ${task.status} ${task.subject}`).join("; ") || "(none)"}`,
  );
}

export function checkExpectedTasks(
  o: Observation,
  expected: ExpectedTask[] | undefined,
  label: string,
  checks: Check[],
): void {
  if (!expected) return;
  if (expected.length === 0) {
    checkNoTasks(o, checks, `${label}:empty`);
    return;
  }
  expected.forEach((want, index) => {
    const matches = o.tasks.filter((task) => subjectMatches(task.subject, want.subject_contains));
    const task = matches[0];
    const subjectOk = Boolean(task);
    const statusOk = task?.status === want.status;
    const ownerOk = !want.owner || task?.owner === want.owner;
    const prefixOk = !want.owner_prefix || (task?.owner ?? "").startsWith(want.owner_prefix);
    const detail = task
      ? `#${task.id} ${task.status} owner=${task.owner ?? "(none)"} subject=${task.subject}`
      : `no task with subject containing ${JSON.stringify(want.subject_contains ?? "")}; actual: ${o.tasks
          .map((item) => `#${item.id} ${item.subject}`)
          .join("; ")}`;
    add(
      checks,
      `${label}:${index + 1}`,
      `${label}: ${JSON.stringify(want)}`,
      subjectOk && statusOk && ownerOk && prefixOk,
      detail,
    );
  });
}

export function baseChecks(o: Observation, checks: Check[]): void {
  add(checks, "run:no-timeout", "the case finished inside its wall-clock budget", !o.timedOut);
  add(
    checks,
    "run:no-errors",
    "the runtime reported no error",
    o.errors.length === 0,
    o.errors.join(" | "),
  );
}

/** Distinct subagent calls that must all be in one response. */
export function checkParallelBatch(
  o: Observation,
  calls: ObservedCall[],
  checks: Check[],
): void {
  const batches = new Set(calls.map((call) => call.batch));
  add(
    checks,
    "parallel:one-response",
    "all subagent calls are in one assistant response",
    batches.size === 1,
    `batches: ${[...batches].join(", ")}`,
  );
  const first = o.exchanges.find((exchange) => exchange.kind === "parent");
  const firstIds = new Set((first?.toolCalls ?? []).map((call) => call.id));
  add(
    checks,
    "parallel:first-response",
    "subagent calls are in the first assistant response",
    calls.every((call) => firstIds.has(call.call.id)),
  );
}

export function countSubagents(o: Observation): number {
  return subagents(o).length;
}

export function resultAccepted(call: ObservedCall): boolean {
  const { content, isError } = resultOf(call);
  return !isError && content.includes("Accepted");
}

export function resultRejected(call: ObservedCall): boolean {
  return resultOf(call).isError;
}

export function hasNoVagueTask(call: ObservedCall): boolean {
  const text = taskText(call);
  return !/根据你的发现|自己判断|自己决定|自行判断|自己整理|看着办/.test(text);
}
