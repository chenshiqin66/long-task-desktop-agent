import assert from "node:assert/strict";
import {
  ageText,
  canUndo,
  groupByType,
  instructionStateText,
  journalText,
  originText,
  plainError,
  savedLineGroups,
  scopeTitle,
  sourceWorkspace,
  stampText,
} from "../dist/src/renderer/memoryView.js";

const note = (over) => ({
  scope: "project",
  name: "n",
  description: "d",
  type: "reference",
  created: "2026-11-01T00:00:00.000Z",
  modified: "2026-11-01T00:00:00.000Z",
  origin: "manual",
  body: "b",
  ...over,
});

// groups follow the context order, newest first, and empty types are left out
const groups = groupByType(
  [
    note({ name: "board" }),
    note({ name: "pnpm", type: "feedback", modified: "2026-11-02T00:00:00.000Z" }),
    note({ name: "older", type: "feedback" }),
    note({ name: "lang", type: "user", scope: "user" }),
  ],
  "project",
);
assert.deepEqual(
  groups.map((group) => [group.label, group.entries.map((entry) => entry.name)]),
  [
    ["反馈", ["pnpm", "older"]],
    ["参考", ["board"]],
  ],
);
assert.equal(scopeTitle("project"), "本项目");
assert.equal(scopeTitle("user"), "所有项目");
assert.equal(originText("extracted"), "自动提取");
assert.equal(originText("edited"), "手改");
assert.equal(originText("manual"), "手写");

// ages count calendar days, so 23:59 last night is 昨天
const now = new Date(2026, 10, 17, 0, 5);
assert.equal(ageText(new Date(2026, 10, 17, 0, 1).toISOString(), now), "今天");
assert.equal(ageText(new Date(2026, 10, 16, 23, 59).toISOString(), now), "昨天");
assert.equal(ageText(new Date(2026, 10, 5, 12).toISOString(), now), "12 天前");
assert.equal(ageText("garbage", now), "日期不明");
assert.equal(stampText(new Date(2026, 10, 17, 9, 5).toISOString()), "2026-11-17 09:05");

assert.equal(instructionStateText({ kind: "missing" }), "未创建");
assert.equal(instructionStateText({ kind: "loaded", chars: 0 }), "空文件");
assert.equal(instructionStateText({ kind: "loaded", chars: 120 }), "已加载 120 字");
assert.equal(instructionStateText({ kind: "truncated", chars: 9000 }), "已截断：共 9000 字，只加载前 8000 字");
assert.equal(instructionStateText({ kind: "skipped", reason: "文件超过 1 MiB" }), "未加载：文件超过 1 MiB");

const row = (over) => ({ id: "memj_1", at: "x", scope: "project", name: "a", op: "create", actor: "extractor", undone: false, ...over });
assert.equal(journalText(row()), "后台新建了 a");
assert.equal(journalText(row({ op: "update", actor: "user" })), "你改了 a");
assert.equal(journalText(row({ op: "delete" })), "后台删除了 a");
assert.equal(journalText(row({ op: "restore", actor: "user" })), "你撤销了 a 的一次变更");
assert.equal(canUndo(row()), true);
assert.equal(canUndo(row({ undone: true })), false);
assert.equal(canUndo(row({ op: "restore" })), false);

// the 已记住 line lists saved notes first, deleted ones after
const item = (name, op) => ({ scope: "project", name, op, journal_id: `memj_${name}` });
assert.deepEqual(
  savedLineGroups([item("a", "create"), item("b", "delete"), item("c", "update")]).map((group) => [
    group.label,
    group.items.map((entry) => entry.name),
  ]),
  [
    ["已记住", ["a", "c"]],
    ["已删除", ["b"]],
  ],
);
assert.deepEqual(savedLineGroups([]), []);

// a source session opens only when its workspace is still in the sidebar
assert.equal(sourceWorkspace({ workspace: "D:/Work/App/" }, ["D:\\x", "D:\\work\\app"]), "D:\\work\\app");
assert.equal(sourceWorkspace({ workspace: "D:\\gone" }, ["D:\\work\\app"]), null);
assert.equal(sourceWorkspace(undefined, ["D:\\work\\app"]), null);

assert.equal(plainError(new Error("Error invoking remote method 'agent:memorySave': Error: 描述超过 150 字")), "描述超过 150 字");
assert.equal(plainError("plain"), "plain");

console.log("memory view ok");
