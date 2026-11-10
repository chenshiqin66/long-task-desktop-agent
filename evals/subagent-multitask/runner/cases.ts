import { readFile } from "node:fs/promises";
import type { CaseFile, EvalCase, Layer } from "./types.js";

const LAYERS = new Set<Layer>(["model", "runtime", "both"]);

export class CaseFileError extends Error {}

function asStringArray(value: unknown, field: string, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CaseFileError(`${id}: ${field} must be an array of strings`);
  }
  return value as string[];
}

function validateCase(raw: unknown, index: number): EvalCase {
  if (!raw || typeof raw !== "object") throw new CaseFileError(`cases[${index}] is not an object`);
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) throw new CaseFileError(`cases[${index}] has no id`);
  if (typeof value.title !== "string" || !value.title) throw new CaseFileError(`${id}: title is required`);
  if (typeof value.group !== "string" || !value.group) throw new CaseFileError(`${id}: group is required`);
  if (typeof value.layer !== "string" || !LAYERS.has(value.layer as Layer)) {
    throw new CaseFileError(`${id}: layer must be model, runtime, or both`);
  }
  const must = asStringArray(value.must, "must", id);
  const mustNot = asStringArray(value.must_not, "must_not", id);
  if (must.length === 0) throw new CaseFileError(`${id}: must is empty`);

  const priorTasks = value.prior_tasks;
  if (priorTasks !== undefined) {
    if (!Array.isArray(priorTasks)) throw new CaseFileError(`${id}: prior_tasks must be an array`);
    for (const task of priorTasks) {
      if (!task || typeof task !== "object") throw new CaseFileError(`${id}: prior_tasks entry is not an object`);
      const t = task as Record<string, unknown>;
      if (typeof t.id !== "string" || !/^[1-9][0-9]*$/.test(t.id)) {
        throw new CaseFileError(`${id}: prior task id must be a positive decimal string`);
      }
      if (typeof t.subject !== "string" || typeof t.description !== "string") {
        throw new CaseFileError(`${id}: prior task ${t.id} needs subject and description`);
      }
    }
  }

  if (value.scripted_parent !== undefined && !Array.isArray(value.scripted_parent)) {
    throw new CaseFileError(`${id}: scripted_parent must be an array`);
  }
  if (value.scripted_subagent !== undefined && typeof value.scripted_subagent !== "object") {
    throw new CaseFileError(`${id}: scripted_subagent must be an object`);
  }
  if (value.layer === "runtime" && !value.scripted_parent && !value.scripted_subagent) {
    throw new CaseFileError(`${id}: runtime case needs scripted_parent or scripted_subagent`);
  }

  return {
    ...(value as unknown as EvalCase),
    must,
    must_not: mustNot,
  };
}

export async function loadCaseFile(path: string): Promise<CaseFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new CaseFileError(`Cannot read case file ${path}: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    throw new CaseFileError(`Case file ${path} is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new CaseFileError(`Case file ${path} is not an object`);
  const value = parsed as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name) throw new CaseFileError("Case file has no name");
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new CaseFileError("Case file has no cases");
  }
  const cases = value.cases.map(validateCase);
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new CaseFileError(`Duplicate case id: ${item.id}`);
    seen.add(item.id);
  }
  return { ...(value as unknown as CaseFile), cases };
}

export function selectCases(
  file: CaseFile,
  filter: { ids?: string[]; layers?: Layer[]; groups?: string[] },
): EvalCase[] {
  const ids = filter.ids?.length ? new Set(filter.ids) : null;
  const layers = filter.layers?.length ? new Set(filter.layers) : null;
  const groups = filter.groups?.length ? new Set(filter.groups) : null;
  return file.cases.filter(
    (item) =>
      (!ids || ids.has(item.id)) &&
      (!layers || layers.has(item.layer)) &&
      (!groups || groups.has(item.group)),
  );
}
