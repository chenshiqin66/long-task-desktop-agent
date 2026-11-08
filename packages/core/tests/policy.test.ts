import { describe, it, expect } from "vitest";
import { classifyBashCommand, classifyToolCall } from "../src/tools/policy.js";

describe("tool policy", () => {
  it("blocks dangerous root wipe", () => {
    expect(classifyBashCommand("rm -rf /").risk).toBe("blocked");
    expect(classifyBashCommand("mkfs /dev/sda").risk).toBe("blocked");
  });

  it("auto-allows common read-only commands", () => {
    for (const cmd of [
      "ls -la",
      "pwd",
      "cat README.md",
      "head -n 5 a.txt",
      "rg foo src",
      "grep -n bar x.ts",
      "echo hi",
      "test -f hello.txt && echo IN_WS",
      "git status",
      "git diff",
      "git log -1",
      "ls | head",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("read");
    }
  });

  it("requires confirmation for write/delete", () => {
    for (const cmd of [
      "rm file.txt",
      "rm -rf ./src",
      "mv a b",
      "cp a b",
      "mkdir x",
      "touch y",
      "echo hi > out.txt",
      "cat a >> b",
      "git commit -m x",
      "git push",
      "chmod 777 x",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
  });

  it("treats unknown / ambiguous as write", () => {
    expect(classifyBashCommand("python setup.py install").risk).toBe("write");
    expect(classifyBashCommand("npm install").risk).toBe("write");
  });

  it("classifyToolCall auto-allows read tools including list_dir", () => {
    expect(classifyToolCall("read_file", '{"path":"a.ts"}').risk).toBe("read");
    expect(classifyToolCall("list_dir", '{"path":"."}').risk).toBe("read");
    expect(classifyToolCall("keyword_search", '{"query":"x"}').risk).toBe("read");
    expect(classifyToolCall("web_search", '{"query":"news"}').risk).toBe("read");
    expect(classifyToolCall("read_skill", '{"name":"demo"}').risk).toBe("read");
    expect(classifyToolCall("task_create", '{"subject":"Write schema","description":"Add the table."}').risk).toBe(
      "read",
    );
    expect(classifyToolCall("claim_task", '{"task_id":"1"}').risk).toBe("read");
    expect(classifyToolCall("complete_task", '{"task_id":"1"}').risk).toBe("read");
    expect(
      classifyToolCall(
        "subagent",
        JSON.stringify({ subagent_type: "explore", task: "find auth", description: "find auth" }),
      ).risk,
    ).toBe("read");
  });

  it("classifyToolCall requires confirmation for write_file / str_replace / delete_file", () => {
    expect(classifyToolCall("write_file", '{"path":"a.html","content":"x"}').risk).toBe("write");
    expect(classifyToolCall("write_file", '{"path":"a.html","content":"x"}').summary).toMatch(
      /a\.html/,
    );
    expect(
      classifyToolCall("str_replace", '{"path":"a.ts","old_string":"a","new_string":"b"}').risk,
    ).toBe("write");
    expect(classifyToolCall("delete_file", '{"path":"a.ts"}').risk).toBe("write");
    expect(
      classifyToolCall(
        "subagent",
        JSON.stringify({
          subagent_type: "worker",
          task: "write the note",
          description: "write note",
          output_dir: "docs/notes",
        }),
      ).summary,
    ).toMatch(/docs\/notes/);
  });

  it("ask_user does not require command permission", () => {
    expect(classifyToolCall("ask_user", JSON.stringify({ question: "用 PDF 还是 HTML？" })).risk).toBe(
      "read",
    );
  });

  it("classifyToolCall delegates bash", () => {
    expect(classifyToolCall("bash", JSON.stringify({ command: "ls" })).risk).toBe("read");
    expect(classifyToolCall("bash", JSON.stringify({ command: "rm x" })).risk).toBe("write");
  });

  it("auto-allows a web get that does not save a file or send a mutating method", () => {
    expect(classifyBashCommand("curl https://example.com").risk).toBe("read");
    expect(classifyBashCommand("curl -fsSL https://example.com").risk).toBe("read");
    expect(classifyBashCommand("Invoke-WebRequest https://example.com").risk).toBe("read");
    expect(classifyBashCommand("iwr -Uri https://example.com").risk).toBe("read");
    expect(classifyBashCommand("Invoke-RestMethod https://example.com").risk).toBe("read");
    expect(classifyBashCommand("curl https://example.com -o page.html").risk).toBe("write");
    expect(classifyBashCommand("curl -X POST https://example.com").risk).toBe("write");
    expect(classifyBashCommand('iwr https://example.com -OutFile page.html').risk).toBe("write");
    expect(classifyBashCommand("iwr https://example.com -Method POST").risk).toBe("write");
    expect(classifyBashCommand("irm https://example.com -Body '{}'").risk).toBe("write");
  });

  it("treats common PowerShell inspection as read and a drive-root wipe as blocked", () => {
    expect(classifyToolCall("powershell", JSON.stringify({ command: "Get-ChildItem" })).risk).toBe(
      "read",
    );
    expect(
      classifyToolCall("powershell", JSON.stringify({ command: "Get-Content README.md" })).risk,
    ).toBe("read");
    expect(
      classifyToolCall("powershell", JSON.stringify({ command: "Set-Content a.txt hi" })).risk,
    ).toBe("write");
    expect(
      classifyToolCall(
        "powershell",
        JSON.stringify({ command: "Remove-Item -Recurse -Force C:\\" }),
      ).risk,
    ).toBe("blocked");
  });
});
