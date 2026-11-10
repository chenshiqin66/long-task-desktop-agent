import {
  AgentRuntime,
  AutoAllowGate,
  ClosedAskGate,
  DEFAULT_AGENT_CONFIG,
  SessionStore,
  TaskStore,
  ToolHost,
  toAgentConfig,
} from "@agent/core";
import type { AgentConfig, RuntimeEvent, ToolCall } from "@agent/core";
import type { EvalCase, LiveModelSettings } from "./types.js";
import type { Observation } from "./observe.js";
import { buildObservation } from "./observe.js";
import { prepareWorkspace } from "./workspace.js";
import {
  DIRECT_SUBAGENT,
  SCAFFOLD_NPM_TEST,
  WAIT_FOR_DEFERRED,
  modeFor,
  policyFor,
  timeoutFor,
  type RunMode,
} from "./policies.js";
import {
  createLiveProvider,
  RecordingProvider,
  ScriptedProvider,
  policyNeedsStop,
  type RecordedExchange,
  type ScriptedScript,
} from "./provider.js";
import { loadCoreInternals } from "./coreInternals.js";

export class SkipCaseError extends Error {}

export interface RunCaseOptions {
  liveSettings: LiveModelSettings | null;
  /** Override the case's wall-clock budget, for debugging. */
  timeoutMs?: number;
}

export interface CaseRun {
  observation: Observation;
  cleanup(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function scriptedConfig(): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    baseUrl: "http://scripted.invalid/v1",
    model: "scripted",
    apiKey: "not-a-real-key",
  };
}

function innerCall(raw: { tool: string; args?: Record<string, unknown>; [key: string]: unknown }): {
  name: string;
  args: Record<string, unknown>;
} {
  const { tool, args, ...flat } = raw;
  return { name: tool, args: { ...flat, ...(args ?? {}) } };
}

/**
 * The mt-10 script names the task and the directory but leaves out the parent
 * call's description/task. parseAgentCall requires both, so fill them from the
 * prior task. This is scaffolding for the case file, not product behavior.
 */
function completeAgentCall(c: EvalCase, call: { tool: string; args: Record<string, unknown> }): void {
  if (call.tool !== "subagent") return;
  const taskId = call.args.task_id == null ? "" : String(call.args.task_id);
  const prior = c.prior_tasks?.find((task) => task.id === taskId);
  if (!call.args.description) call.args.description = prior?.subject ?? "按任务清单执行";
  if (!call.args.task) {
    call.args.task = prior ? `${prior.description}\n\n完成后按任务要求处理清单。` : "按描述完成工作。";
  }
}

function scriptedQueues(c: EvalCase): ScriptedScript {
  const parentCalls = [...(c.scripted_parent ?? [])];
  if (parentCalls.length === 0 && c.scripted_subagent?.parent_call) {
    parentCalls.push(c.scripted_subagent.parent_call);
  }
  // One scripted entry is one assistant response. A later entry therefore sees
  // the previous tool result, which is what the dependent runtime cases mean.
  const parent = parentCalls.map((entry) => {
    const { tool, args: nested, ...flat } = entry;
    const args: Record<string, unknown> = { ...flat, ...(nested ?? {}) };
    completeAgentCall(c, { tool, args });
    return { calls: [{ name: tool, args }] };
  });

  const inner = c.scripted_subagent?.inner_tools ?? [];
  const subagent: ScriptedScript["subagent"] = [];
  if (inner.length) subagent.push({ calls: inner.map(innerCall) });
  const taskId = c.scripted_subagent?.parent_call?.args?.task_id;
  if (inner.length && taskId != null && String(taskId) && c.scripted_subagent?.calls_complete_task !== false) {
    subagent.push({ calls: [{ name: "complete_task", args: { task_id: String(taskId) } }] });
  }
  return { parent, subagent };
}

function withTurn(turn_id: string, event:
  | { type: "tool_call"; tool_call: ToolCall }
  | { type: "tool_result"; tool_call_id: string; content: string; is_error: boolean }): RuntimeEvent {
  if (event.type === "tool_call") return { type: "tool_call", turn_id, tool_call: event.tool_call };
  return {
    type: "tool_result",
    turn_id,
    tool_call_id: event.tool_call_id,
    content: event.content,
    is_error: event.is_error,
  };
}

async function readTasks(root: string, sessionId: string) {
  const snapshot = await TaskStore.forSession(root, sessionId).list();
  return snapshot.tasks;
}

async function waitForDeferred(runtime: AgentRuntime, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (runtime.hasDeferredWork() && Date.now() < deadline) await sleep(50);
  return !runtime.hasDeferredWork();
}

export async function runCase(c: EvalCase, opts: RunCaseOptions): Promise<CaseRun> {
  const mode: RunMode | "skip" = modeFor(c, Boolean(opts.liveSettings));
  if (mode === "skip") {
    throw new SkipCaseError(`no live model configured; ${c.layer} cases need one`);
  }

  const prepared = await prepareWorkspace(c, { scaffoldNpmTest: SCAFFOLD_NPM_TEST.has(c.id) });
  const workspace = prepared.root;
  const sessionId = prepared.sessionId;
  const errors: string[] = [];
  const events: RuntimeEvent[] = [];
  const config = mode === "live" ? toAgentConfig(opts.liveSettings!) : scriptedConfig();

  try {
    const tasksInitial = await readTasks(workspace, sessionId);
    let provider: ScriptedProvider | RecordingProvider | null = null;
    let runtime: AgentRuntime | null = null;
    let stopped = false;
    let timedOut = false;

    const direct = DIRECT_SUBAGENT[c.id];
    if (!direct) {
      if (mode === "scripted") {
        provider = new ScriptedProvider(scriptedQueues(c));
        runtime = new AgentRuntime({
          workspacePath: workspace,
          config,
          provider,
          skillsRoot: prepared.skillsRoot,
          permissions: new AutoAllowGate(),
          asks: new ClosedAskGate(),
        });
      } else {
        provider = createLiveProvider(opts.liveSettings!, policyFor(c)).provider;
        runtime = new AgentRuntime({
          workspacePath: workspace,
          config,
          provider,
          skillsRoot: prepared.skillsRoot,
          permissions: new AutoAllowGate(),
          asks: new ClosedAskGate(),
        });
      }
      runtime.onEvent((event) => events.push(event));
    }

    if (direct) {
      const internals = await loadCoreInternals();
      const controller = new AbortController();
      const providerForChild = new ScriptedProvider(scriptedQueues(c));
      provider = providerForChild;
      const result = await internals.runIsolatedSubagent({
        workspacePath: workspace,
        sessionId,
        parentTurnId: "direct_parent_turn",
        parentToolCallId: "direct_parent_call",
        config,
        provider: providerForChild,
        skillsRoot: prepared.skillsRoot,
        tools: new ToolHost().subset(internals.toolsForSubagent(direct.subagentType)),
        signal: controller.signal,
        subagentType: direct.subagentType,
        task: direct.task,
        description: direct.description,
        ...(direct.outputDir ? { outputDir: direct.outputDir } : {}),
        ...(direct.taskId ? { taskId: direct.taskId } : {}),
        ...(direct.agentId ? { agentId: direct.agentId } : {}),
        onTool: (event) => events.push(withTurn("direct_child_turn", event)),
      });
      if (result.is_error) errors.push(result.content);
    } else {
      const active = runtime!;
      if (mode === "live" && provider instanceof RecordingProvider) {
        const policy = policyFor(c);
        provider.onParentExchange = (exchange) => {
          if (!stopped && policyNeedsStop(policy, exchange)) {
            stopped = true;
            active.cancel();
          }
        };
      }

      const userText = c.user?.trim() || `执行脚本用例 ${c.id}。`;
      const timeoutMs = opts.timeoutMs ?? timeoutFor(c);
      const submit = active.submit(sessionId, userText).catch((err: unknown) => {
        errors.push(`submit failed: ${String(err)}`);
      });
      const timeout = sleep(timeoutMs).then(() => {
        timedOut = true;
        active.cancel();
      });
      await Promise.race([submit, timeout]);
      if (timedOut) {
        // Give the abort a moment to unwind before reading state.
        await Promise.race([submit, sleep(3_000)]);
      }

      if (active.hasDeferredWork()) {
        if (WAIT_FOR_DEFERRED.has(c.id)) {
          const settled = await waitForDeferred(active, 10_000);
          if (!settled) errors.push("deferred work did not settle before the wait ended");
        }
        await active.stopDeferred();
      }
    }

    const tasks = await readTasks(workspace, sessionId);
    const store = new SessionStore(workspace);
    const messages = await store.readMessages(sessionId);
    const exchanges: RecordedExchange[] = provider?.exchanges ?? [];

    const observation = await buildObservation({
      caseId: c.id,
      layer: c.layer,
      mode,
      workspace,
      sessionId,
      exchanges,
      events,
      messages,
      tasksInitial,
      tasks,
      timedOut,
    });
    observation.errors.push(...errors);

    return {
      observation,
      cleanup: prepared.cleanup,
    };
  } catch (err) {
    await prepared.cleanup().catch(() => {});
    throw err;
  }
}
