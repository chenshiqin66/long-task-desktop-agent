/** Tracks which session/turn owns the in-flight submit so UI can ignore stale events. */
export interface RunGate {
  isRunning: boolean;
  runSessionId: string | null;
  activeTurnId: string | null;
}

export interface GateDecision {
  /** Whether to mutate the transcript the user is looking at. */
  paint: boolean;
  /** Belongs to the in-flight run. Still true when the user is looking at another session. */
  keep: boolean;
  next: RunGate;
}

export function idleGate(): RunGate {
  return { isRunning: false, runSessionId: null, activeTurnId: null };
}

export function beginRun(sessionId: string): RunGate {
  return { isRunning: true, runSessionId: sessionId, activeTurnId: null };
}

/**
 * Decide whether a RuntimeEvent should paint the current view.
 * - Latches turn_id from the first event that carries one.
 * - Ignores events for a different turn_id.
 * - Ignores paint when the user is viewing another session (or none),
 *   but still clears the gate on `done` for the active turn.
 * - A subagent tool row is not a new turn. After the parent turn ends, or
 *   during a later continuation, it still paints on its own session.
 */
export function decideEvent(
  gate: RunGate,
  currentSessionId: string | null,
  event: { type: string; turn_id?: string; parent_tool_call_id?: string; session_id?: string },
): GateDecision {
  if (
    event.session_id &&
    event.parent_tool_call_id &&
    (event.type === "tool_call" || event.type === "tool_result")
  ) {
    const sameTurn =
      gate.isRunning &&
      gate.runSessionId === event.session_id &&
      (!gate.activeTurnId || !event.turn_id || event.turn_id === gate.activeTurnId);
    if (!sameTurn) {
      return { paint: event.session_id === currentSessionId, keep: false, next: gate };
    }
  }

  if (!gate.isRunning) {
    return { paint: false, keep: false, next: gate };
  }

  let next: RunGate = gate;

  if (event.turn_id && !next.activeTurnId) {
    next = { ...next, activeTurnId: event.turn_id };
  }

  if (next.activeTurnId && event.turn_id && event.turn_id !== next.activeTurnId) {
    return { paint: false, keep: false, next };
  }

  const viewingRun = currentSessionId === next.runSessionId;

  if (event.type === "done") {
    return { paint: viewingRun, keep: true, next: idleGate() };
  }

  return { paint: viewingRun, keep: true, next };
}
