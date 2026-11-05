import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "../src/skills/installedSkills.js";
import { classifyToolCall } from "../src/tools/policy.js";
import { runSkillScriptTool } from "../src/tools/runSkillScript.js";
import type { ToolContext } from "../src/tools/types.js";

const skillMd = `---
name: demo
description: Run a tiny script.
---
Do the thing.
`;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function ctx(workspace: string, skillsRoot: string): ToolContext {
  return {
    workspacePath: workspace,
    bashTimeoutMs: 15_000,
    maxToolOutputChars: 4_000,
    maxReadChars: 4_000,
    maxSearchResults: 5,
    skillsRoot,
  };
}

describe("run_skill_script", () => {
  it("asks before running and refuses a shell-style args string", () => {
    expect(classifyToolCall("run_skill_script", JSON.stringify({ name: "demo", path: "scripts/echo.js" })).risk).toBe(
      "write",
    );
  });

  it("runs node with argv entries and the workspace as cwd, and rejects paths outside the skill", async () => {
    const root = await tempDir("skill-run-root-");
    const source = await tempDir("skill-run-src-");
    const workspace = await tempDir("skill-run-ws-");
    const outside = await tempDir("skill-run-out-");
    try {
      await mkdir(join(source, "scripts"), { recursive: true });
      await writeFile(join(source, "SKILL.md"), skillMd, "utf8");
      await writeFile(
        join(source, "scripts", "echo.js"),
        "console.log(process.argv.slice(2).join('\\n')); console.log(process.cwd());",
        "utf8",
      );
      await writeFile(join(source, "scripts", "note.ps1"), "Get-Content C:\\Windows\\win.ini\n", "utf8");
      await installSkill(source, root);

      const stringArgs = await runSkillScriptTool.execute(
        { name: "demo", path: "scripts/echo.js", args: "Get-Content C:\\secret" },
        ctx(workspace, root),
      );
      expect(stringArgs.is_error).toBe(true);
      expect(stringArgs.content).toMatch(/字符串数组/);

      const ran = await runSkillScriptTool.execute(
        { name: "demo", path: "scripts/echo.js", args: ["Get-Content C:\\secret", "second"] },
        ctx(workspace, root),
      );
      expect(ran.is_error).toBe(false);
      expect(ran.content).toContain("Get-Content C:\\secret");
      expect(ran.content).toContain("second");
      expect(ran.content.toLowerCase()).toContain(workspace.toLowerCase());

      const escaped = await runSkillScriptTool.execute(
        { name: "demo", path: "../outside.js" },
        ctx(workspace, root),
      );
      expect(escaped.is_error).toBe(true);
      expect(escaped.content).toMatch(/超出技能目录/);

      const powershell = await runSkillScriptTool.execute(
        { name: "demo", path: "scripts/note.ps1" },
        ctx(workspace, root),
      );
      expect(powershell.is_error).toBe(true);
      expect(powershell.content).toMatch(/\.py、\.js/);

      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      try {
        await symlink(join(outside, "secret.txt"), join(root, "demo", "scripts", "leak.js"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      const leak = await runSkillScriptTool.execute(
        { name: "demo", path: "scripts/leak.js" },
        ctx(workspace, root),
      );
      expect(leak.is_error).toBe(true);
      expect(leak.content).toMatch(/超出技能目录/);
      await expect(readFile(join(workspace, "secret.txt"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
