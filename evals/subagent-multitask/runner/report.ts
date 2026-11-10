import type { Check } from "./grade.js";
import type { Layer } from "./types.js";

export type CaseStatus = "pass" | "fail" | "skip" | "error";

export interface CaseResult {
  caseId: string;
  title: string;
  group: string;
  layer: Layer;
  mode: "scripted" | "live" | "skip";
  status: CaseStatus;
  checks: Check[];
  notes: string[];
  ms: number;
  error?: string;
  workspace?: string;
  evidence?: string[];
}

export interface Totals {
  pass: number;
  fail: number;
  error: number;
  skip: number;
  total: number;
}

export function totals(results: CaseResult[]): Totals {
  const count = (status: CaseStatus) => results.filter((result) => result.status === status).length;
  return {
    pass: count("pass"),
    fail: count("fail"),
    error: count("error"),
    skip: count("skip"),
    total: results.length,
  };
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function failedChecks(result: CaseResult): Check[] {
  return result.checks.filter((check) => !check.passed);
}

export function formatText(results: CaseResult[], opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.status === "skip") {
      lines.push(`SKIP  ${result.caseId}  [${result.layer}]  ${result.title}  — ${result.error ?? "skipped"}`);
      continue;
    }
    if (result.status === "error") {
      lines.push(`ERROR ${result.caseId}  [${result.layer}]  ${result.title}  — ${result.error ?? "unknown error"}`);
      continue;
    }
    const mark = result.status === "pass" ? "PASS" : "FAIL";
    const failed = failedChecks(result);
    const suffix = result.status === "pass" ? "" : `  (${failed.length}/${result.checks.length} checks failed)`;
    lines.push(`${mark}  ${result.caseId}  [${result.layer}/${result.mode}]  ${result.title}  ${seconds(result.ms)}${suffix}`);
    for (const check of failed) {
      lines.push(`   ✗ ${check.id} — ${check.description}`);
      if (check.detail) lines.push(`     ${oneLine(check.detail)}`);
    }
    for (const note of result.notes) lines.push(`   note: ${oneLine(note)}`);
    if (opts.verbose && result.evidence?.length) {
      for (const item of result.evidence) lines.push(`   · ${oneLine(item)}`);
    }
    if (result.workspace) lines.push(`   workspace: ${result.workspace}`);
  }
  const t = totals(results);
  lines.push("");
  lines.push(
    `Summary: ${t.pass} passed, ${t.fail} failed, ${t.error} errored, ${t.skip} skipped (${t.total} cases)`,
  );
  return lines.join("\n");
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

export function formatJson(results: CaseResult[]): string {
  return JSON.stringify({ totals: totals(results), cases: results }, null, 2);
}
