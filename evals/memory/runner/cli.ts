import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfigPath } from "@agent/core";
import { holdText, loadCases, runMemoryCase, type CaseRun, type Layer, type MemoryCase } from "./memoryCase.js";

const LAYERS = new Set<Layer>(["remember", "skip", "revise"]);

interface Options {
  ids: string[];
  layers: Layer[];
  configPath?: string;
  keep: boolean;
  verbose: boolean;
  list: boolean;
  help: boolean;
}

class UsageError extends Error {}

function usage(): string {
  return [
    "用法: npm run eval:memory -- [选项]",
    "",
    "  --id <id[,id]>       只跑这些用例，可以重复写",
    "  --layer <layer>      remember | skip | revise，可以重复写",
    "  --config <path>      模型配置。默认 ~/.long-task-agent/config.json",
    "  --keep               保留临时工作区并打印路径",
    "  --verbose            失败时打印模型原文",
    "  --list               列出用例后退出",
    "  --help               显示这段说明",
    "",
    "14 条都要模型。必须项全部命中、禁止项一条都没命中、并且模型正常返回，才算通过。",
  ].join("\n");
}

function splitValues(values: string[]): string[] {
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ids: [], layers: [], keep: false, verbose: false, list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} 缺参数`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--id":
        options.ids.push(...splitValues([next()]));
        break;
      case "--layer":
        for (const layer of splitValues([next()])) {
          if (!LAYERS.has(layer as Layer)) throw new UsageError(`不认识的层：${layer}`);
          options.layers.push(layer as Layer);
        }
        break;
      case "--config":
        options.configPath = next();
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
        throw new UsageError(`不认识的选项：${arg}`);
    }
  }
  return options;
}

function repoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "packages", "core", "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`从 ${start} 往上找不到仓库根目录`);
    dir = parent;
  }
}

async function readModel(path: string): Promise<{ baseUrl: string; model: string; apiKey: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`读不到模型配置：${path}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new UsageError(`模型配置不是合法 JSON：${path}`);
  }
  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
  if (!baseUrl || !model) throw new UsageError(`模型配置要有 baseUrl 和 model：${path}`);
  return { baseUrl, model, apiKey };
}

function appliedLine(run: CaseRun): string {
  if (!run.applied.length) return "  写入：（没有）";
  return run.applied
    .map((item) => {
      const text = `${item.description ?? ""} ${item.body ?? ""}`.replace(/\s+/g, " ").trim();
      return `  写入：${item.op} ${item.scope}/${item.name}${item.type ? ` ${item.type}` : ""} ${text.slice(0, 80)}`;
    })
    .join("\n");
}

function report(runs: CaseRun[], verbose: boolean): string {
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(`${run.id}  ${run.pass ? "PASS" : "FAIL"}  ${run.title}`);
    if (run.pass) continue;
    lines.push(`  结果：${run.outcome}`);
    for (const hold of run.missing) lines.push(`  缺少：${holdText(hold)}`);
    for (const hold of run.hit) lines.push(`  命中禁止：${holdText(hold)}`);
    lines.push(appliedLine(run));
    if (run.output && run.applied.length === 0 && run.missing.length === 0 && run.hit.length === 0) {
      lines.push(`  错误：${run.output.split("\n")[0]}`);
    }
    if (verbose && run.output) lines.push(`  模型原文：${run.output.replace(/\s+/g, " ").slice(0, 1200)}`);
  }
  const count = (layer: Layer): string => {
    const rows = runs.filter((run) => run.layer === layer);
    return `${layer} ${rows.filter((run) => run.pass).length}/${rows.length}`;
  };
  const passed = runs.filter((run) => run.pass).length;
  lines.push(`通过 ${passed}/${runs.length}（${count("remember")}，${count("skip")}，${count("revise")}）`);
  return lines.join("\n");
}

function select(cases: MemoryCase[], options: Options): MemoryCase[] {
  return cases.filter((item) => {
    if (options.ids.length && !options.ids.includes(item.id)) return false;
    if (options.layers.length && !options.layers.includes(item.layer)) return false;
    return true;
  });
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  let loaded: ReturnType<typeof loadCases>;
  try {
    loaded = loadCases(await readFile(join(repoRoot(), "evals", "memory", "cases.json"), "utf8"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (options.list) {
    for (const item of loaded.cases) console.log(`${item.id}\t${item.layer}\t${item.title}`);
    return 0;
  }
  const chosen = select(loaded.cases, options);
  if (options.ids.length) {
    const found = new Set(chosen.map((item) => item.id));
    const missing = options.ids.filter((id) => !found.has(id));
    if (missing.length) {
      console.error(`没有这些用例：${missing.join(", ")}`);
      return 2;
    }
  }
  if (!chosen.length) {
    console.error("没有选中用例。");
    return 2;
  }
  const configPath = options.configPath ?? getDefaultConfigPath();
  let model: Awaited<ReturnType<typeof readModel>>;
  try {
    model = await readModel(configPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const runs: CaseRun[] = [];
  for (const item of chosen) {
    try {
      const run = await runMemoryCase(item, { today: loaded.today, ...model, keep: options.keep });
      runs.push(run);
      if (options.keep) console.error(`留下了 ${item.id}：${run.workspace}（home ${run.home}）`);
    } catch (err) {
      runs.push({
        id: item.id,
        layer: item.layer,
        title: item.title,
        outcome: "request_failed",
        applied: [],
        missing: [],
        hit: [],
        pass: false,
        workspace: "",
        home: "",
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.log(report(runs, options.verbose));
  return runs.every((run) => run.pass) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
