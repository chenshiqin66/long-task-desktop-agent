import type { ToolRisk } from "../tools/policy.js";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  /** Correlates UI response with this gate wait. */
  request_id: string;
  turn_id: string;
  tool_call_id: string;
  tool: string;
  risk: ToolRisk;
  summary: string;
  command?: string;
  signal?: AbortSignal;
}

export interface PermissionGate {
  request(req: PermissionRequest): Promise<PermissionDecision>;
}

/** Default for tests / headless: always allow (blocked tools never reach the gate). */
export class AutoAllowGate implements PermissionGate {
  async request(_req: PermissionRequest): Promise<PermissionDecision> {
    return "allow";
  }
}

/**
 * Resolves when `respond(request_id, decision)` is called, or on abort → deny.
 * Used by Electron main process (and permission unit tests).
 */
export class DeferredPermissionGate implements PermissionGate {
  private pending = new Map<
    string,
    {
      resolve: (d: PermissionDecision) => void;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  request(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const finish = (d: PermissionDecision) => {
        const entry = this.pending.get(req.request_id);
        if (!entry) return;
        this.pending.delete(req.request_id);
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        resolve(d);
      };
      const onAbort = () => finish("deny");
      this.pending.set(req.request_id, {
        resolve: finish,
        signal: req.signal,
        onAbort,
      });
      if (req.signal) {
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve(decision);
    return true;
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.respond(id, "deny");
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
