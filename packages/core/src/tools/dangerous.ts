const OTHER_PATTERNS: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\b[\s\S]*\bof=\/dev\//i,
  /\b(format-volume|clear-disk|initialize-disk)\b/i,
  /\bformat(?:\.exe)?\s+[a-zA-Z]:/i,
];

/** True when path arg is filesystem root `/` or `/*`, not `/tmp` etc. */
function targetsFilesystemRoot(command: string): boolean {
  return /(?:^|[\s;|&])\/(\*)?(?=[\s;|&]|$)/.test(command);
}

function rmHasRecursiveAndForce(command: string): boolean {
  const hasRecursive =
    /(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*(?:\s|$)/i.test(command) ||
    /(?:^|\s)--recursive(?:\s|$)/i.test(command);
  const hasForce =
    /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)/i.test(command) ||
    /(?:^|\s)--force(?:\s|$)/i.test(command);
  return hasRecursive && hasForce;
}

/** Recursive forced delete of a drive root (`C:\`, `C:\*`, `\`), not `C:\Users` or `.\build`. */
function targetsWindowsDriveRoot(command: string): boolean {
  const root =
    /(?:^|[\s'"`])[A-Za-z]:\\?\*(?=[\s'"`]|$)/.test(command) ||
    /(?:^|[\s'"`])[A-Za-z]:\\(?=[\s'"`]|$)/.test(command) ||
    /(?:^|[\s'"`])[A-Za-z]:(?=[\s'"`]|$)/.test(command) ||
    /(?:^|[\s'"`])\\\*(?=[\s'"`]|$)/.test(command) ||
    /(?:^|[\s'"`])\\(?=[\s'"`]|$)/.test(command);
  return root;
}

function isWindowsRootWipe(command: string): boolean {
  if (!/\b(remove-item|rm|del|rd|rmdir|ri|erase)\b/i.test(command)) return false;
  const recurse =
    /(?:^|[\s;|&])-(?:Recurse|r)\b/i.test(command) ||
    /(?:^|[\s;|&])\/s\b/i.test(command);
  const force =
    /(?:^|[\s;|&])-(?:Force|f|fo)\b/i.test(command) ||
    /(?:^|[\s;|&])\/q\b/i.test(command);
  return recurse && force && targetsWindowsDriveRoot(command);
}

export function isDangerousBash(command: string): boolean {
  const trimmed = command.trim();
  if (OTHER_PATTERNS.some((p) => p.test(trimmed))) return true;
  if (/\brm\b/i.test(trimmed) && rmHasRecursiveAndForce(trimmed) && targetsFilesystemRoot(trimmed)) {
    return true;
  }
  if (isWindowsRootWipe(trimmed)) return true;
  return false;
}
