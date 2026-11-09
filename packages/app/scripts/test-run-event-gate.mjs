import assert from "node:assert/strict";
import { beginRun, decideEvent, idleGate } from "../dist/src/renderer/runEventGate.js";

// idle: never paints
{
  const d = decideEvent(idleGate(), "sess-a", { type: "text", turn_id: "t1" });
  assert.equal(d.paint, false);
  assert.equal(d.next.isRunning, false);
}

// latch turn + paint while viewing run session
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "status", turn_id: "t1", phase: "llm" });
  assert.equal(d.paint, true);
  assert.equal(d.next.activeTurnId, "t1");
  gate = d.next;

  d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  assert.equal(d.paint, true);
}

// mid-run session switch: do not paint foreign transcript; still clear on done
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  gate = d.next;
  assert.equal(gate.activeTurnId, "t1");

  d = decideEvent(gate, "sess-b", { type: "text", turn_id: "t1" });
  assert.equal(d.paint, false, "switched session must not paint");
  assert.equal(d.keep, true, "switched session still keeps the run transcript");
  gate = d.next;
  assert.equal(gate.isRunning, true);

  d = decideEvent(gate, "sess-b", { type: "done", turn_id: "t1", reason: "completed" });
  assert.equal(d.paint, false, "done while viewing other session: no paint");
  assert.equal(d.next.isRunning, false, "done must clear gate");
}

// mismatched turn_id ignored
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  gate = d.next;
  d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t2" });
  assert.equal(d.paint, false);
  assert.equal(d.keep, false);
  assert.equal(d.next.isRunning, true);
  assert.equal(d.next.activeTurnId, "t1");
}

// switch back to run session mid-stream: paint again
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  gate = d.next;
  d = decideEvent(gate, "sess-b", { type: "text", turn_id: "t1" });
  assert.equal(d.paint, false);
  gate = d.next;
  d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  assert.equal(d.paint, true, "returning to run session should paint");
}

// a deferred child's tools are not a new turn: paint after the parent gate is idle
{
  const d = decideEvent(idleGate(), "sess-a", {
    type: "tool_call",
    turn_id: "t-old",
    parent_tool_call_id: "call_parent",
    session_id: "sess-a",
  });
  assert.equal(d.paint, true);
  assert.equal(d.keep, false);
  assert.equal(d.next.isRunning, false);
}

// the same late row must not paint onto another session
{
  const d = decideEvent(idleGate(), "sess-b", {
    type: "tool_result",
    turn_id: "t-old",
    parent_tool_call_id: "call_parent",
    session_id: "sess-a",
  });
  assert.equal(d.paint, false);
  assert.equal(d.keep, false);
  assert.equal(d.next.isRunning, false);
  assert.equal(d.stashFor, "sess-a", "the row belongs in sess-a's cached view");
}

// a late row on the session being viewed paints there, not into a cache
{
  const d = decideEvent(idleGate(), "sess-a", {
    type: "tool_result",
    turn_id: "t-old",
    parent_tool_call_id: "call_parent",
    session_id: "sess-a",
  });
  assert.equal(d.stashFor, undefined);
}

// a continuation latches a new turn and still paints the child's old turn id
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t2" });
  gate = d.next;
  d = decideEvent(gate, "sess-a", {
    type: "tool_call",
    turn_id: "t1",
    parent_tool_call_id: "call_parent",
    session_id: "sess-a",
  });
  assert.equal(d.paint, true);
  assert.equal(d.next.isRunning, true);
  assert.equal(d.next.activeTurnId, "t2");
}

// while the parent turn is still running, a switched-away view keeps the row for the parked board
{
  let gate = beginRun("sess-a");
  let d = decideEvent(gate, "sess-a", { type: "text", turn_id: "t1" });
  gate = d.next;
  d = decideEvent(gate, "sess-b", {
    type: "tool_call",
    turn_id: "t1",
    parent_tool_call_id: "call_parent",
    session_id: "sess-a",
  });
  assert.equal(d.paint, false);
  assert.equal(d.keep, true);
  assert.equal(d.next.isRunning, true);
}

console.log("runEventGate tests ok");
