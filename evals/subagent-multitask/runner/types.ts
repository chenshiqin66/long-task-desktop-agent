import type { TaskStatus } from "@agent/core";

/** Which part of the product a case exercises. Mirrors `layers` in cases.json. */
export type Layer = "model" | "runtime" | "both";

export interface FixtureMap {
  [workspaceRelativePath: string]: string;
}

/** A prior conversation turn, written into messages.jsonl before the case starts. */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool name for role=tool. */
  name?: string;
}

/** A task that already exists when the case starts. */
export interface PriorTask {
  id: string;
  subject: string;
  description: string;
  status?: TaskStatus;
  owner?: string;
  blockedBy?: string[];
}

/** An expected task in `tasks_after_parent_turn` / `tasks_when_done`. */
export interface ExpectedTask {
  subject_contains?: string;
  status: TaskStatus;
  owner?: string;
  owner_prefix?: string;
}

/** One tool call the scripted parent emits. All calls in the array form one batch. */
export interface ScriptedParentCall {
  tool: string;
  args?: Record<string, unknown>;
  /** The case file usually nests arguments in `args`, but mt-10 writes them flat. */
  [key: string]: unknown;
}

/** One tool call a scripted subagent emits. Flat path/content fields are accepted. */
export interface ScriptedInnerTool {
  tool: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScriptedSubagent {
  /** Fixed id, used when the case drives runIsolatedSubagent directly. */
  id?: string;
  /** How the parent asks for the subagent. */
  parent_call?: ScriptedParentCall;
  /** What the subagent does after the parent's call. */
  inner_tools?: ScriptedInnerTool[];
  calls_complete_task?: boolean;
}

export interface EvalCase {
  id: string;
  group: string;
  layer: Layer;
  title: string;
  user?: string;
  fixture?: FixtureMap;
  transcript?: TranscriptEntry[];
  prior_tasks?: PriorTask[];
  scripted_parent?: ScriptedParentCall[];
  scripted_subagent?: ScriptedSubagent;
  must: string[];
  must_not: string[];
  variants?: string[];
  tasks_after_parent_turn?: ExpectedTask[];
  tasks_when_done?: ExpectedTask[];
  runtime?: string;
  why?: string;
  [extra: string]: unknown;
}

export interface CaseFile {
  name: string;
  version: number;
  purpose?: string;
  store?: Record<string, string>;
  layers?: Record<string, string>;
  grade?: Record<string, string>;
  cases: EvalCase[];
}

export interface LiveModelSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Where the settings came from, for the report. */
  source: string;
}
