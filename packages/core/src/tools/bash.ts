import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isDangerousBash } from "./dangerous.js";

export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

/** Kill bash and its children. SIGKILL alone often leaves Git-Bash trees alive on Windows (EBUSY). */
export function forceKillChild(child: ChildProcess): void {
  if (process.platform === "win32") {
    const pid = child.pid;
    if (pid) {
      try {
        // sync so cwd unlocks before tests' afterEach rm
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        /* fall through */
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

/** Reject oversized shell payloads that should use write_file / str_replace instead. */
export const MAX_BASH_COMMAND_CHARS = 8_000;

/** Tool name sent to the model. On Windows this is PowerShell, so the model does not emit bash. */
export const SHELL_TOOL_NAME = process.platform === "win32" ? "powershell" : "bash";

const POWERSHELL_DESCRIPTION =
  "Run a command in the workspace with Windows PowerShell (powershell.exe). The host is Windows: use PowerShell 5.1 syntax and Windows paths (C:\\folder\\file). PowerShell 5.1 has no && or ||; chain with semicolons or if. Do not launch bash.exe, wsl.exe, or Git Bash, and do not use /mnt, /usr, apt, or fc-list. Do not create or edit file contents with here-strings, Set-Content, Add-Content, Out-File, or redirection; use write_file or str_replace. Prefer list_dir, read_file, and keyword_search for inspection.";

const BASH_DESCRIPTION =
  "Run a shell command in the workspace directory. Do not use bash to create or edit file contents (no heredoc, echo/printf redirects); use write_file or str_replace instead. Prefer list_dir / read_file / keyword_search for inspection when possible.";

export const bashTool: Tool = {
  definition: {
    name: SHELL_TOOL_NAME,
    description: process.platform === "win32" ? POWERSHELL_DESCRIPTION : BASH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            process.platform === "win32"
              ? "Windows PowerShell command to run in the workspace"
              : "Shell command to run",
        },
      },
      required: ["command"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command) return { content: "Missing command", is_error: true };
    if (command.length > MAX_BASH_COMMAND_CHARS) {
      return {
        content: `Command too long (${command.length} chars; max ${MAX_BASH_COMMAND_CHARS}). Use write_file or str_replace for file content instead of shell redirection or here-strings.`,
        is_error: true,
      };
    }
    if (isDangerousBash(command)) {
      return { content: "Blocked dangerous command", is_error: true };
    }
    return runBash(command, ctx);
  },
};

/**
 * Windows PowerShell 5.1 reads -EncodedCommand as UTF-16LE, so Chinese paths survive.
 * The wrapper makes a native non-zero exit fail the tool. PowerShell otherwise
 * exits 0 when the last pipeline stage (for example `tail`) succeeds.
 */
function encodePowerShell(command: string): string {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$LASTEXITCODE = 0",
    command,
    "if (-not $?) { exit 1 }",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

function spawnShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)],
      { cwd, env: process.env, windowsHide: true },
    );
  }
  return spawn("bash", ["-lc", command], {
    cwd,
    env: process.env,
    windowsHide: true,
  });
}

function runBash(command: string, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.signal?.aborted) {
    return Promise.resolve({ content: "Command cancelled", is_error: true });
  }

  return new Promise((resolve) => {
    const child = spawnShell(command, ctx.workspacePath);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let capped = false;
    const budget = Math.max(0, ctx.maxToolOutputChars);

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve({
        content: truncateOutput(result.content, ctx.maxToolOutputChars),
        is_error: result.is_error,
      });
    };

    const killForCap = () => {
      if (capped) return;
      capped = true;
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      forceKillChild(child);
    };

    const appendChunk = (which: "out" | "err", chunk: string) => {
      if (settled || capped) return;
      const used = stdout.length + stderr.length;
      if (used >= budget) {
        killForCap();
        return;
      }
      const room = budget - used;
      const take = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (which === "out") stdout += take;
      else stderr += take;
      if (stdout.length + stderr.length >= budget) {
        killForCap();
      }
    };

    const timer = setTimeout(() => {
      forceKillChild(child);
      finish({
        content: `Command timeout after ${ctx.bashTimeoutMs}ms`,
        is_error: true,
      });
    }, ctx.bashTimeoutMs);

    const onAbort = () => {
      forceKillChild(child);
      finish({ content: "Command cancelled", is_error: true });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      appendChunk("out", String(d));
    });
    child.stderr.on("data", (d) => {
      appendChunk("err", String(d));
    });
    child.on("error", (err) => {
      finish({ content: String(err), is_error: true });
    });
    child.on("close", (code) => {
      const content = [stdout, stderr].filter(Boolean).join("\n");
      // Capped kills are non-zero exits; still return truncated payload as success-of-capture.
      if (capped) {
        finish({
          content: content || `(exit ${code ?? "?"})`,
          is_error: false,
        });
        return;
      }
      finish({
        content: content || `(exit ${code ?? "?"})`,
        is_error: code !== 0,
      });
    });
  });
}
