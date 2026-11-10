import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCaseFile, selectCases } from "./cases.js";
import { caseFileDefault, findRepoRoot } from "./paths.js";
import { formatJson, formatText, type CaseResult } from "./report.js";
import { callSummary } from "./observe.js";
import type { Layer, LiveModelSettings } from "./types.js";

const LAYERS = new Set<Layer>(["model", "runtime", "both"]);

interface Options {
  ids: string[];
  layers: Layer[];
  groups: string[];
  live: boolean;
  configPath?: string;
  json: boolean;
  keep: boolean;
  verbose: boolean;
  timeoutMs?: number;
  list: boolean;
  help: boolean;
}

class UsageError extends Error {}

function usage(): string {
  return [
    "Usage: npm run eval -- [options]",
    "",
    "  --id <id[,id]>       run only these cases (repeatable)",
    "  --layer <layer>      model | runtime | both (repeatable)",
    "  --group <group>      no-list | parallel | dependent | failure (repeatable)",
    "  --no-live            skip model/both cases even when a model is configured",
    "  --config <path>      model config JSON (default ~/.long-task-agent/config.json)",
    "  --timeout <ms>       override the per-case wall-clock budget",
    "  --json               print machine-readable results instead of text",
    "  --keep               keep each temporary workspace and print its path",
    "  --verbose            print calls, tasks, and the final reply for each case",
    "  --list               list the cases and exit",
    "  --help               show this help",
    "",
    "The runner never touches the repository as a workspace: every case runs in a temp directory.",
  ].join("\n");
}

function splitValues(values: string[]): string[] {
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    ids: [],
    layers: [],
    groups: [],
    live: true,
    json: false,
    keep: false,
    verbose: false,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--id":
        options.ids.push(...splitValues([next()]));
        break;
      case "--layer":
        for (const layer of splitValues([next()])) {
          if (!LAYERS.has(layer as Layer)) throw new UsageError(`unknown layer: ${layer}`);
          options.layers.push(layer as Layer);
        }
        break;
      case "--group":
        options.groups.push(...splitValues([next()]));
        break;
      case "--no-live":
        options.live = false;
        break;
      case "--config":
        options.configPath = next();
        break;
      case "--timeout": {
        const raw = next();
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new UsageError(`invalid timeout: ${raw}`);
        options.timeoutMs = Math.floor(value);
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return options;
}

async function loadLiveSettings(path: string, explicit: boolean): Promise<LiveModelSettings | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    if (explicit) throw new UsageError(`cannot read model config: ${path}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as Record<string, unknown>;
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (!baseUrl || !model || !apiKey) {
      if (explicit) throw new UsageError(`model config needs baseUrl, model, and apiKey: ${path}`);
      return null;
    }
    return { baseUrl, model, apiKey, source: path };
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (explicit) throw new UsageError(`model config is not valid JSON: ${path}`);
    return null;
  }
}

function liveSkipReason(options: Options, settings: LiveModelSettings | null): string {
  if (!options.live) return "--no-live";
  if (!settings) return "no model config; pass --config or create ~/.long-task-agent/config.json";
  return "";
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${String(err)}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let caseFile;
  try {
    caseFile = await loadCaseFile(caseFileDefault());
  } catch (err) {
    console.error(String(err));
    return 2;
  }

  if (options.list) {
    for (const item of caseFile.cases) {
      console.log(`${item.id}\t${item.group}\t${item.layer}\t${item.title}`);
    }
    return 0;
  }

  const selected = selectCases(caseFile, {
    ids: options.ids,
    layers: options.layers,
    groups: options.groups,
  });
  if (options.ids.length) {
    const found = new Set(selected.map((item) => item.id));
    const missing = options.ids.filter((id) => !found.has(id));
    if (missing.length) {
      console.error(`Unknown case id(s): ${missing.join(", ")}`);
      return 2;
    }
  }
  if (selected.length === 0) {
    console.error("No cases selected.");
    return 2;
  }

  const configPath = options.configPath ?? join(homedir(), ".long-task-agent", "config.json");
  let settings: LiveModelSettings | null = null;
  try {
    settings = await loadLiveSettings(configPath, Boolean(options.configPath));
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  if (!options.live) settings = null;
  const skipReason = liveSkipReason(options, settings);

  const needsCore = selected.some((item) => item.layer === "runtime" || Boolean(settings));
  const coreIndex = join(findRepoRoot(), "packages", "core", "dist", "index.js");
  if (needsCore && !existsSync(coreIndex)) {
    console.error(
      `@agent/core is not built (${coreIndex} is missing).\nRun: npm run build -w @agent/core`,
    );
    return 2;
  }

  const { runCase, SkipCaseError } = await import("./runCase.js");
  const { gradeCase } = await import("./graders.js");

  const results: CaseResult[] = [];
  for (const item of selected) {
    const mode = item.layer === "runtime" ? "scripted" : settings ? "live" : "skip";
    if (mode === "skip") {
      results.push({
        caseId: item.id,
        title: item.title,
        group: item.group,
        layer: item.layer,
        mode,
        status: "skip",
        checks: [],
        notes: [],
        ms: 0,
        error: skipReason,
      });
      continue;
    }
    const started = Date.now();
    try {
      const run = await runCase(item, {
        liveSettings: mode === "live" ? settings : null,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      const grade = gradeCase(item, run.observation);
      const failed = grade.checks.filter((check) => !check.passed);
      const evidence: string[] | undefined = options.verbose
        ? [
            ...run.observation.parentCalls.map(
              (call) =>
                `call b${call.batch}: ${callSummary(call)}${call.result ? (call.result.is_error ? " [error]" : " [ok]") : " [no result]"}`,
            ),
            ...run.observation.subagentCalls.map(
              (call) => `child: ${call.call.function.name}${call.result ? (call.result.is_error ? " [error]" : " [ok]") : ""}`,
            ),
            `tasks: ${run.observation.tasks.map((task) => `#${task.id} ${task.status} ${task.owner ?? "-"} ${task.subject}`).join(" | ") || "(none)"}`,
            `reply: ${run.observation.finalText.replace(/\s+/g, " ").slice(0, 400) || "(empty)"}`,
          ]
        : undefined;
      const workspace = options.keep ? run.observation.workspace : undefined;
      results.push({
        caseId: item.id,
        title: item.title,
        group: item.group,
        layer: item.layer,
        mode,
        status: failed.length === 0 ? "pass" : "fail",
        checks: grade.checks,
        notes: grade.notes ?? [],
        ms: Date.now() - started,
        ...(workspace ? { workspace } : {}),
        ...(evidence ? { evidence } : {}),
      });
      if (!options.keep) await run.cleanup();
      else console.error(`kept ${item.id}: ${run.observation.workspace}`);
    } catch (err) {
      if (err instanceof SkipCaseError) {
        results.push({
          caseId: item.id,
          title: item.title,
          group: item.group,
          layer: item.layer,
          mode: "skip",
          status: "skip",
          checks: [],
          notes: [],
          ms: Date.now() - started,
          error: err.message,
        });
        continue;
      }
      results.push({
        caseId: item.id,
        title: item.title,
        group: item.group,
        layer: item.layer,
        mode,
        status: "error",
        checks: [],
        notes: [],
        ms: Date.now() - started,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  console.log(options.json ? formatJson(results) : formatText(results, { verbose: options.verbose }));
  return results.some((result) => result.status === "fail" || result.status === "error") ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
