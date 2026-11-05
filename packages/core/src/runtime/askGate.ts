export interface AskRequest {
  request_id: string;
  turn_id: string;
  tool_call_id: string;
  question: string;
  options: string[];
  signal?: AbortSignal;
}

export type AskDecision =
  | { type: "answer"; text: string }
  | { type: "cancel" }
  | { type: "unavailable" };

export interface AskGate {
  request(req: AskRequest): Promise<AskDecision>;
}

/** Headless default: do not invent an answer and do not hang. */
export class ClosedAskGate implements AskGate {
  async request(): Promise<AskDecision> {
    return { type: "unavailable" };
  }
}

/**
 * Resolves when `answer(request_id, text)` is called, or on abort → cancel.
 * Used by the Electron main process.
 */
export class DeferredAskGate implements AskGate {
  private pending = new Map<
    string,
    {
      resolve: (d: AskDecision) => void;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  request(req: AskRequest): Promise<AskDecision> {
    return new Promise<AskDecision>((resolve) => {
      const finish = (d: AskDecision) => {
        const entry = this.pending.get(req.request_id);
        if (!entry) return;
        this.pending.delete(req.request_id);
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        resolve(d);
      };
      const onAbort = () => finish({ type: "cancel" });
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

  answer(requestId: string, text: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve({ type: "answer", text });
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      const entry = this.pending.get(id);
      entry?.resolve({ type: "cancel" });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
