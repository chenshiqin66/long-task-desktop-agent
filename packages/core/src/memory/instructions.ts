import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathInside } from "../pathSandbox.js";
import { errorCode } from "../store/fileLock.js";

export const INSTRUCTION_FILE_NAME = "AGENTS.md";
/** Characters of one instruction file that go into a turn. */
export const INSTRUCTION_CHAR_LIMIT = 8_000;
export const INSTRUCTION_MAX_BYTES = 1024 * 1024;

export type InstructionState =
  | { kind: "missing" }
  | { kind: "loaded"; chars: number }
  | { kind: "truncated"; chars: number }
  | { kind: "skipped"; reason: string };

export interface InstructionFile {
  scope: "user" | "project";
  path: string;
  /** What goes into the turn, including the truncation note. Empty unless loaded or truncated. */
  text: string;
  state: InstructionState;
}

export interface InstructionFiles {
  user: InstructionFile;
  /** Null when no workspace is selected. */
  project: InstructionFile | null;
}

function insideWorkspace(root: string, target: string): boolean {
  return process.platform === "win32"
    ? isPathInside(root.toLowerCase(), target.toLowerCase())
    : isPathInside(root, target);
}

async function readOne(
  scope: "user" | "project",
  path: string,
  workspaceRoot: string | null,
): Promise<InstructionFile> {
  const file = (state: InstructionState, text = ""): InstructionFile => ({ scope, path, text, state });
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    return errorCode(err) === "ENOENT" ? file({ kind: "missing" }) : file({ kind: "skipped", reason: "读取失败" });
  }
  if (!info.isFile()) return file({ kind: "skipped", reason: "不是普通文件" });
  if (info.size > INSTRUCTION_MAX_BYTES) return file({ kind: "skipped", reason: "文件超过 1 MiB" });
  let raw: string;
  try {
    if (workspaceRoot !== null) {
      const [real, root] = await Promise.all([realpath(path), realpath(workspaceRoot)]);
      if (!insideWorkspace(root, real)) return file({ kind: "skipped", reason: "文件指到了工作区外" });
    }
    raw = await readFile(path, "utf8");
  } catch {
    return file({ kind: "skipped", reason: "读取失败" });
  }
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (text.length <= INSTRUCTION_CHAR_LIMIT) return file({ kind: "loaded", chars: text.length }, text);
  const rest = text.length - INSTRUCTION_CHAR_LIMIT;
  const note =
    scope === "project"
      ? `正文在此截断。后面还有 ${rest} 字。需要后文时用 read_file 读 ${INSTRUCTION_FILE_NAME}。`
      : `正文在此截断。后面还有 ${rest} 字没有加载。`;
  return file({ kind: "truncated", chars: text.length }, `${text.slice(0, INSTRUCTION_CHAR_LIMIT)}\n\n${note}`);
}

/**
 * `~/.long-task-agent/AGENTS.md` and `{workspace}/AGENTS.md`, nothing else:
 * no parent or child directories, no imports. A workspace file that resolves
 * outside the workspace is skipped, so a repository cannot send a private
 * file to the model provider through a link.
 */
export async function readInstructionFiles(input: {
  home: string;
  workspacePath: string | null;
}): Promise<InstructionFiles> {
  const [user, project] = await Promise.all([
    readOne("user", join(input.home, INSTRUCTION_FILE_NAME), null),
    input.workspacePath === null
      ? Promise.resolve(null)
      : readOne("project", join(input.workspacePath, INSTRUCTION_FILE_NAME), input.workspacePath),
  ]);
  return { user, project };
}