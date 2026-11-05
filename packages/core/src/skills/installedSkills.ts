import { randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInside } from "../pathSandbox.js";
import { truncateOutput } from "../tools/bash.js";
import { isSkillName, parseSkillMarkdown } from "./frontmatter.js";

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export interface InstalledSkill {
  name: string;
  description: string;
  /** False means the folder stays, but the model catalog and skill tools ignore it. */
  enabled: boolean;
}

export interface SkillFileRead {
  content: string;
  is_error: boolean;
  directory?: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const SETTINGS_FILE = ".skill-settings.json";

function settingsFile(root: string): string {
  return join(root, SETTINGS_FILE);
}

async function loadDisabled(root: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(root), "utf8")) as { disabled?: unknown };
    if (!Array.isArray(parsed.disabled)) return [];
    return parsed.disabled.filter((name): name is string => typeof name === "string" && isSkillName(name));
  } catch {
    return [];
  }
}

async function saveDisabled(root: string, names: string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = settingsFile(root);
  const tmp = join(root, `.skill-settings.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ disabled: names }, null, 2)}\n`, "utf8");
  await rm(file, { force: true });
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Drop names whose folders are gone. A folder with a broken SKILL.md stays disabled. */
async function disabledNames(root: string, dirNames: readonly string[]): Promise<Set<string>> {
  const loaded = await loadDisabled(root);
  const present = new Set(dirNames);
  const kept = loaded.filter((name) => present.has(name));
  if (kept.length !== loaded.length) await saveDisabled(root, kept);
  return new Set(kept);
}

export function defaultSkillsRoot(): string {
  return join(homedir(), ".long-task-agent", "skills");
}

export function skillDirectory(name: string, root = defaultSkillsRoot()): string {
  return join(root, name);
}

export async function listInstalledSkills(root = defaultSkillsRoot()): Promise<InstalledSkill[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const dirNames = names.filter((name) => isSkillName(name)).sort();
  const disabled = await disabledNames(root, dirNames);
  const found: InstalledSkill[] = [];
  for (const name of dirNames) {
    try {
      const raw = await readFile(join(root, name, "SKILL.md"), "utf8");
      const parsed = parseSkillMarkdown(raw);
      if (parsed.name !== name) continue;
      found.push({
        name: parsed.name,
        description: parsed.description,
        enabled: !disabled.has(parsed.name),
      });
    } catch {
      continue;
    }
  }
  return found;
}

export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  root = defaultSkillsRoot(),
): Promise<void> {
  if (!isSkillName(name)) throw new SkillError(`未找到技能 ${name}`);
  if (!(await exists(skillDirectory(name, root)))) throw new SkillError(`未找到技能 ${name}`);
  const disabled = new Set(await loadDisabled(root));
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  await saveDisabled(root, [...disabled].sort());
}

export async function installSkill(sourceDir: string, root = defaultSkillsRoot()): Promise<InstalledSkill> {
  return installFrom(sourceDir, root, null);
}

export async function replaceSkill(
  expectedName: string,
  sourceDir: string,
  root = defaultSkillsRoot(),
): Promise<InstalledSkill> {
  if (!isSkillName(expectedName)) throw new SkillError(`未找到技能 ${expectedName}`);
  return installFrom(sourceDir, root, expectedName);
}

export async function uninstallSkill(name: string, root = defaultSkillsRoot()): Promise<void> {
  if (!isSkillName(name)) throw new SkillError(`未找到技能 ${name}`);
  try {
    await rm(skillDirectory(name, root), { recursive: true, force: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillError(`未找到技能 ${name}`);
    }
    throw err;
  }
  const loaded = await loadDisabled(root);
  if (loaded.includes(name)) await saveDisabled(root, loaded.filter((item) => item !== name));
}

/** Real path of a file inside an installed skill. Rejects paths that leave that directory. */
export async function resolveInstalledSkillPath(
  name: string,
  relativePath: string,
  root = defaultSkillsRoot(),
): Promise<{ path: string; directory: string } | { error: string }> {
  if (!isSkillName(name)) return { error: `未找到技能 ${name}` };
  if ((await loadDisabled(root)).includes(name)) {
    if (!(await exists(skillDirectory(name, root)))) return { error: `未找到技能 ${name}` };
    return { error: `技能 ${name} 已停用` };
  }
  let realRoot: string;
  try {
    realRoot = await realpath(skillDirectory(name, root));
  } catch {
    return { error: `未找到技能 ${name}` };
  }
  const requested = relativePath.trim();
  if (!requested) return { error: "缺少路径" };
  const abs = resolve(realRoot, requested);
  if (!isPathInside(realRoot, abs)) return { error: `路径超出技能目录：${requested}` };
  let realTarget: string;
  try {
    realTarget = await realpath(abs);
  } catch (err) {
    return { error: String(err) };
  }
  if (!isPathInside(realRoot, realTarget)) return { error: `路径超出技能目录：${requested}` };
  return { path: realTarget, directory: realRoot };
}

export async function readInstalledSkillFile(
  name: string,
  relativePath: string | undefined,
  maxChars: number,
  root = defaultSkillsRoot(),
): Promise<SkillFileRead> {
  if (!isSkillName(name)) return { content: `未找到技能 ${name}`, is_error: true };
  if ((await loadDisabled(root)).includes(name)) {
    if (!(await exists(skillDirectory(name, root)))) {
      return { content: `未找到技能 ${name}`, is_error: true };
    }
    return { content: `技能 ${name} 已停用`, is_error: true };
  }
  const directory = skillDirectory(name, root);
  let realRoot: string;
  try {
    realRoot = await realpath(directory);
  } catch {
    return { content: `未找到技能 ${name}`, is_error: true };
  }
  const requested = relativePath?.trim() ?? "";
  if (!requested) {
    try {
      const raw = await readFile(join(realRoot, "SKILL.md"), "utf8");
      const parsed = parseSkillMarkdown(raw);
      return {
        content: truncateOutput(parsed.body, maxChars),
        is_error: false,
        directory: realRoot,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: message, is_error: true };
    }
  }
  const resolved = await resolveInstalledSkillPath(name, requested, root);
  if ("error" in resolved) return { content: resolved.error, is_error: true };
  const realTarget = resolved.path;
  try {
    const buf = await readFile(realTarget);
    if (buf.includes(0)) {
      return {
        content: `二进制文件，${buf.length} 字节，路径 ${realTarget}`,
        is_error: false,
        directory: realRoot,
      };
    }
    return {
      content: truncateOutput(buf.toString("utf8"), maxChars),
      is_error: false,
      directory: realRoot,
    };
  } catch (err) {
    return { content: String(err), is_error: true };
  }
}

async function installFrom(
  sourceDir: string,
  root: string,
  replaceName: string | null,
): Promise<InstalledSkill> {
  let raw: string;
  try {
    raw = await readFile(join(sourceDir, "SKILL.md"), "utf8");
  } catch {
    throw new SkillError("没有 SKILL.md");
  }
  let parsed: ReturnType<typeof parseSkillMarkdown>;
  try {
    parsed = parseSkillMarkdown(raw);
  } catch (err) {
    throw new SkillError(err instanceof Error ? err.message : String(err));
  }
  const dest = skillDirectory(parsed.name, root);
  if (replaceName == null) {
    if (await exists(dest)) {
      throw new SkillError(`已安装 ${parsed.name}。要更新请直接改技能目录，或先卸载再添加`);
    }
  } else if (parsed.name !== replaceName) {
    throw new SkillError(`文件夹里的名字是 ${parsed.name}，所选技能是 ${replaceName}`);
  }
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.tmp-${parsed.name}-${randomBytes(4).toString("hex")}`);
  const srcReal = await realpath(sourceDir);
  try {
    await copySkillTree(sourceDir, tmp, srcReal, new Set());
    if (replaceName != null && (await exists(dest))) {
      await rm(dest, { recursive: true, force: true });
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof SkillError) throw err;
    throw new SkillError(err instanceof Error ? err.message : String(err));
  }
  if (replaceName == null) {
    const loaded = await loadDisabled(root);
    if (loaded.includes(parsed.name)) {
      await saveDisabled(root, loaded.filter((item) => item !== parsed.name));
    }
  }
  const enabled = replaceName == null || !(await loadDisabled(root)).includes(parsed.name);
  return { name: parsed.name, description: parsed.description, enabled };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copySkillTree(
  src: string,
  dest: string,
  srcRootReal: string,
  stack: Set<string>,
): Promise<void> {
  const realSrc = await realpath(src);
  if (stack.has(realSrc)) throw new SkillError("技能目录里的符号链接成环");
  stack.add(realSrc);
  try {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const from = join(src, ent.name);
      const to = join(dest, ent.name);
      const lst = await lstat(from);
      if (lst.isSymbolicLink()) {
        let targetReal: string;
        try {
          targetReal = await realpath(from);
        } catch {
          throw new SkillError(`符号链接指向技能目录之外：${ent.name}`);
        }
        if (!isPathInside(srcRootReal, targetReal)) {
          throw new SkillError(`符号链接指向技能目录之外：${ent.name}`);
        }
        const followed = await stat(from);
        if (followed.isDirectory()) await copySkillTree(from, to, srcRootReal, stack);
        else await copyFile(targetReal, to);
        continue;
      }
      if (lst.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await copySkillTree(from, to, srcRootReal, stack);
        continue;
      }
      if (lst.isFile()) await copyFile(from, to);
    }
  } finally {
    stack.delete(realSrc);
  }
}
