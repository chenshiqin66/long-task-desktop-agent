import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuiltinTools } from "../src/tools/host.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";

function repoPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

function repoFile(path: string): Promise<string> {
  return readFile(repoPath(path), "utf8");
}

/** Table rows under the README heading `## 配置`. */
async function readmeConfigRows(): Promise<string[]> {
  const readme = await repoFile("README.md");
  const section = readme.split(/^## /m).find((part) => part.startsWith("配置")) ?? "";
  return section.split("\n").filter((line) => line.startsWith("|"));
}

/** The README and the topic docs directly under docs/. */
async function docFiles(): Promise<string[]> {
  const names = await readdir(repoPath("docs"));
  return ["README.md", ...names.filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
}

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces turned into hyphens. */
function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

describe("docs stay in step with the code", () => {
  it("names every builtin tool in docs/tools-and-permissions.md", async () => {
    const doc = await repoFile("docs/tools-and-permissions.md");
    // The shell tool is `powershell` on Windows and `bash` elsewhere.
    const names = [...createBuiltinTools().map((tool) => tool.definition.name), "powershell", "bash"];
    expect(names.filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });

  it("lists every auto-run shell command in docs/tools-and-permissions.md", async () => {
    const policy = await repoFile("packages/core/src/tools/policy.ts");
    const names = ["READ_COMMANDS", "DIR_ONLY", "WEB_GET_CMDS"].flatMap((set) => {
      const body = new RegExp(`const ${set} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(policy)?.[1] ?? "";
      return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    });
    expect(names.length).toBeGreaterThan(50);
    const doc = (await repoFile("docs/tools-and-permissions.md")).toLowerCase();
    expect(names.filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });

  it("lists every StoredConfig field in the README config table", async () => {
    const types = await repoFile("packages/core/src/config/types.ts");
    const body = /interface StoredConfig \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    const fields = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]!);
    expect(fields.length).toBeGreaterThan(0);
    const rows = (await readmeConfigRows()).join("\n");
    expect(fields.filter((field) => !rows.includes(`\`${field}\``))).toEqual([]);
  });

  it("gives the code's default for each limit in the README config table", async () => {
    const rows = await readmeConfigRows();
    const wrong = Object.entries(DEFAULT_AGENT_CONFIG).filter(([field, value]) => {
      const row = rows.find((line) => line.includes(`\`${field}\``)) ?? "";
      return !new RegExp(`(?<!\\d)${value}(?!\\d)`).test(row);
    });
    expect(wrong).toEqual([]);
  });

  it("resolves every relative link and anchor in the README and docs", async () => {
    const broken: string[] = [];
    for (const file of await docFiles()) {
      const text = await repoFile(file);
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target!)) continue;
        const [path, anchor] = target!.split("#");
        const linked = path ? posix.join(posix.dirname(file), path) : file;
        const body = await repoFile(linked).catch(() => null);
        const anchors = (body ?? "")
          .split("\n")
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) => headingAnchor(line.replace(/^#+ /, "")));
        if (body === null || (anchor && !anchors.includes(decodeURIComponent(anchor)))) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
