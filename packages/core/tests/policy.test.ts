import { describe, it, expect } from "vitest";
import { classifyBashCommand, classifyToolCall } from "../src/tools/policy.js";

describe("tool policy", () => {
  it("blocks dangerous root wipe", () => {
    expect(classifyBashCommand("rm -rf /").risk).toBe("blocked");
    expect(classifyBashCommand("mkfs /dev/sda").risk).toBe("blocked");
    for (const cmd of [
      "dd if=/dev/zero of=/dev/sda",
      "Clear-Disk -Number 0",
      "Initialize-Disk -Number 1",
      "format D:",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("blocked");
    }
  });

  it("requires confirmation for every argument rule the docs list", () => {
    for (const cmd of [
      "git -c core.fsmonitor=./evil.sh status",
      "git -C sub status",
      "git --no-pager log",
      "tree -R",
      "find . -execdir rm {} +",
      "find . -ok rm {} ;",
      "find . -okdir rm {} ;",
      "find . -fprint0 out.txt",
      "find . -fprintf out.txt %p",
      "find . -fls out.txt",
      "sort --output=out.txt in.txt",
      "sort --compress-program=./evil.sh in.txt",
      "curl -O https://example.com/a.zip",
      "curl -T a.txt https://example.com",
      "curl -d x=1 https://example.com",
      "curl -F f=@a.txt https://example.com",
      "curl -c jar.txt https://example.com",
      "curl --trace log.txt https://example.com",
      "curl --data-raw x https://example.com",
      "curl --out page.html https://example.com",
      "curl -w %output{out.txt} https://example.com",
      "curl --json x https://example.com",
      "ls &> all.txt",
      "iwr https://example.com –OutFile page.html",
      "iwr https://example.com -cm PATCH",
      "iwr https://example.com -InFile a.txt",
      "iwr https://example.com -Form @{a=1}",
      "iwr https://example.com -CustomMethod PATCH",
      "iwr https://example.com -Resume",
      "Get-ChildItem --% > out.txt",
      "ls a#b",
      "ls {a,b}",
      "test -R ref",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
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
      "printf '%s\\n' -v",
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

  it("requires confirmation for anything run through sudo", () => {
    for (const cmd of ["sudo cat /etc/shadow", "sudo ls", "SUDO ls", "sudo -u root cat a"]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
    expect(classifyBashCommand("sudo rm -rf /").risk).toBe("blocked");
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

  it("requires confirmation when a read command runs another command inside its arguments", () => {
    for (const cmd of [
      "echo $(rm -rf src)",
      'echo "$(rm -rf src)"',
      "echo `rm -rf src`",
      "cat <(rm -rf src)",
      "Write-Output (Remove-Item -Recurse -Force src)",
      "Get-ChildItem | Where-Object { Remove-Item $_ }",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
  });

  it("does not split inside quotes, where a separator would misalign the quotes", () => {
    expect(classifyBashCommand('echo "a;ls" > out.txt "b"').risk).toBe("write");
    expect(classifyBashCommand('echo "a&&ls" > out.txt "b"').risk).toBe("write");
    expect(classifyBashCommand('echo "a;b" "c|d"').risk).toBe("read");
  });

  it("does not let a quote inside another kind of quote hide a redirect", () => {
    expect(classifyBashCommand(`echo "a'" > out.txt "'b"`).risk).toBe("write");
  });

  it("reads the command name the way the shell does, after quotes and escapes", () => {
    expect(classifyBashCommand('gi"t" push --force').risk).toBe("write");
    expect(classifyBashCommand("gi\\t clean -fdx").risk).toBe("write");
    expect(classifyBashCommand('l"s" -la').risk).toBe("read");
  });

  it("splits on a lone & and a carriage return", () => {
    expect(classifyBashCommand("ls & rm -rf src").risk).toBe("write");
    expect(classifyBashCommand("ls\rrm -rf src").risk).toBe("write");
  });

  it("requires confirmation when bash or PowerShell would run text the scan took as quoted or commented", () => {
    for (const cmd of [
      "ls \\ # > out.txt",
      "ls # '\nrm -rf src # '",
      "ls \\\n#'\nrm -rf src #'",
      "cat <<EOF\nls '\nEOF\nrm -rf src #'",
      "Write-Output @'\n'\nls \"\n'@ > out.txt; echo \"x\"",
      "Write-Output ${a'b} > out.txt #'",
      "ls <# ' #> > out.txt #'",
      'echo "a\\" \' " > out.txt #\'',
      "echo $'\\' ' > out.txt #'",
      "Write-Output \u2018x' > out.txt 'y'",
      "echo \u201c > out.txt \u201d",
      "ls 2>/dev/null|sh",
      "ls\u0000; rm -rf src",
    ]) {
      expect(classifyBashCommand(cmd).risk, JSON.stringify(cmd)).toBe("write");
    }
  });

  it("requires confirmation for read commands that can still run code or write", () => {
    for (const cmd of [
      "test -v 'a[$(rm -rf src)]'",
      "[ -v 'a[$(rm -rf src)]' ]",
      "[ -R 'a[$(rm -rf src)]' ]",
      "printf -v 'a[$(rm -rf src)]' x",
      "printf -v'a[$(rm -rf src)]' x",
      "printf -xv'a[$(rm -rf src)]' x",
      "sort -bo out.txt in.txt",
      "rg --hostname-bin=./evil.sh foo",
      "file -C -m magic",
      "curl -sX POST https://example.com",
      "iwr https://example.com -B x",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
  });

  it("keeps comments, Chinese quotes, and Windows paths in read commands read-only", () => {
    for (const cmd of [
      "# list files\nls -la",
      "ls -la # show all",
      'rg "\u201c任务\u201d" src',
      "echo \u201c你好\u201d",
      'Get-ChildItem "D:\\work\\"',
      "uniq in.txt 2>/dev/null",
      "iwr https://example.com -o page.html",
    ]) {
      expect(classifyBashCommand(cmd).risk, JSON.stringify(cmd)).toBe("read");
    }
  });

  it("requires confirmation for write flags on otherwise read-only commands", () => {
    for (const cmd of [
      "find . -delete",
      'find . -name "*.tmp" -exec rm {} +',
      "find . -fprint out.txt",
      "find . '-delete'",
      "git branch -D main",
      "git branch -m old new",
      "git branch feature-x",
      "git log --output=log.txt",
      "git diff --output=d.patch",
      "sort -o sorted.txt a.txt",
      "tree -o tree.txt",
      "rg --pre ./evil.sh foo",
      "uniq in.txt out.txt",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
  });

  it("treats a redirect as a write unless it goes to a null device or another stream", () => {
    expect(classifyBashCommand("ls 2> errors.txt").risk).toBe("write");
    expect(classifyBashCommand("ls *> all.txt").risk).toBe("write");
    for (const cmd of ["ls 2>/dev/null", "git status 2>&1", "Get-ChildItem 2>$null", "ls > /dev/null"]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("read");
    }
  });

  it("catches web-get writes hidden in option clusters, quotes, and PowerShell prefixes", () => {
    for (const cmd of [
      "curl -sSo page.html https://example.com",
      'curl "-o" page.html https://example.com',
      "curl -D headers.txt https://example.com",
      "curl -K curl.cfg https://example.com",
      "iwr https://example.com -OutF page.html",
      "irm https://example.com -Method:Post",
      "iwr https://example.com \u2013OutFile page.html",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("write");
    }
    for (const cmd of [
      "curl -sS https://example.com",
      "curl -I https://example.com",
      "curl -X GET https://example.com",
      "iwr -Uri https://example.com -UseBasicParsing",
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("read");
    }
  });

  it("keeps quoted text, parameter expansion, and listing forms read-only", () => {
    for (const cmd of [
      "echo '$(rm -rf src)'",
      'grep -n "foo(" src/a.ts',
      "rg 'a|b' src",
      "echo ${HOME}",
      "git branch",
      "git branch -a",
      "git branch --show-current",
      "git branch -vv",
      "sort a.txt",
      "uniq in.txt",
      "find . -name '*.ts'",
      "Get-ChildItem -Recurse -Filter *.ts",
      "Get-ChildItem | sort -Property Length -Descending",
      'Select-String -Path src\\*.ts -Pattern "foo("',
    ]) {
      expect(classifyBashCommand(cmd).risk, cmd).toBe("read");
    }
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
