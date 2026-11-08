import { describe, it, expect } from "vitest";
import { buildTaskPanel } from "../src/store/taskPanel.js";
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
});
