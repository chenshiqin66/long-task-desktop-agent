import { isAbsolute, normalize, resolve, sep } from "node:path";

export function isPathInside(workspacePath: string, candidate: string): boolean {
  const root = resolve(workspacePath) + sep;
  const target = resolve(candidate);
  if (target === resolve(workspacePath)) return true;
  return target.startsWith(root);
}

export function resolveWithinWorkspace(
  workspacePath: string,
  relativeOrAbsolute: string,
): string {
  const root = resolve(workspacePath);
  const candidate = isAbsolute(relativeOrAbsolute)
    ? resolve(relativeOrAbsolute)
    : resolve(root, normalize(relativeOrAbsolute));
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path is outside workspace: ${relativeOrAbsolute}`);
  }
  return candidate;
}
