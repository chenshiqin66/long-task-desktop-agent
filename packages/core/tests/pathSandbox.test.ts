import { describe, it, expect } from "vitest";
import { resolveWithinWorkspace, isPathInside } from "../src/pathSandbox.js";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("pathSandbox", () => {
  // Use resolve() so expectations match pathSandbox (Windows maps "/tmp/..." to "<drive>:\tmp\...").
  const ws = resolve(tmpdir(), "my-workspace-sandbox");

  it("resolves relative paths inside workspace", () => {
    expect(resolveWithinWorkspace(ws, "src/a.ts")).toBe(resolve(ws, "src/a.ts"));
  });

  it("allows absolute paths that stay inside workspace", () => {
    expect(resolveWithinWorkspace(ws, join(ws, "readme.md"))).toBe(resolve(ws, "readme.md"));
  });

  it("rejects parent-directory escape", () => {
    expect(() => resolveWithinWorkspace(ws, "../outside.txt")).toThrow(/outside/i);
  });

  it("rejects absolute paths outside workspace", () => {
    const outside = resolve(tmpdir(), "definitely-outside-sandbox", "passwd");
    expect(() => resolveWithinWorkspace(ws, outside)).toThrow(/outside/i);
  });

  it("isPathInside is false for sibling prefix paths", () => {
    expect(isPathInside(ws, resolve(tmpdir(), "my-workspace-sandbox-evil", "x"))).toBe(false);
    expect(isPathInside(ws, join(ws, "ok"))).toBe(true);
  });
});
