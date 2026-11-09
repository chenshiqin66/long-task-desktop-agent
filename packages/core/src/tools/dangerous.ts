/** Disk-level tools: formatting, partitioning, raw writes to a block device. */
const DISK_PATTERNS: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\b[\s\S]*\bof=\/dev\//i,
  /\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/i,
  // `format` as a command word, not `-Format` or `Format-Table`.
  /(?:^|[\s;|&(])format(?:\.com|\.exe)?\s+(?:\/\S+\s+)*["']?[a-z]:/i,
  /\b(?:diskpart|wipefs|blkdiscard)\b/i,
  /\b(?:shred|fdisk|sfdisk|sgdisk|gdisk|parted)\b[^;|&\n]*\/dev\//i,
  />\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk)/i,
];

/** bash rm, cmd del / rd, and Remove-Item with its PowerShell aliases. */
const REMOVE_COMMANDS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]);

/** PowerShell reads both quote families; `‘C:\’` is a quoted `C:\`. */
const QUOTE_FAMILY: Record<string, string> = {
  "'": "'",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  '"': '"',
  "“": '"',
  "”": '"',
  "„": '"',
};

/**
 * Statements, each a pipeline of stages, each stage its words with quotes removed.
 * A quoted word with spaces may be a command handed to `bash -c` or `cmd /c`, so it is read again.
 * This is a best-effort reading for the blocklist, not the classifier's scanner.
 */
function pipelines(command: string): string[][][] {
  const statements: string[][][] = [];
  const nested: string[] = [];
  let stages: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  let quote: string | null = null;
  const endWord = () => {
    if (word || quoted) words.push(word);
    if (quoted && /\s/.test(word)) nested.push(word);
    word = "";
    quoted = false;
  };
  const endStage = () => {
    endWord();
    if (words.length) stages.push(words);
    words = [];
  };
  const endStatement = () => {
    endStage();
    if (stages.length) statements.push(stages);
    stages = [];
  };
  for (const ch of command) {
    if (quote) {
      if (QUOTE_FAMILY[ch] === quote) quote = null;
      else word += ch;
    } else if (QUOTE_FAMILY[ch]) {
      quote = QUOTE_FAMILY[ch]!;
      quoted = true;
    } else if (ch === "|") {
      endStage();
    } else if (";&\n()`".includes(ch)) {
      endStatement();
    } else if (/\s/.test(ch) || ch === "{" || ch === "}") {
      endWord();
    } else {
      word += ch;
    }
  }
  endStatement();
  return [...statements, ...nested.flatMap(pipelines)];
}

/** `/`, `C:\`, `C:`, `\`, `/*`, `C:/*.*`, `//`, `/tmp/..`: the root of a filesystem or drive, or everything in it. */
function isRootTarget(raw: string): boolean {
  let path = raw
    .replace(/^(?:[\w.]+\\)?filesystem::/i, "")
    .replace(/^\\\\[?.]\\/, "")
    .replace(/^(?:\$\{?env:systemdrive\}?|%systemdrive%)/i, "C:")
    .replace(/\\/g, "/");
  let absolute = path.startsWith("/");
  if (/^[a-z]:/i.test(path)) {
    absolute = true;
    path = path.slice(2);
  }
  if (!absolute) return false;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.every((part) => /^\*+(?:\.\*)?$/.test(part));
}

/** `-r`, `-rf`, `-R`, `--recursive`, `/s`, and `-Recurse` or any prefix of it. */
function isRecursiveFlag(word: string): boolean {
  const flag = word.toLowerCase();
  if (flag === "--recursive" || flag === "/s") return true;
  if (/^-[dfirv]+$/.test(flag) && flag.includes("r")) return true;
  const name = flag.replace(/:\$?true$/, "").slice(1);
  return flag.startsWith("-") && name.length > 0 && "recurse".startsWith(name);
}

/** `-x`, `--x`, and cmd switches such as `/s` or `/q`. A bare `/` is a path. */
function isOption(word: string): boolean {
  return word.startsWith("-") || /^\/[a-z](?::\S*)?$/i.test(word);
}

function commandName(word: string): string {
  return word
    .toLowerCase()
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/, "");
}

/** Items that arrive on the pipeline: `$_`, `$PSItem`, or xargs' `{}`. */
function isPipelineItem(word: string): boolean {
  return /^(?:\$_|\$psitem)\b/i.test(word) || word === "{}";
}

function wipesRoot(stages: string[][]): boolean {
  return stages.some((words, index) => {
    const at = words.findIndex((word) => REMOVE_COMMANDS.has(commandName(word)));
    if (at < 0) return false;
    const args = words.slice(at + 1);
    const paramValues = args.flatMap((arg) => /^-[a-z]+:(.+)$/i.exec(arg)?.[1] ?? []);
    const targets = [...args.filter((arg) => !isOption(arg)), ...paramValues];
    if (args.some(isRecursiveFlag) && targets.some(isRootTarget)) return true;
    // `Get-ChildItem C:\ | Remove-Item`: the root comes in through the pipe.
    const fed = targets.every(isPipelineItem);
    return fed && stages.slice(0, index).some((stage) => stage.slice(1).some((word) => !isOption(word) && isRootTarget(word)));
  });
}

/**
 * Commands that are never run, approved or not: recursive deletion of a
 * filesystem or drive root, and disk-level formatting or wiping. A path built
 * from a variable, such as `rm -rf "$DIR/"`, is not recognised.
 */
export function isDangerousBash(command: string): boolean {
  const trimmed = command.trim();
  if (DISK_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return pipelines(trimmed).some(wipesRoot);
}
