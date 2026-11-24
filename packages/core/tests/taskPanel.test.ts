import { describe, it, expect } from "vitest";
import { BATCH_GAP_MS, buildTaskPanel, groupTaskBatches, taskProgressLabel } from "../src/store/taskPanel.js";
import type { TaskRecord } from "../src/store/taskStore.js";

function task(over: Partial<TaskRecord> & Pick<TaskRecord, "id" | "status">): TaskRecord {
  return {
    subject: `subject ${over.id}`,
    description: `desc ${over.id}`,
    blocks: [],
    blockedBy: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("task panel", () => {
  it("splits pending into blocked and ready, and flags a finished subagent owner", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed", owner: "main" }),
          task({ id: "2", status: "in_progress", owner: "subagent_abc" }),
          task({ id: "3", status: "in_progress", owner: "main" }),
          task({ id: "4", status: "pending", blockedBy: ["1", "9"] }),
          task({ id: "5", status: "pending", blockedBy: ["2"] }),
          task({ id: "6", status: "pending" }),
        ],
        unreadable: ["7.json"],
      },
      { subagent_abc: "completed" },
    );
    expect(view.rows.map((row) => `${row.group}:${row.id}`)).toEqual([
      "in_progress:2",
      "in_progress:3",
      "blocked:4",
      "blocked:5",
      "pending:6",
      "completed:1",
    ]);
    expect(view.rows.find((row) => row.id === "2")?.ownerStopped).toBe(true);
    expect(view.rows.find((row) => row.id === "3")?.ownerStopped).toBe(false);
    expect(view.rows.find((row) => row.id === "4")?.blockers).toEqual([{ id: "9", missing: true }]);
    const waiting = view.rows.find((row) => row.id === "5");
    expect(waiting?.blockers).toEqual([{ id: "2", missing: false }]);
    expect(view.attention).toBe(4);
    expect(view.unreadable).toEqual(["7.json"]);
  });

  it("treats a missing subagent record as stopped, and a running one as live", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "in_progress", owner: "agent_old" }),
          task({ id: "2", status: "in_progress", owner: "subagent_live" }),
        ],
        unreadable: [],
      },
      { subagent_live: "running" },
    );
    expect(view.rows.find((row) => row.id === "1")?.ownerStopped).toBe(true);
    expect(view.rows.find((row) => row.id === "2")?.ownerStopped).toBe(false);
  });

  it("does not call a pending task blocked when every blocker is completed", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed" }),
          task({ id: "2", status: "pending", blockedBy: ["1"] }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(view.rows.find((row) => row.id === "2")?.group).toBe("pending");
    expect(view.rows.find((row) => row.id === "2")?.blockers).toEqual([]);
    expect(view.attention).toBe(0);
  });

  it("labels the task button as completed over total, e.g. 4/11", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed" }),
          task({ id: "2", status: "completed" }),
          task({ id: "3", status: "completed" }),
          task({ id: "4", status: "completed" }),
          task({ id: "5", status: "pending" }),
          task({ id: "6", status: "pending" }),
          task({ id: "7", status: "pending" }),
          task({ id: "8", status: "pending" }),
          task({ id: "9", status: "pending" }),
          task({ id: "10", status: "pending" }),
          task({ id: "11", status: "in_progress", owner: "main", subject: "闸门4：用户批准成片" }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(taskProgressLabel(view.rows)).toBe("4/11");
    expect(view.progressLabel).toBe("4/11");
  });

  it("counts only completed rows, not the in-progress gate number in the subject", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          ...Array.from({ length: 10 }, (_, i) =>
            task({ id: String(i + 1), status: "completed", subject: `闸门${i + 1}` }),
          ),
          task({ id: "11", status: "in_progress", owner: "main", subject: "闸门4：用户批准成片" }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(taskProgressLabel(view.rows)).toBe("10/11");
  });

  it("shows total and a check when every task is completed, not total/total", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed" }),
          task({ id: "2", status: "completed" }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(taskProgressLabel(view.rows)).toBe("2 √");
  });

  it("shows 11 and a check when all eleven tasks are completed", () => {
    const view = buildTaskPanel(
      {
        tasks: Array.from({ length: 11 }, (_, i) =>
          task({ id: String(i + 1), status: "completed" }),
        ),
        unreadable: [],
      },
      {},
    );
    expect(taskProgressLabel(view.rows)).toBe("11 √");
    expect(view.progressLabel).toBe("11 √");
  });

  it("shows 0/total when none are completed", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "pending" }),
          task({ id: "2", status: "in_progress", owner: "main" }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(taskProgressLabel(view.rows)).toBe("0/2");
  });

  it("keeps disconnected tasks in one batch when they were created close together", () => {
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed" }),
          task({ id: "2", status: "pending" }),
          task({ id: "3", status: "in_progress", owner: "main" }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(view.batches).toHaveLength(1);
    expect(view.batches[0].tabLabel).toBe("1/3");
    expect(view.batches[0].progressLabel).toBe("1/3");
    expect(view.progressLabel).toBe("1/3");
    expect(view.focusBatchIndex).toBe(0);
  });

  it("splits two pipelines created far apart into numbered batches, and hides the index when there is only one", () => {
    const early = "2026-01-01T00:00:00.000Z";
    const late = new Date(Date.parse(early) + BATCH_GAP_MS + 1).toISOString();
    const first = [
      ...Array.from({ length: 10 }, (_, i) =>
        task({ id: String(i + 1), status: "completed", created_at: early, updated_at: early }),
      ),
      task({
        id: "11",
        status: "in_progress",
        owner: "main",
        subject: "闸门4：用户批准成片",
        created_at: early,
        updated_at: early,
      }),
    ];
    const second = [
      ...Array.from({ length: 5 }, (_, i) =>
        task({ id: String(12 + i), status: "completed", created_at: late, updated_at: late }),
      ),
      task({ id: "17", status: "pending", created_at: late, updated_at: late }),
      task({ id: "18", status: "pending", created_at: late, updated_at: late }),
    ];
    const view = buildTaskPanel({ tasks: [...first, ...second], unreadable: [] }, {});
    expect(view.batches.map((batch) => batch.tabLabel)).toEqual(["1 10/11", "2 5/7"]);
    expect(view.batches[0].progressLabel).toBe("10/11");
    expect(view.batches[1].progressLabel).toBe("5/7");
    expect(view.progressLabel).toBe("10/11");
    expect(view.focusBatchIndex).toBe(0);
    expect(view.attention).toBe(1);
  });

  it("puts a later dependent task in the same batch even after a long gap", () => {
    const early = "2026-01-01T00:00:00.000Z";
    const late = new Date(Date.parse(early) + BATCH_GAP_MS * 3).toISOString();
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed", created_at: early, updated_at: early, blocks: ["2"] }),
          task({ id: "2", status: "pending", created_at: late, updated_at: late, blockedBy: ["1"] }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(view.batches).toHaveLength(1);
    expect(view.batches[0].tabLabel).toBe("1/2");
    expect(groupTaskBatches([
      { id: "1", blockedBy: [], blocks: ["2"], created_at: early },
      { id: "2", blockedBy: ["1"], blocks: [], created_at: late },
    ])).toEqual([["1", "2"]]);
  });

  it("focuses the open batch after an earlier one is finished, and uses a check on a completed batch tab", () => {
    const early = "2026-01-01T00:00:00.000Z";
    const late = new Date(Date.parse(early) + BATCH_GAP_MS + 1).toISOString();
    const view = buildTaskPanel(
      {
        tasks: [
          ...Array.from({ length: 11 }, (_, i) =>
            task({ id: String(i + 1), status: "completed", created_at: early, updated_at: early }),
          ),
          task({ id: "12", status: "completed", created_at: late, updated_at: late }),
          task({ id: "13", status: "in_progress", owner: "main", created_at: late, updated_at: late }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(view.batches.map((batch) => batch.tabLabel)).toEqual(["1 11 √", "2 1/2"]);
    expect(view.progressLabel).toBe("1/2");
    expect(view.focusBatchIndex).toBe(1);
    expect(view.batches[0].allComplete).toBe(true);
    expect(view.batches[1].allComplete).toBe(false);
  });

  it("uses the last batch for the button when every batch is complete", () => {
    const early = "2026-01-01T00:00:00.000Z";
    const late = new Date(Date.parse(early) + BATCH_GAP_MS + 1).toISOString();
    const view = buildTaskPanel(
      {
        tasks: [
          task({ id: "1", status: "completed", created_at: early, updated_at: early }),
          task({ id: "2", status: "completed", created_at: late, updated_at: late }),
          task({ id: "3", status: "completed", created_at: late, updated_at: late }),
        ],
        unreadable: [],
      },
      {},
    );
    expect(view.batches.map((batch) => batch.tabLabel)).toEqual(["1 1 √", "2 2 √"]);
    expect(view.progressLabel).toBe("2 √");
    expect(view.focusBatchIndex).toBe(1);
  });
});
