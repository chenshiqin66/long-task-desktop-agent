import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, TaskStore } from "@agent/core";
import type { Message } from "@agent/core";
import type { EvalCase, PriorTask, TranscriptEntry } from "./types.js";

export interface PreparedWorkspace {
  /** Isolated fixture workspace. Never the repo itself. */
  root: string;
  /** Empty skills root, so the user's installed skills do not leak into prompts. */
  skillsRoot: string;
  sessionId: string;
  /** Files written from `fixture`, relative to root. */
  fixtureFiles: string[];
  cleanup(): Promise<void>;
}

async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
}

async function writeFixture(root: string, fixture: Record<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(fixture)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relative.replace(/\\/g, "/"));
  }
  return written;
}

/**
 * cases.json keeps the test stub on purpose ("故意不在用例里给答案"). For flow
 * cases that ask the parent to run `npm test`, a missing package.json would
 * only produce ENOENT and mask the behavior under test. Add a pass-through
 * script when the fixture has a test/ directory but no package.json.
 *
 * This does not verify the fix; it makes "the parent runs npm test itself"
 * observable. Cases that bring their own package.json keep it untouched.
 */
async function scaffoldNpmTest(root: string, fixture: Record<string, string>): Promise<void> {
  const hasTestDir = Object.keys(fixture).some((path) => path.replace(/\\/g, "/").startsWith("test/"));
  if (!hasTestDir || Object.keys(fixture).some((path) => path.replace(/\\/g, "/") === "package.json")) return;
  const pkg = {
    name: "eval-fixture",
    private: true,
    scripts: { test: "node -e \"console.log('eval fixture: npm test reached')\"" },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function historyMessages(sessionId: string, entries: TranscriptEntry[]): Message[] {
  const messages: Message[] = [];
  let toolCounter = 0;
  for (const [index, entry] of entries.entries()) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const turn_id = `turn_hist_${Math.floor(index / 2) + 1}`;
    if (entry.role === "tool") {
      // A tool message is only legal after an assistant message with a matching
      // tool_call. The case transcripts are illustrative, so synthesize the pair.
      let assistant = [...messages].reverse().find((message) => message.role === "assistant");
      if (!assistant) {
        assistant = {
          id: `msg_hist_${index}_assistant`,
          session_id: sessionId,
          turn_id,
          role: "assistant",
          content: "",
          created_at: createdAt,
        };
        messages.push(assistant);
      }
      const id = `call_hist_${++toolCounter}`;
      assistant.tool_calls = [
        ...(assistant.tool_calls ?? []),
        { id, type: "function", function: { name: entry.name ?? "tool", arguments: "{}" } },
      ];
      messages.push({
        id: `msg_hist_${index}`,
        session_id: sessionId,
        turn_id,
        role: "tool",
        name: entry.name,
        tool_call_id: id,
        content: entry.content,
        is_error: false,
        created_at: createdAt,
      });
      continue;
    }
    messages.push({
      id: `msg_hist_${index}`,
      session_id: sessionId,
      turn_id,
      role: entry.role,
      content: entry.content,
      created_at: createdAt,
    });
  }
  return messages;
}

async function seedTasks(root: string, sessionId: string, tasks: PriorTask[]): Promise<void> {
  if (!tasks.length) return;
  const store = TaskStore.forSession(root, sessionId);
  for (const task of tasks) {
    const created = await store.create({
      subject: task.subject,
      description: task.description,
      blockedBy: task.blockedBy ?? [],
    });
    if (!created.ok) throw new Error(`Cannot seed prior task #${task.id}: ${created.error}`);
    if (created.value.id !== task.id) {
      throw new Error(`Prior task #${task.id} was assigned id ${created.value.id}. Prior ids must be 1..n in order.`);
    }
    const status = task.status ?? "pending";
    if (status === "pending") continue;
    const owner = task.owner ?? "main";
    const claimed = await store.claim(task.id, owner);
    if (!claimed.ok) throw new Error(`Cannot claim prior task #${task.id}: ${claimed.error}`);
    if (status === "completed") {
      const done = await store.complete(task.id, owner);
      if (!done.ok) throw new Error(`Cannot complete prior task #${task.id}: ${done.error}`);
    }
  }
}

export async function prepareWorkspace(
  c: EvalCase,
  opts: { scaffoldNpmTest?: boolean } = {},
): Promise<PreparedWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `lst-eval-${c.id}-`));
  const skillsRoot = await mkdtemp(join(tmpdir(), `lst-eval-skills-${c.id}-`));
  try {
    const fixture = c.fixture ?? {};
    const fixtureFiles = await writeFixture(root, fixture);
    if (opts.scaffoldNpmTest) await scaffoldNpmTest(root, fixture);

    const sessions = new SessionStore(root);
    const meta = await sessions.createSession(`eval ${c.id}`);
    if (c.transcript?.length) {
      for (const message of historyMessages(meta.session_id, c.transcript)) {
        await sessions.appendMessage(message);
      }
    }
    if (c.prior_tasks?.length) await seedTasks(root, meta.session_id, c.prior_tasks);
    // SessionStore already created messages.jsonl. Touch it once so an empty
    // transcript still produces a valid, readable file.
    await readFile(join(root, ".agent", "sessions", meta.session_id, "messages.jsonl"), "utf8");

    return {
      root,
      skillsRoot,
      sessionId: meta.session_id,
      fixtureFiles,
      cleanup: async () => {
        await removeTree(root);
        await removeTree(skillsRoot);
      },
    };
  } catch (err) {
    await removeTree(root);
    await removeTree(skillsRoot);
    throw err;
  }
}
