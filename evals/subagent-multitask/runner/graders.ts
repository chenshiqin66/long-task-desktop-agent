import type { Check, Grader, GraderContext, GraderResult } from "./grade.js";
import type { Observation, ObservedCall } from "./observe.js";
import {
  add,
  after,
  baseChecks,
  checkExpectedTasks,
  checkNoTasks,
  checkParallelBatch,
  childCallsNamed,
  countSubagents,
  hasNoVagueTask,
  noChildTaskMutations,
  normalizePath,
  parentNamed,
  parentCallsInFirstBatch,
  parentHasCall,
  resultAccepted,
  resultOf,
  subagentTaskTexts,
  subagents,
  taskOwner,
  taskStatus,
  taskText,
  writesByParent,
} from "./grade.js";
import { hasFile, fileContent, textArg } from "./observe.js";

const isJoined = (call: ObservedCall): boolean => {
  const value = call.args.delivery;
  return value === undefined || value === "" || value === "joined";
};

const isDeferred = (call: ObservedCall): boolean => call.args.delivery === "deferred";

/**
 * A delegated task may quote `npm test` as background ("我运行 npm test 失败了")
 * or forbid it ("不要运行任何测试命令") without telling the subagent to run it.
 * Return the offending fragment, or null when the task only mentions the command.
 */
function runTestInstruction(text: string): string | null {
  for (const match of text.matchAll(/(运行|跑|执行)(一下)?\s*`?(npm test|测试)`?/gi)) {
    const before = text.slice(Math.max(0, match.index! - 12), match.index!);
    const afterText = text.slice(match.index! + match[0].length, match.index! + match[0].length + 14);
    if (/(不要|不需要|无需|不用|不得|别|不许|禁止|勿|父会话|父代理|主会话|主代理|我会|我来|由我)[^，。；\n]{0,6}$/.test(before)) continue;
    if (/^[，,。；;\s]{0,4}(命令|测试|它)?\s*(失败|报错|出错|不通过|挂|failed|fails|is failing)/i.test(afterText)) continue;
    if (/(已经|刚才|之前|先前|早先)[^，。；\n]{0,6}$/.test(before)) continue;
    return text.slice(Math.max(0, match.index! - 20), match.index! + match[0].length + 20);
  }
  const english = /\b(run|rerun)\s+(the\s+)?(npm\s+test|tests?)\b(?!\s*(failed|fails))/i.exec(text);
  return english ? text.slice(Math.max(0, english.index - 20), english.index + english[0].length + 20) : null;
}

const taskIdOf = (call: ObservedCall): string => {
  const value = call.args.task_id;
  return value == null ? "" : String(value);
};

const allCalls = (c: GraderContext): ObservedCall[] => c.observation.parentCalls;

function toolNames(calls: ObservedCall[]): string {
  return calls.map((call) => call.call.function.name).join(", ") || "(none)";
}

function noParentCallsNamed(o: Observation, names: readonly string[]): boolean {
  return !o.parentCalls.some((call) => names.includes(call.call.function.name));
}

function readsUnder(o: Observation, needle: string): ObservedCall[] {
  return o.parentCalls.filter((call) => {
    const name = call.call.function.name;
    if (name !== "read_file" && name !== "list_dir" && name !== "keyword_search") return false;
    return normalizePath(call.args.path).toLowerCase().includes(needle.toLowerCase());
  });
}

function parentReadPaths(o: Observation): string[] {
  return o.parentCalls
    .filter((call) => ["read_file", "list_dir", "keyword_search"].includes(call.call.function.name))
    .map((call) => normalizePath(call.args.path));
}

function hasReadBefore(o: Observation, needle: string, boundary: ObservedCall | undefined): boolean {
  const lower = needle.toLowerCase();
  return o.parentCalls.some((call) => {
    if (boundary && !after(boundary, call)) return false;
    if (!["read_file", "list_dir", "keyword_search"].includes(call.call.function.name)) return false;
    return normalizePath(call.args.path).toLowerCase().includes(lower);
  });
}

function lastOf(calls: ObservedCall[]): ObservedCall | undefined {
  return calls[calls.length - 1];
}

// ---------------------------------------------------------------------------
// no-list
// ---------------------------------------------------------------------------

const mt01: Grader = ({ observation: o, case: c }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  add(checks, "subagent:one", "exactly one subagent call", subs.length === 1, `${subs.length} calls`);
  const sub = subs[0];
  if (sub) {
    add(checks, "subagent:worker", "subagent_type is worker", sub.args.subagent_type === "worker", String(sub.args.subagent_type));
    add(checks, "subagent:deferred", "delivery is deferred", isDeferred(sub), String(sub.args.delivery ?? "joined"));
    add(
      checks,
      "subagent:dir",
      "output_dir is docs/match-notes",
      normalizePath(sub.args.output_dir) === "docs/match-notes",
      String(sub.args.output_dir),
    );
    const text = taskText(sub);
    const files = Array.from({ length: 8 }, (_, index) => `${String(index + 1).padStart(2, "0")}.md`);
    const missingFiles = files.filter((file) => !text.includes(file));
    add(checks, "task:filenames", "task names 01.md through 08.md", missingFiles.length === 0, `missing ${missingFiles.join(", ")}`);
    const scorers = ["阿利松", "杰克逊", "布鲁诺", "蒂勒曼斯", "麦金", "格雷茨卡", "齐尔克泽", "多尔古"];
    const missingScorers = scorers.filter((name) => !text.includes(name));
    add(checks, "task:data", "task carries the eight goal rows", missingScorers.length === 0, `missing ${missingScorers.join(", ")}`);
    add(
      checks,
      "task:format",
      "task says three lines: time, score, scorer",
      text.includes("三行") && text.includes("时间") && text.includes("比分") && text.includes("进球者"),
    );
    add(checks, "task:specific", "task is not a vague 'organize what you find'", hasNoVagueTask(sub), text.slice(0, 200));
    const tail = o.parentCalls.slice(o.parentCalls.indexOf(sub) + 1);
    add(checks, "turn:no-tools-after", "no tool call after the deferred subagent", tail.length === 0, toolNames(tail));
    add(
      checks,
      "turn:accepted",
      "the deferred call returned an acceptance, not a refusal",
      resultAccepted(sub),
      resultOf(sub).content.slice(0, 240),
    );
  }
  add(
    checks,
    "parent:no-task-tools",
    "parent does not call task_create or claim_task",
    noParentCallsNamed(o,["task_create", "claim_task"]),
  );
  add(
    checks,
    "parent:no-writes",
    "parent does not write the files itself",
    writesByParent(o).length === 0,
    toolNames(writesByParent(o)),
  );
  add(
    checks,
    "parent:no-read-output",
    "parent does not read docs/match-notes",
    readsUnder(o,"docs/match-notes").length === 0,
  );
  checkExpectedTasks(o, c.tasks_after_parent_turn, "after-turn", checks);
  return { checks };
};

const mt02: Grader = ({ observation: o, case: c }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const calls = parentCallsInFirstBatch(o);
  add(checks, "calls:one", "the first response calls exactly one tool", calls.length === 1, toolNames(calls));
  const read = calls[0];
  add(checks, "read:tool", "it is read_file", read?.call.function.name === "read_file", read?.call.function.name);
  add(
    checks,
    "read:path",
    "path is src/app.ts",
    normalizePath(read?.args.path) === "src/app.ts",
    String(read?.args.path ?? ""),
  );
  add(
    checks,
    "no:delegation",
    "no subagent, task_create, or powershell",
    noParentCallsNamed(o,["subagent", "task_create", "powershell", "bash"]),
    toolNames(o.parentCalls),
  );
  checkExpectedTasks(o, c.tasks_after_parent_turn, "after-turn", checks);
  return { checks };
};

const mt03: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const calls = parentCallsInFirstBatch(o);
  add(checks, "calls:one", "the first response calls exactly one tool", calls.length === 1, toolNames(calls));
  const edit = calls[0];
  add(checks, "edit:tool", "it is str_replace", edit?.call.function.name === "str_replace", edit?.call.function.name);
  add(
    checks,
    "edit:path",
    "path is src/app.ts",
    normalizePath(edit?.args.path) === "src/app.ts",
    String(edit?.args.path ?? ""),
  );
  add(
    checks,
    "edit:old",
    "old text carries 1.06",
    textArg(edit?.args ?? {}, "old_string").includes("1.06"),
    textArg(edit?.args ?? {}, "old_string").slice(0, 120),
  );
  add(
    checks,
    "edit:new",
    "new text carries 1.03",
    textArg(edit?.args ?? {}, "new_string").includes("1.03"),
    textArg(edit?.args ?? {}, "new_string").slice(0, 120),
  );
  add(
    checks,
    "no:delegation-or-rewrite",
    "no subagent, task_create, or whole-file write_file",
    noParentCallsNamed(o,["subagent", "task_create", "write_file"]),
    toolNames(o.parentCalls),
  );
  return { checks };
};

const mt04: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const first = parentCallsInFirstBatch(o);
  const subs = subagents(o);
  add(checks, "subagent:two", "the first response has exactly two subagent calls", subs.length === 2, `${subs.length}`);
  add(checks, "calls:only-subagents", "the first response contains only those subagent calls", first.length === 2, toolNames(first));
  if (subs.length === 2) {
    checkParallelBatch(o, subs, checks);
    add(checks, "subagent:explore", "both are explore", subs.every((call) => call.args.subagent_type === "explore"));
    add(checks, "subagent:joined", "both use joined (or omit delivery)", subs.every(isJoined));
    add(checks, "subagent:no-dir", "neither passes output_dir", subs.every((call) => !call.args.output_dir));
    const auth = subs.find((call) => taskText(call).includes("src/auth"));
    const billing = subs.find((call) => taskText(call).includes("src/billing"));
    add(checks, "task:anchors", "one task anchors src/auth and the other src/billing", Boolean(auth && billing));
    const wellFormed = (call: ObservedCall): boolean => {
      const text = taskText(call);
      return (
        /行号|line\s*numbers?/i.test(text) &&
        /文件|路径|file|path/i.test(text) &&
        /不要改|不要修改|只读|do not (edit|modify|change)|read[- ]only/i.test(text)
      );
    };
    add(
      checks,
      "task:done-condition",
      "each task asks for paths and line numbers and forbids edits",
      Boolean(auth && billing && wellFormed(auth) && wellFormed(billing)),
      [auth, billing].filter(Boolean).map((call) => taskText(call!).slice(0, 200)).join(" || "),
    );
    add(
      checks,
      "task:separate",
      "the two directories are not put into one subagent task",
      Boolean(auth && billing && !taskText(auth).includes("src/billing") && !taskText(billing).includes("src/auth")),
    );
  }
  const contentReads = o.parentCalls.filter((call) =>
    ["read_file", "keyword_search"].includes(call.call.function.name),
  );
  add(
    checks,
    "no:other-tools",
    "no task_create, worker, deferred, or pre-reading the two directories",
    noParentCallsNamed(o,["task_create"]) &&
      subs.every((call) => call.args.subagent_type !== "worker" && !isDeferred(call)) &&
      contentReads.length === 0,
    `calls: ${toolNames(o.parentCalls)}; content reads: ${contentReads.map((call) => normalizePath(call.args.path)).join(", ")}`,
  );
  return { checks };
};

const mt05: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  add(checks, "subagent:two", "exactly two subagent calls", subs.length === 2, `${subs.length}`);
  if (subs.length === 2) {
    // The case requires one response for both calls, not necessarily the first.
    add(
      checks,
      "parallel:one-response",
      "both subagent calls are in one assistant response",
      new Set(subs.map((call) => call.batch)).size === 1,
      `batches: ${subs.map((call) => call.batch).join(", ")}`,
    );
    add(checks, "subagent:worker", "both are worker", subs.every((call) => call.args.subagent_type === "worker"));
    add(checks, "subagent:deferred", "both are deferred", subs.every(isDeferred));
    const dirs = subs.map((call) => normalizePath(call.args.output_dir));
    add(
      checks,
      "subagent:dirs",
      "output_dir values are docs/api and docs/cli",
      dirs.length === 2 && new Set(dirs).size === 2 && dirs.every((dir) => dir === "docs/api" || dir === "docs/cli"),
      dirs.join(", "),
    );
    add(
      checks,
      "subagent:dirs-not-overlap",
      "the two output_dir values do not contain one another",
      dirs.length === 2 && !dirs.some((dir) => dirs.some((other) => other !== dir && (dir.startsWith(`${other}/`) || other.startsWith(`${dir}/`)))),
      dirs.join(", "),
    );
    add(
      checks,
      "task:file-and-boundary",
      "each task names overview.md and says not to write in the other directory",
      subs.every(
        (call) =>
          taskText(call).includes("overview.md") &&
          /不要写(到)?别的目录|不要写其他目录|只在[^。\n]{0,40}(目录|文件夹)|不(要|得)写(到)?(对方|其他)的?目录|(不要|不得|别|勿)[^。\n]{0,10}(读|改|写|动|碰)[^。\n]{0,20}(目录|docs\/)/.test(
            taskText(call),
          ),
      ),
      subs.map(taskText).join(" || ").slice(0, 300),
    );
    add(
      checks,
      "turn:accepted",
      "both deferred calls were accepted",
      subs.every(resultAccepted),
      subs.map((call) => resultOf(call).content.slice(0, 120)).join(" || "),
    );
  }
  add(
    checks,
    "no:task-create",
    "parent does not create tasks",
    noParentCallsNamed(o,["task_create"]),
  );
  return {
    checks,
    notes: [
      "cases.json mt-05 must_not lists docs/api as a forbidden output_dir while must requires it. The grader treats docs/api and docs/cli as the two required, non-overlapping directories.",
    ],
  };
};

// ---------------------------------------------------------------------------
// dependent
// ---------------------------------------------------------------------------

const mt06: Grader = ({ observation: o, case: c }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const calls = o.parentCalls;
  // The case says three task_create calls in a row before any work is done.
  // Reading the workspace first is allowed: "动手" starts at a claim, a write,
  // a command, or a subagent.
  const creates = calls.filter((call) => call.call.function.name === "task_create");
  const createBatch = creates[0]?.batch;
  const batchCreates = calls.filter((call) => call.batch === createBatch);
  const workIndex = calls.findIndex((call) =>
    ["claim_task", "write_file", "str_replace", "delete_file", "powershell", "bash", "subagent"].includes(
      call.call.function.name,
    ),
  );
  add(
    checks,
    "tasks:three-first",
    "the first three task_create calls share one response and come before any work",
    batchCreates.length === 3 &&
      batchCreates.every((call) => call.call.function.name === "task_create") &&
      workIndex >= 0 &&
      calls[workIndex]!.batch > createBatch!,
    `creates: ${toolNames(batchCreates)}; first work: ${workIndex >= 0 ? calls[workIndex]!.call.function.name : "none"}`,
  );
  const created = creates.slice(0, 3).map((call, index) => resultOf(call).content.includes(`#${index + 1}`));
  add(checks, "tasks:ids", "the three creates return ids 1, 2, 3", created.length === 3 && created.every(Boolean), creates.slice(0, 3).map((call) => resultOf(call).content.slice(0, 80)).join(" || "));
  const task1 = o.tasks.find((task) => task.id === "1");
  const task2 = o.tasks.find((task) => task.id === "2");
  const task3 = o.tasks.find((task) => task.id === "3");
  add(checks, "tasks:deps", "task 2 is blocked by #1 and task 3 by #2", Boolean(task2?.blockedBy.includes("1") && task3?.blockedBy.includes("2")), JSON.stringify({ two: task2?.blockedBy, three: task3?.blockedBy }));

  const dispatch1 = subagents(o).find((call) => taskIdOf(call) === "1");
  const dispatch2 = subagents(o).find((call) => taskIdOf(call) === "2");
  if (dispatch1) {
    add(checks, "explore:type", "the #1 subagent is explore", dispatch1.args.subagent_type === "explore", String(dispatch1.args.subagent_type));
    add(checks, "explore:joined", "the #1 subagent is joined", isJoined(dispatch1), String(dispatch1.args.delivery ?? "joined"));
    add(checks, "explore:no-dir", "the #1 subagent has no output_dir", !dispatch1.args.output_dir, String(dispatch1.args.output_dir ?? ""));
    const claimsBefore = calls
      .slice(0, calls.indexOf(dispatch1))
      .filter((call) => call.call.function.name === "claim_task" && taskIdOf(call) === "1");
    add(checks, "explore:not-preclaimed", "parent did not claim #1 before delegating it", claimsBefore.length === 0);
    add(
      checks,
      "explore:task",
      "the explore task asks for file and line numbers, not edits",
      taskText(dispatch1).includes("行号") &&
        /文件|路径/.test(taskText(dispatch1)) &&
        /不要改|不要修改|只读|不要(给出|提供|输出|写)[^。\n]{0,8}(代码|实现|改造)|只(描述|报告|查清)/.test(
          taskText(dispatch1),
        ),
      taskText(dispatch1).slice(0, 240),
    );
    add(checks, "explore:receipt", "the explore receipt came back", Boolean(dispatch1.result) && !resultOf(dispatch1).isError, resultOf(dispatch1).content.slice(0, 200));
  } else {
    add(checks, "explore:type", "a subagent is dispatched for task #1", false, "none");
  }

  if (dispatch2) {
    add(checks, "worker:type", "the #2 subagent is worker", dispatch2.args.subagent_type === "worker", String(dispatch2.args.subagent_type));
    add(checks, "worker:joined", "the #2 subagent is joined", isJoined(dispatch2), String(dispatch2.args.delivery ?? "joined"));
    add(checks, "worker:task-id", "the #2 subagent carries task_id 2", taskIdOf(dispatch2) === "2");
    add(
      checks,
      "worker:dir",
      "the #2 subagent uses output_dir src",
      normalizePath(dispatch2.args.output_dir) === "src",
      String(dispatch2.args.output_dir ?? ""),
    );
    add(
      checks,
      "worker:one-file",
      "the worker task limits writes to src/pay.ts",
      taskText(dispatch2).includes("src/pay.ts") && /只|不要动|不要改|其他文件/.test(taskText(dispatch2)),
      taskText(dispatch2).slice(0, 240),
    );
    add(
      checks,
      "worker:concrete-fix",
      "the worker task states the concrete fix, not 'decide after reading'",
      taskText(dispatch2).includes("分") && /整数|cru?cents|以分/.test(taskText(dispatch2)) && hasNoVagueTask(dispatch2),
      taskText(dispatch2).slice(0, 240),
    );
    add(
      checks,
      "dependent:after-receipt",
      "the #2 subagent starts in a later response than the #1 receipt",
      Boolean(dispatch1) && dispatch2.batch > dispatch1!.batch,
      `batches ${dispatch1?.batch} -> ${dispatch2.batch}`,
    );
  } else {
    add(checks, "worker:type", "a subagent is dispatched for task #2", false, "none");
  }

  const claim3 = calls.find(
    (call) => call.call.function.name === "claim_task" && taskIdOf(call) === "3",
  );
  const test = calls.find(
    (call) =>
      (call.call.function.name === "powershell" || call.call.function.name === "bash") &&
      String(call.args.command ?? "").toLowerCase().includes("npm test"),
  );
  const complete3 = calls.find(
    (call) => call.call.function.name === "complete_task" && taskIdOf(call) === "3",
  );
  add(checks, "final:claim", "parent claims task #3", Boolean(claim3));
  add(checks, "final:test", "parent runs npm test itself", Boolean(test), String(test?.args.command ?? ""));
  add(checks, "final:complete", "parent completes task #3", Boolean(complete3));
  add(
    checks,
    "final:order",
    "claim #3, then npm test, then complete #3",
    Boolean(claim3 && test && complete3 && after(test!, claim3!) && after(complete3!, test!)),
    `batches claim=${claim3?.batch ?? "none"} test=${test?.batch ?? "none"} complete=${complete3?.batch ?? "none"}`,
  );
  add(
    checks,
    "no:delegated-test",
    "no subagent task tells the subagent to run npm test",
    subagentTaskTexts(o).every((text) => !runTestInstruction(text)),
    subagentTaskTexts(o)
      .map((text) => runTestInstruction(text))
      .filter(Boolean)
      .join(" || ")
      .slice(0, 400),
  );
  add(
    checks,
    "no:parent-preclaim",
    "parent does not claim #1 or #2 itself",
    !calls.some(
      (call) =>
        call.call.function.name === "claim_task" && ["1", "2"].includes(taskIdOf(call)),
    ),
  );
  add(checks, "no:child-task-mutations", "subagents do not create, update, or delete tasks", noChildTaskMutations(o));
  checkExpectedTasks(o, c.tasks_when_done, "done", checks);
  return { checks };
};

const mt07: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  const workers = subs.filter((call) => call.args.subagent_type === "worker");
  const deleg = workers[0];
  const edit = o.parentCalls.find(
    (call) =>
      ["str_replace", "write_file"].includes(call.call.function.name) &&
      normalizePath(call.args.path) === "src/pay.ts",
  );
  const test = o.parentCalls.find(
    (call) =>
      (call.call.function.name === "powershell" || call.call.function.name === "bash") &&
      String(call.args.command ?? "").toLowerCase().includes("npm test"),
  );

  const boundary = deleg ?? edit;
  const testAfterAction =
    boundary &&
    o.parentCalls.some(
      (call) =>
        (call.call.function.name === "powershell" || call.call.function.name === "bash") &&
        String(call.args.command ?? "").toLowerCase().includes("npm test") &&
        after(call, boundary),
    );
  add(checks, "read:test", "parent reads the failing test before delegating or editing", hasReadBefore(o, "test/pay.test.js", boundary), parentReadPaths(o).join(", "));
  add(checks, "read:source", "parent reads src/pay.ts before delegating or editing", hasReadBefore(o, "src/pay.ts", boundary), parentReadPaths(o).join(", "));
  add(checks, "action:delegate-or-edit", "parent either delegates a worker or edits src/pay.ts itself", Boolean(deleg || edit), `subagents: ${toolNames(subs)}; edit: ${edit ? "yes" : "no"}`);

  if (deleg) {
    const text = taskText(deleg);
    add(checks, "worker:fault", "worker task names the fault", /失败|报错|错误|throw|Error|expected integer cents/.test(text), text.slice(0, 200));
    add(checks, "worker:desired", "worker task names the desired change", /分|整数|cents/.test(text), text.slice(0, 200));
    add(checks, "worker:done", "worker task says how the fix is checked", /npm test|测试|完成标准|通过/.test(text), text.slice(0, 200));
    add(checks, "worker:specific", "worker task is not 'use what you find'", hasNoVagueTask(deleg), text.slice(0, 200));
    add(checks, "worker:after-reads", "the worker is started after a read", o.parentCalls.indexOf(deleg) > 0);
  } else {
    add(checks, "worker:fault", "a fix is delegated or made", Boolean(edit));
    add(checks, "worker:desired", "the change targets the amount", Boolean(edit));
    add(checks, "worker:done", "the parent will run the test", Boolean(test));
    add(checks, "worker:specific", "no vague delegation is used", subs.length === 0);
    add(checks, "worker:after-reads", "the edit happens after the reads", Boolean(edit) && hasReadBefore(o, "test/pay.test.js", edit) && hasReadBefore(o, "src/pay.ts", edit));
  }

  add(checks, "test:parent-run", "parent runs npm test itself", Boolean(test), String(test?.args.command ?? ""));
  add(
    checks,
    "test:after-action",
    "npm test runs after the receipt/edit",
    Boolean(testAfterAction),
  );
  add(
    checks,
    "no:delegated-test",
    "no subagent is told to run npm test",
    subagentTaskTexts(o).every((text) => !/npm test|运行测试|执行测试/i.test(text)),
  );
  return { checks };
};

const mt08: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  const finalText = o.parentText;
  const task1 = taskStatus(o, "1");
  const task2 = taskStatus(o, "2");

  add(checks, "no:claim-2", "parent does not claim #2", !o.parentCalls.some((call) => call.call.function.name === "claim_task" && taskIdOf(call) === "2"));

  if (subs.length === 0) {
    add(
      checks,
      "outcome:blocked-explained",
      "without a subagent, the reply explains that #2 is still blocked by #1",
      finalText.includes("#2") && finalText.includes("#1") && /挡住|阻塞|依赖|blocked/i.test(finalText),
      finalText.slice(-300),
    );
    add(checks, "outcome:no-dispatch", "no subagent is started", true);
    add(checks, "task2:pending", "#2 stays pending without an owner", task2 === "pending" && taskOwner(o, "2") === "", `status=${task2} owner=${taskOwner(o, "2")}`);
  } else {
    add(
      checks,
      "outcome:task-id",
      "every subagent carries task_id 1 or 2",
      subs.every((call) => ["1", "2"].includes(taskIdOf(call))),
      subs.map((call) => taskIdOf(call) || "(none)").join(", "),
    );
    const subs2 = subs.filter((call) => taskIdOf(call) === "2");
    const allRejected = subs2.length > 0 && subs2.every((call) => resultOf(call).isError);
    if (subs2.length === 0) {
      // #1 was delegated instead of done in the parent; #2 waits.
      add(
        checks,
        "outcome:blocked-explained",
        "without a #2 dispatch, the reply explains that #2 is still blocked by #1",
        finalText.includes("#2") && finalText.includes("#1") && /挡住|阻塞|依赖|blocked/i.test(finalText),
        finalText.slice(-300),
      );
      add(checks, "task1:completed", "#1 is completed first", task1 === "completed", task1);
      add(checks, "task2:pending", "#2 stays pending without an owner", task2 === "pending" && taskOwner(o, "2") === "", `status=${task2} owner=${taskOwner(o, "2")}`);
    } else if (allRejected) {
      add(
        checks,
        "outcome:rejected",
        "the runtime rejects the blocked task and does not start the subagent",
        /#1|blocked|阻塞/i.test(resultOf(subs[0]!).content),
        subs.map((call) => resultOf(call).content).join(" || ").slice(0, 300),
      );
      add(checks, "no:child-start", "no subagent directory is created", o.subagentDirs.length === 0, o.subagentDirs.join(", "));
      add(checks, "no:child-tools", "no subagent tool call runs", o.subagentCalls.length === 0, `${o.subagentCalls.length} calls`);
      add(checks, "task2:pending", "#2 stays pending without an owner", task2 === "pending" && taskOwner(o, "2") === "", `status=${task2} owner=${taskOwner(o, "2")}`);
    } else {
      // #2 may be unblocked by the parent or by a worker that completed #1.
      const complete1Parent = o.parentCalls.find(
        (call) => call.call.function.name === "complete_task" && taskIdOf(call) === "1",
      );
      const complete1Child = o.subagentCalls.find(
        (call) => call.call.function.name === "complete_task" && taskIdOf(call) === "1",
      );
      const complete1At = complete1Parent?.eventIndex ?? complete1Child?.eventIndex;
      const accepted2 = subs2.find((call) => !resultOf(call).isError);
      add(
        checks,
        "path:unblocked-first",
        "#1 is completed before the accepted #2 subagent starts",
        Boolean(accepted2 && complete1At !== undefined && accepted2.eventIndex > complete1At),
        `#1=${task1}; complete #1 event ${complete1At ?? "none"}; dispatch event ${accepted2?.eventIndex ?? "none"}`,
      );
      add(checks, "task1:completed", "#1 is completed before delegating #2", task1 === "completed", task1);
      add(
        checks,
        "path:started",
        "the #2 subagent is accepted once #1 is done",
        Boolean(accepted2),
      );
    }
  }
  return { checks };
};

// ---------------------------------------------------------------------------
// failure / state
// ---------------------------------------------------------------------------

const mt09: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const claim = o.parentCalls.find((call) => call.call.function.name === "claim_task");
  const sub = subagents(o)[0];
  add(checks, "claim:ok", "claim_task succeeds", Boolean(claim) && !resultOf(claim!).isError, claim ? resultOf(claim).content : "no claim");
  add(checks, "claim:content", "the claim result names #1", Boolean(claim) && resultOf(claim!).content.includes("#1"), claim ? resultOf(claim).content.slice(0, 160) : "");
  add(checks, "task:in-progress", "#1 is in_progress owned by main", taskStatus(o, "1") === "in_progress" && taskOwner(o, "1") === "main", `status=${taskStatus(o, "1")} owner=${taskOwner(o, "1")}`);
  add(checks, "subagent:call", "the parent still calls subagent for task #1", Boolean(sub) && taskIdOf(sub!) === "1", sub ? `task_id=${taskIdOf(sub)}` : "none");
  add(
    checks,
    "subagent:rejected",
    "the subagent does not start and its result says the task is already owned",
    Boolean(sub) && resultOf(sub!).isError && /#1|owned|in_progress|not pending/i.test(resultOf(sub!).content),
    sub ? resultOf(sub).content.slice(0, 240) : "none",
  );
  add(checks, "no:child-dir", "no subagent directory is created", o.subagentDirs.length === 0, o.subagentDirs.join(", "));
  add(checks, "no:child-tools", "no subagent tool call runs", o.subagentCalls.length === 0);
  add(checks, "no:release", "docs/release is not created by the failed call", !Object.keys(o.files).some((path) => path.toLowerCase().startsWith("docs/release")), Object.keys(o.files).join(", "));
  add(checks, "task:unchanged-owner", "#1 is still in_progress owned by main", taskStatus(o, "1") === "in_progress" && taskOwner(o, "1") === "main");
  return { checks };
};

const mt10: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const sub = subagents(o)[0];
  add(checks, "subagent:one", "exactly one joined worker for task #1", Boolean(sub) && sub.args.subagent_type === "worker" && isJoined(sub) && taskIdOf(sub!) === "1", sub ? `${sub.args.subagent_type} task_id=${taskIdOf(sub)}` : "none");
  const child = o.exchanges.find((exchange) => exchange.kind === "subagent");
  const claimedLine = child?.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .find((content) => content.includes("Task #1 is already claimed as you"));
  add(checks, "child:claimed-as-id", "before the run, #1 is claimed as the subagent id", Boolean(claimedLine), claimedLine?.slice(0, 200));
  add(checks, "file:written", "notes/a.md is written", hasFile(o, "notes/a.md") && fileContent(o, "notes/a.md").includes("done"), Object.keys(o.files).join(", "));
  add(checks, "task:released", "#1 returns to pending without an owner after the run", taskStatus(o, "1") === "pending" && taskOwner(o, "1") === "", `status=${taskStatus(o, "1")} owner=${taskOwner(o, "1")}`);
  add(
    checks,
    "receipt:release",
    "the receipt says the claim was released because complete_task was not called",
    Boolean(sub) && /Released back to pending/.test(resultOf(sub!).content) && /complete_task was not called/.test(resultOf(sub!).content),
    sub ? resultOf(sub).content.slice(0, 300) : "none",
  );
  add(
    checks,
    "reply:no-false-done",
    "the reply does not call the task complete",
    !/任务\s*(?:#1\s*)?已完成|#1\s*(?:已|is)\s*(?:完成|complete)/i.test(o.parentText),
    o.parentText.slice(-300),
  );
  return { checks };
};

const mt11: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  add(checks, "subagent:one", "exactly one worker", subs.length === 1 && subs[0]!.args.subagent_type === "worker", `${subs.length}`);
  const sub = subs[0];
  if (sub) {
    add(checks, "subagent:deferred", "delivery is deferred", isDeferred(sub));
    add(checks, "subagent:dir", "output_dir is docs/manual", normalizePath(sub.args.output_dir) === "docs/manual", String(sub.args.output_dir));
    add(checks, "subagent:accepted", "the call returns an acceptance", resultAccepted(sub), resultOf(sub).content.slice(0, 200));
  }
  add(checks, "no:task-create", "parent does not create tasks", noParentCallsNamed(o,["task_create"]));
  add(checks, "no:parent-writes", "parent does not write into docs/manual", writesByParent(o, "docs/manual").length === 0, toolNames(writesByParent(o, "docs/manual")));
  add(checks, "no:new-files", "no file under docs/manual exists yet", !Object.keys(o.files).some((path) => path.toLowerCase().startsWith("docs/manual")), Object.keys(o.files).join(", "));
  add(checks, "reply:mentions-old", "the reply counts docs/old.md as present now", o.parentText.includes("old.md"), o.parentText.slice(-300));
  const counts = [...o.parentText.matchAll(/(\d+)\s*(?:个|份)?\s*(?:\.?md|markdown)/gi)].map((match) => match[1]);
  add(checks, "reply:count-is-one", "every md count in the reply is 1", counts.length > 0 && counts.every((value) => value === "1"), counts.join(", ") || "no count found");
  add(
    checks,
    "reply:no-false-claim",
    "the reply does not claim the new manual is already written",
    !/(manual|手册)[^\n。]{0,24}(已写|写好了|已经写好|created|written)/i.test(o.parentText) &&
      !o.parentText.includes("Accepted subagent"),
    o.parentText.slice(-300),
  );
  return { checks };
};

const mt12: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  const worker = subs.find((call) => call.args.subagent_type === "worker" && taskIdOf(call) === "2");
  const edit = o.parentCalls.find(
    (call) =>
      ["str_replace", "write_file"].includes(call.call.function.name) &&
      normalizePath(call.args.path) === "src/auth/token.ts",
  );
  add(checks, "continue:action", "the parent continues #2 with a worker or its own edit", Boolean(worker || edit), `subagents: ${toolNames(subs)}; edit: ${edit ? "yes" : "no"}`);
  if (worker) {
    add(checks, "worker:dir", "output_dir is under src/auth", normalizePath(worker.args.output_dir) === "src/auth" || normalizePath(worker.args.output_dir).startsWith("src/auth/"), String(worker.args.output_dir));
    add(checks, "worker:joined", "delivery is joined", isJoined(worker), String(worker.args.delivery ?? "joined"));
    add(
      checks,
      "worker:empty-token",
      "the task targets empty tokens instead of re-investigating",
      /空|empty/i.test(taskText(worker)) && /改|修复|校验|length|trim|长度/.test(taskText(worker)),
      taskText(worker).slice(0, 240),
    );
  }
  if (edit) {
    const newText = `${textArg(edit.args, "new_string")}\n${textArg(edit.args, "content")}`;
    add(
      checks,
      "edit:empty-token",
      "the edit rejects empty tokens",
      /empty|trim|length\s*>\s*0|length\s*>=\s*[1-9]\d*|length\s*>\s*[1-9]\d*|=== 0|!== 0|>\s*0|!\s*token|token\s*===?\s*""|token\.length\s*!==?\s*0/.test(newText),
      newText.slice(0, 200),
    );
  }
  add(checks, "no:ask-user", "parent does not ask whether to continue", noParentCallsNamed(o,["ask_user"]));
  add(checks, "no:duplicate-investigation", "parent does not create a duplicate investigation task", noParentCallsNamed(o,["task_create"]));
  add(checks, "no:explore", "no re-investigation subagent is dispatched", subs.every((call) => call.args.subagent_type !== "explore"), toolNames(subs));
  return { checks };
};

const mt13: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const create = childCallsNamed(o, "task_create")[0];
  const write = childCallsNamed(o, "write_file")[0];
  const complete = childCallsNamed(o, "complete_task")[0];
  add(checks, "child:task-create", "the child calls task_create", Boolean(create));
  add(
    checks,
    "child:task-create-rejected",
    "task_create returns an error",
    Boolean(create && resultOf(create!).isError),
    create ? resultOf(create).content.slice(0, 200) : "none",
  );
  add(checks, "child:write", "the child writes docs/one/page.md", Boolean(write) && normalizePath(write!.args.path) === "docs/one/page.md", write ? String(write.args.path) : "none");
  add(checks, "child:write-ok", "write_file succeeds", Boolean(write) && !resultOf(write!).isError, write ? resultOf(write).content.slice(0, 160) : "none");
  add(checks, "file:page", "docs/one/page.md exists with the expected content", hasFile(o, "docs/one/page.md") && fileContent(o, "docs/one/page.md").includes("only"), Object.keys(o.files).join(", "));
  add(checks, "child:complete", "the child calls complete_task", Boolean(complete));
  add(checks, "child:complete-ok", "complete_task succeeds", Boolean(complete) && !resultOf(complete!).isError, complete ? resultOf(complete).content.slice(0, 200) : "none");
  add(checks, "tasks:only-one", "the list still has only #1", o.tasks.length === 1 && o.tasks[0]!.id === "1", o.tasks.map((task) => `#${task.id}`).join(", "));
  add(
    checks,
    "task:completed",
    "#1 is completed, owned by subagent_self",
    taskStatus(o, "1") === "completed" && taskOwner(o, "1") === "subagent_self",
    `status=${taskStatus(o, "1")} owner=${taskOwner(o, "1")}`,
  );
  add(checks, "no:task-2-file", "no tasks/2.json is created", !o.tasks.some((task) => task.id === "2"));
  return { checks };
};

// ---------------------------------------------------------------------------
// parallel / dependent model cases
// ---------------------------------------------------------------------------

const mt14: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  add(checks, "subagent:one", "exactly one worker", subs.length === 1 && subs[0]!.args.subagent_type === "worker", `${subs.length}`);
  const sub = subs[0];
  if (sub) {
    add(checks, "subagent:deferred", "delivery is deferred", isDeferred(sub));
    add(checks, "subagent:dir", "output_dir is docs/chapters", normalizePath(sub.args.output_dir) === "docs/chapters", String(sub.args.output_dir));
    const text = taskText(sub);
    add(checks, "task:files", "task names 01.md, 02.md, and 03.md", ["01.md", "02.md", "03.md"].every((file) => text.includes(file)));
    add(checks, "task:titles", "task names 引言, 方法, and 结果", ["引言", "方法", "结果"].every((title) => text.includes(title)), text.slice(0, 240));
  }
  add(checks, "no:multiple-workers", "the same directory is not split across several workers", subs.length === 1);
  add(checks, "no:task-create", "parent does not create three tasks", noParentCallsNamed(o,["task_create"]));
  add(checks, "no:parent-writes", "parent does not write the three files itself", writesByParent(o, "docs/chapters").length === 0, toolNames(writesByParent(o)));
  return { checks };
};

const mt15: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const first = o.parentCalls[0];
  add(
    checks,
    "parent:test-first",
    "the first tool call is powershell running npm test",
    Boolean(first) && first!.call.function.name === "powershell" && String(first!.args.command ?? "").toLowerCase().includes("npm test"),
    first ? `${first.call.function.name}: ${String(first.args.command ?? "")}` : "none",
  );
  const testResult = first ? resultOf(first) : { content: "", isError: false };
  add(checks, "parent:test-ran", "the test command actually ran and returned output", Boolean(first?.result) && (testResult.content.length > 0), testResult.content.slice(0, 200));
  const subs = subagents(o);
  if (subs.length > 0) {
    const sub = subs[0]!;
    add(checks, "subagent:one-explore", "at most one subagent, and it is explore", subs.length === 1 && sub.args.subagent_type === "explore", `${subs.length}: ${sub.args.subagent_type}`);
    add(checks, "subagent:joined", "delivery is joined", isJoined(sub), String(sub.args.delivery ?? "joined"));
    add(checks, "subagent:after-test", "the subagent starts only after the test result", Boolean(first) && after(sub, first!), `batches ${first?.batch} -> ${sub.batch}`);
    const text = taskText(sub);
    add(checks, "task:failure-summary", "task carries the failure summary the parent already has", /失败|报错|error|cannot find|module_not_found|test\.js/i.test(text), text.slice(0, 240));
    add(checks, "task:paths", "task names the relevant paths", /test\.js|package\.json|src\//.test(text), text.slice(0, 240));
    add(checks, "task:no-edit", "task says not to edit files", /不要改|不要修改|只读/.test(text), text.slice(0, 240));
    add(checks, "no:run-test-in-task", "the task does not tell the subagent to run the test", !runTestInstruction(text), runTestInstruction(text) ?? text.slice(0, 240));
  } else {
    add(checks, "subagent:one-explore", "no subagent is used when the test passes or the parent reports the failure", true);
    add(checks, "subagent:joined", "no subagent delivery to check", true);
    add(checks, "subagent:after-test", "no subagent started before the test", true);
    add(checks, "task:failure-summary", "no subagent task to check", true);
    add(checks, "task:paths", "no subagent task to check", true);
    add(checks, "task:no-edit", "no subagent task to check", true);
    add(checks, "no:run-test-in-task", "no subagent task to check", true);
  }
  add(checks, "no:worker", "no worker is used", subs.every((call) => call.args.subagent_type !== "worker"), toolNames(subs));
  return { checks };
};

const mt16: Grader = ({ observation: o }) => {
  const checks: Check[] = [];
  baseChecks(o, checks);
  const subs = subagents(o);
  add(checks, "subagent:two", "two worker calls", subs.length === 2, `${subs.length}`);
  const [first, second] = subs;
  if (first) {
    add(checks, "first:deferred", "the first is deferred", isDeferred(first));
    add(checks, "first:dir", "the first writes docs/manual", normalizePath(first.args.output_dir) === "docs/manual", String(first.args.output_dir));
    add(checks, "first:accepted", "the first returns an acceptance", resultAccepted(first), resultOf(first).content.slice(0, 200));
  }
  if (second) {
    add(checks, "second:deferred", "the second is deferred", isDeferred(second));
    add(checks, "second:dir", "the second writes docs/manual/appendix", normalizePath(second.args.output_dir) === "docs/manual/appendix", String(second.args.output_dir));
    add(
      checks,
      "second:rejected",
      "the second is rejected because its output_dir overlaps the locked docs/manual",
      resultOf(second).isError && /overlap/i.test(resultOf(second).content) && /docs\/manual/i.test(resultOf(second).content),
      resultOf(second).content.slice(0, 300),
    );
    add(checks, "second:after-first", "the second call comes after the first", Boolean(first) && after(second, first!), `batches ${first?.batch} -> ${second.batch}`);
  }
  add(checks, "no:appendix", "the second subagent did not create docs/manual/appendix", !Object.keys(o.files).some((path) => path.toLowerCase().startsWith("docs/manual/appendix")), Object.keys(o.files).join(", "));
  add(checks, "first:not-cancelled", "the first subagent was not cancelled", !o.inbox.some((entry) => /Cancelled: subagent stopped/.test(entry.content)), o.inbox.map((entry) => entry.content.slice(0, 120)).join(" || "));
  return { checks };
};

const GRADERS: Record<string, Grader> = {
  "mt-01": mt01,
  "mt-02": mt02,
  "mt-03": mt03,
  "mt-04": mt04,
  "mt-05": mt05,
  "mt-06": mt06,
  "mt-07": mt07,
  "mt-08": mt08,
  "mt-09": mt09,
  "mt-10": mt10,
  "mt-11": mt11,
  "mt-12": mt12,
  "mt-13": mt13,
  "mt-14": mt14,
  "mt-15": mt15,
  "mt-16": mt16,
};

export function graderFor(caseId: string): Grader | undefined {
  return GRADERS[caseId];
}

export function gradeCase(c: GraderContext["case"], observation: GraderContext["observation"]): GraderResult {
  const grader = graderFor(c.id);
  if (!grader) return { checks: [{ id: "missing-grader", description: "a grader exists for this case", passed: false }] };
  return grader({ case: c, observation });
}
