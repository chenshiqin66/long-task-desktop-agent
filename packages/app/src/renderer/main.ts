import {
  appendAskCard,
  appendMessage,
  appendTaskNotice,
  appendReaskButton,
  CANCELLED_TURN_NOTICE,
  isCancelledNotice,
  appendPermissionCard,
  appendToolStep,
  refreshToolGroup,
  removeLastTranscriptNodes,
  escapeHtml,
  renderEmptyState,
  rerenderAllAssistantMarkdown,
  refreshStickyTurns,
  setRichText,
  setToolDetailContent,
} from "./ui.js";
import { beginRun, decideEvent, idleGate, type RunGate } from "./runEventGate.js";
import { renderTaskPanel, type TaskPanelView } from "./taskPanelView.js";
import { attachSkillLibrary, attachSkillMenu, onSkillMenuKey } from "./skills.js";
import { escapeAction } from "./escapeKey.js";
import { mountExplainPane, type ExplainPane } from "./explainPane.js";
import { mountQuestionNav } from "./questionNav.js";

type SubagentToolRow = {
  parent_tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
  arguments?: string;
};

declare global {
  interface Window {
    agent: {
      getWorkspace(): Promise<string | null>;
      restoreWorkspace(): Promise<{
        active: string | null;
        paths: string[];
        labels: Record<string, string>;
        collapsed?: string[];
      }>;
      setWorkspaceExpanded(path: string, open: boolean): Promise<void>;
      addWorkspace(): Promise<{
        active: string | null;
        paths: string[];
        added: string;
        already: boolean;
      } | null>;
      activateWorkspace(path: string): Promise<string>;
      listWorkspaceSessions(path: string): Promise<Array<{ session_id: string; title?: string }>>;
      loadWorkspaceMessages(
        path: string,
        sessionId: string,
      ): Promise<
        Array<{
          id?: string;
          role: string;
          content: string;
          name?: string;
          is_error?: boolean;
          tool_call_id?: string;
          tool_call_arguments?: string;
          images?: Array<{ path: string }>;
        }>
      >;
      loadWorkspaceSubagentSteps(
        path: string,
        sessionId: string,
      ): Promise<SubagentToolRow[]>;
      loadWorkspaceArtifacts(
        path: string,
        sessionId: string,
      ): Promise<{
        meta: Record<string, unknown>;
        messages: unknown[];
        traces: unknown[];
        context: unknown[];
      }>;
      readWorkspaceImage(path: string, sessionId: string, relativePath: string): Promise<string>;
      renameWorkspaceSession(
        path: string,
        sessionId: string,
        title: string,
        opts?: { source?: "user" | "auto" },
      ): Promise<{ title?: string }>;
      deleteWorkspaceSession(path: string, sessionId: string): Promise<void>;
      openWorkspaceFolder(path: string): Promise<void>;
      renameWorkspace(path: string, name: string): Promise<{ path: string; labels: Record<string, string> }>;
      removeWorkspace(path: string): Promise<{
        paths: string[];
        active: string | null;
        labels: Record<string, string>;
      }>;
      createSession(title?: string): Promise<{ session_id: string; title?: string }>;
      listSessions(): Promise<Array<{ session_id: string; title?: string; updated_at?: string }>>;
      loadMessages(sessionId: string): Promise<
        Array<{
          id?: string;
          role: string;
          content: string;
          name?: string;
          is_error?: boolean;
          tool_call_id?: string;
          tool_call_arguments?: string;
          images?: Array<{ path: string }>;
        }>
      >;
      loadSubagentSteps(sessionId: string): Promise<SubagentToolRow[]>;
      loadTasks(sessionId: string): Promise<TaskPanelView>;
      loadWorkspaceTasks(path: string, sessionId: string): Promise<TaskPanelView>;
      loadSessionArtifacts(sessionId: string): Promise<{
        meta: Record<string, unknown>;
        messages: unknown[];
        traces: unknown[];
        context: unknown[];
      }>;
      renameSession(
        sessionId: string,
        title: string,
        opts?: { source?: "user" | "auto" },
      ): Promise<{ session_id: string; title?: string }>;
      deleteSession(sessionId: string): Promise<void>;
      submit(
        sessionId: string,
        text: string,
        images?: Array<{ mime: string; base64: string }>,
        workspace?: string,
      ): Promise<void>;
      watchSession(sessionId: string | null, workspace?: string): Promise<void>;
      listSkills(): Promise<Array<{ name: string; description: string; enabled: boolean }>>;
      skillTokens(text: string): Promise<string[]>;
      installSkill(): Promise<{ name: string; description: string; enabled: boolean } | null>;
      setSkillEnabled(name: string, enabled: boolean): Promise<void>;
      uninstallSkill(name: string): Promise<void>;
      openSkillFolder(name: string): Promise<void>;
      readSessionImage(sessionId: string, relativePath: string): Promise<string>;
      cancel(sessionId?: string, workspace?: string): Promise<void>;
      explainLoad(
        workspace: string,
        sessionId: string,
      ): Promise<{ open: boolean; messages: Array<{ id?: string; role: string; content: string; name?: string; is_error?: boolean; tool_call_id?: string; tool_call_arguments?: string; images?: Array<{ path: string }> }> }>;
      explainSetOpen(workspace: string, sessionId: string, open: boolean): Promise<void>;
      explainSubmit(
        workspace: string,
        sessionId: string,
        text: string,
        images?: Array<{ mime: string; base64: string }>,
        sourceMessageIds?: string[] | null,
      ): Promise<void>;
      explainCancel(): Promise<void>;
      explainReadImage(workspace: string, sessionId: string, relativePath: string): Promise<string>;
      onExplainEvent(cb: (e: any) => void): () => void;
      respondPermission(requestId: string, decision: "allow" | "deny"): Promise<boolean>;
      answerAsk(requestId: string, text: string): Promise<boolean>;
      getConfig(): Promise<any>;
      saveConfig(cfg: any): Promise<void>;
      localTargetsExist(targets: string[]): Promise<Record<string, boolean>>;
      openExternal(target: string): Promise<{ ok: boolean; error?: string }>;
      popupAppMenu(index: number, x: number, y: number): Promise<void>;
      setTaskbarPrompt(open: boolean, inView: boolean): Promise<void>;
      onEvent(cb: (e: any) => void): () => void;
      onSkillsChanged(cb: () => void): () => void;
    };
  }
}

const messagesEl = document.getElementById("messages")!;
const treesEl = document.getElementById("workspace-trees")!;
const statusEl = document.getElementById("status")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const composerLockNote = document.getElementById("composer-lock-note") as HTMLElement;
const btnNew = document.getElementById("btn-new") as HTMLButtonElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;
const btnImage = document.getElementById("btn-image") as HTMLButtonElement;
const btnTasks = document.getElementById("btn-tasks") as HTMLButtonElement;
const taskCountEl = document.getElementById("task-count")!;
const taskPanelEl = document.getElementById("task-panel")!;
const imageInput = document.getElementById("image-input") as HTMLInputElement;
const composerEl = document.getElementById("composer")!;
const composerImages = document.getElementById("composer-images")!;
const mainTitle = document.getElementById("main-title")!;
const mainBar = document.getElementById("main-bar")!;
const viewTabs = document.getElementById("view-tabs")!;
const conversationEl = document.getElementById("conversation")!;
const permissionDock = document.getElementById("permission-dock")!;
const composerDock = document.querySelector(".composer-dock") as HTMLElement;
const storeDock = document.getElementById("store-dock")!;
const storeTabs = document.getElementById("store-tabs")!;
const storeView = document.getElementById("store-view")!;
const storeHint = document.getElementById("store-meta-hint")!;
const findBar = document.getElementById("find-bar")!;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count")!;
const configDialog = document.getElementById("config-dialog") as HTMLDialogElement;
const configForm = document.getElementById("config-form") as HTMLFormElement;
const skillsPage = document.getElementById("skills-page") as HTMLElement;
const btnSkills = document.getElementById("btn-skills") as HTMLButtonElement;
const skillMenu = document.getElementById("skill-menu") as HTMLElement;
const pageCtxMenu = document.getElementById("page-ctx-menu")!;
const pageCtxCopy = pageCtxMenu.querySelector('[data-ctx="copy"]') as HTMLButtonElement;
const pageCtxExplain = pageCtxMenu.querySelector('[data-ctx="explain"]') as HTMLButtonElement;
let explainApi: ExplainPane | null = null;
let ctxSource: "main" | "explain" | "file" = "main";

let currentSessionId: string | null = null;
let taskPanel: TaskPanelView = { rows: [], unreadable: [], attention: 0 };
let taskPanelOpen = false;
let taskLoad = 0;
let currentSessionTitle = "";
let hasWorkspace = false;
let workspacePaths: string[] = [];
let workspaceLabels: Record<string, string> = {};
let activeWorkspace: string | null = null;
/** Workspace of the session currently shown. May differ while another workspace's turn is running. */
let viewWorkspace: string | null = null;
const workspaceExpanded = new Map<string, boolean>();
const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_EDGE = 1600;
type PendingImage = { previewUrl: string; mime: "image/png" | "image/jpeg"; base64: string };
type ComposerDraft = { text: string; images: PendingImage[] };
let pendingImages: PendingImage[] = [];
/** Drafts belong to one page: the blank「新建会话」page, or one session. Not the global box. */
const composerDrafts = new Map<string, ComposerDraft>();
/** One rendered transcript per opened session. Switching reattaches it instead of parsing again. */
const SESSION_VIEW_LIMIT = 8;
type StashedSessionView = { holder: HTMLElement; scrollTop: number; followTail: boolean };
const sessionViews = new Map<string, StashedSessionView>();
const sessionLoads = new Map<string, Promise<void>>();
let statusIsRun = false;
let creatingSession = false;

type RunPrompt =
  | { kind: "permission"; requestId: string; tool: string; summary: string; command?: string }
  | { kind: "ask"; requestId: string; question: string; options: string[] };

/** Paint state for one live session. Several of these can stream at once. */
type RunPaint = {
  workspace: string;
  sessionId: string;
  gate: RunGate;
  liveStatus: string;
  stopRequested: boolean;
  wakeAcceptsInput: boolean;
  pendingAsk: { requestId: string } | null;
  prompt: RunPrompt | null;
  /** Pool still holds this session, including a deferred subagent after the turn. */
  slotHeld: boolean;
  streamBuffer: string;
  streamingEl: HTMLElement | null;
  streamRaf: number;
  openToolDetail: HTMLElement | null;
  openTools: Map<string, HTMLElement>;
  toolStepNodes: Map<string, HTMLElement>;
  nestedTails: Map<string, HTMLElement>;
};

const runs = new Map<string, RunPaint>();
/** session_idle already dropped this key. Late events must not light the spinner again. */
const releasedRuns = new Set<string>();
/** Set while an event is being painted, so tool maps belong to that session. */
let drawing: RunPaint | null = null;

function runKeyOf(workspace: string, sessionId: string): string {
  return sessionViewKey(workspace, sessionId) ?? "";
}

function ensureRun(workspace: string, sessionId: string): RunPaint {
  const key = runKeyOf(workspace, sessionId);
  const found = runs.get(key);
  if (found) return found;
  const created: RunPaint = {
    workspace,
    sessionId,
    gate: idleGate(),
    liveStatus: "",
    stopRequested: false,
    wakeAcceptsInput: false,
    pendingAsk: null,
    prompt: null,
    slotHeld: false,
    streamBuffer: "",
    streamingEl: null,
    streamRaf: 0,
    openToolDetail: null,
    openTools: new Map(),
    toolStepNodes: new Map(),
    nestedTails: new Map(),
  };
  runs.set(key, created);
  return created;
}

function pageRun(): RunPaint | null {
  if (!currentSessionId) return null;
  const workspace = viewWorkspace ?? activeWorkspace;
  if (!workspace) return null;
  return runs.get(runKeyOf(workspace, currentSessionId)) ?? null;
}

function dropRun(workspace: string | null, sessionId: string | null): void {
  if (!workspace || !sessionId) return;
  const run = runs.get(runKeyOf(workspace, sessionId));
  if (run?.streamRaf) cancelAnimationFrame(run.streamRaf);
  runs.delete(runKeyOf(workspace, sessionId));
}

function sessionStillHeld(run: RunPaint | undefined): boolean {
  return Boolean(run && (run.gate.isRunning || run.slotHeld));
}

function releaseHeldRun(workspace: string, sessionId: string): void {
  const key = runKeyOf(workspace, sessionId);
  const run = runs.get(key);
  if (run?.gate.isRunning) return;
  releasedRuns.add(key);
  dropRun(workspace, sessionId);
  updateChrome();
  void refreshSessions();
}

function workspaceHasRun(path: string): boolean {
  for (const run of runs.values()) {
    if (sessionStillHeld(run) && sameWorkspace(run.workspace, path)) return true;
  }
  return false;
}

function sessionRun(workspace: string, sessionId: string): RunPaint | undefined {
  return runs.get(runKeyOf(workspace, sessionId));
}

const FILE_TABS = ["meta", "messages", "trace", "context"] as const;
type StoreTab = (typeof FILE_TABS)[number];
type MainView = "chat" | StoreTab;

function isFileTab(value: string | undefined): value is StoreTab {
  return !!value && (FILE_TABS as readonly string[]).includes(value);
}
let activeView: MainView = "chat";
/** Keep the transcript pinned to the latest line until the user scrolls up to read. */
let followTail = true;
let tailAnchor = 0;
let skillsPageOpen = false;
let activeStoreTab: StoreTab = "meta";
let sessionArtifacts: {
  meta: Record<string, unknown>;
  messages: unknown[];
  traces: unknown[];
  context: unknown[];
} | null = null;
const STORE_STRING_PREVIEW = 1600;

function cancelStreamRichPaint(run: RunPaint | null = drawing): void {
  if (!run?.streamRaf) return;
  cancelAnimationFrame(run.streamRaf);
  run.streamRaf = 0;
}

function distanceFromTail(): number {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
}

let applyingTailScroll = false;

/** Jump to the latest line. Callers decide whether the user is still following. */
function revealTail(): void {
  if (conversationEl.hidden || activeView !== "chat") return;
  const previous = messagesEl.style.scrollBehavior;
  messagesEl.style.scrollBehavior = "auto";
  applyingTailScroll = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  applyingTailScroll = false;
  messagesEl.style.scrollBehavior = previous;
  tailAnchor = messagesEl.scrollTop;
}

/** Grow the transcript, then stay put when the user has scrolled up to read. */
function keepTail(mutate: () => void): void {
  const stick = followTail;
  mutate();
  refreshStickyTurns(messagesEl);
  if (stick) revealTail();
}

function paintStreamRich(immediate = false, run: RunPaint | null = drawing): void {
  if (!run?.streamingEl) return;
  const paint = () => {
    run.streamRaf = 0;
    if (!run.streamingEl) return;
    const stick = followTail && !!run.streamingEl.closest("#messages");
    setRichText(run.streamingEl, run.streamBuffer, true);
    if (stick) revealTail();
  };
  if (immediate) {
    cancelStreamRichPaint(run);
    paint();
    return;
  }
  if (run.streamRaf) return;
  run.streamRaf = requestAnimationFrame(paint);
}

function resetStreamTarget(el: HTMLElement | null = null, run: RunPaint | null = drawing): void {
  if (!run) return;
  cancelStreamRichPaint(run);
  run.streamingEl = el;
  run.streamBuffer = "";
}

/** Soft-truncate long strings so jsonl dumps stay readable in the dock. */
function previewForStore(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= STORE_STRING_PREVIEW) return value;
    return `${value.slice(0, STORE_STRING_PREVIEW)}\n…(+${value.length - STORE_STRING_PREVIEW} chars)`;
  }
  if (Array.isArray(value)) return value.map((v) => previewForStore(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = previewForStore(v);
    }
    return out;
  }
  return value;
}

function formatStorePayload(data: unknown): string {
  try {
    return JSON.stringify(previewForStore(data), null, 2);
  } catch {
    return String(data);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** Pretty-print one message; paint user role + content lines in accent green. */
function formatMessageStoreHtml(msg: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(previewForStore(msg), null, 2);
  } catch {
    return escapeHtml(String(msg));
  }
  const isUser = isRecord(msg) && msg.role === "user";
  if (!isUser) return escapeHtml(json);
  return json
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (/^"role"\s*:\s*"user"\b/.test(t) || /^"content"\s*:\s*"/.test(t)) {
        return `<span class="store-user-line">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    })
    .join("\n");
}

function storeJsonPre(item: unknown, highlightUser = false): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "context-entry-body";
  if (highlightUser) pre.innerHTML = formatMessageStoreHtml(item);
  else pre.textContent = formatStorePayload(item);
  return pre;
}

function storeTabButtons(): HTMLButtonElement[] {
  return Array.from(storeTabs.querySelectorAll(".store-tab")) as HTMLButtonElement[];
}

/** Chat and file tabs share one row. Only the selected tab owns the stage. */
function setMainView(view: MainView): void {
  if (view !== "chat" && storeTabs.hidden) view = "chat";
  activeView = view;
  const chatOn = view === "chat";
  mainTitle.classList.toggle("active", chatOn);
  mainTitle.setAttribute("aria-selected", chatOn ? "true" : "false");
  for (const btn of storeTabButtons()) {
    const on = !chatOn && btn.dataset.storeTab === view;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (view !== "chat") activeStoreTab = view;
  conversationEl.hidden = !chatOn;
  composerDock.hidden = !chatOn;
  if (!chatOn && document.activeElement === inputEl) inputEl.blur();
  storeDock.hidden = chatOn || storeTabs.hidden;
  viewTabs.classList.toggle("has-files", !storeTabs.hidden);
  if (!chatOn) paintStoreView();
  if (skillsPageOpen) {
    coverStageWithSkills();
    mainTitle.classList.remove("active");
    mainTitle.setAttribute("aria-selected", "false");
    for (const tab of storeTabButtons()) {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
    }
  }
  if (!findBar.hidden) runFind(true);
  else if (!conversationEl.hidden && followTail) revealTail();
  syncTaskChrome();
}

function coverStageWithSkills(): void {
  conversationEl.hidden = true;
  composerDock.hidden = true;
  storeDock.hidden = true;
  mainBar.classList.add("is-covered");
  if (document.activeElement === inputEl) inputEl.blur();
  syncTaskChrome();
}

function leaveSkillsPage(): void {
  if (!skillsPageOpen) return;
  skillsPageOpen = false;
  skillsPage.hidden = true;
  mainBar.classList.remove("is-covered");
  btnSkills.classList.remove("is-current");
  btnSkills.setAttribute("aria-pressed", "false");
}

function closeSkillsPage(): void {
  if (!skillsPageOpen) return;
  leaveSkillsPage();
  setMainView(activeView);
}

function openSkillsPage(): void {
  skillsPageOpen = true;
  skillsPage.hidden = false;
  btnSkills.classList.add("is-current");
  btnSkills.setAttribute("aria-pressed", "true");
  mainTitle.classList.remove("active");
  mainTitle.setAttribute("aria-selected", "false");
  for (const tab of storeTabButtons()) {
    tab.classList.remove("active");
    tab.setAttribute("aria-selected", "false");
  }
  coverStageWithSkills();
}

function paintStoreView(): void {
  if (!sessionArtifacts) {
    storeView.textContent = "未加载会话数据";
    storeHint.textContent = "";
    return;
  }
  if (activeStoreTab === "meta") {
    storeView.textContent = formatStorePayload(sessionArtifacts.meta);
    storeHint.textContent = "会话元数据 · JSON";
  } else if (activeStoreTab === "messages") {
    paintStoreEntries(sessionArtifacts.messages, "messages.jsonl", renderMessageEntry);
  } else if (activeStoreTab === "trace") {
    paintStoreEntries(sessionArtifacts.traces, "trace.jsonl", renderTraceEntry);
  } else if (activeStoreTab === "context") {
    paintStoreEntries(sessionArtifacts.context, "context.jsonl", renderContextEntry);
  }
}

function paintStoreEntries(
  items: unknown[],
  fileLabel: string,
  render: (item: unknown, index: number) => { summary: string; className: string },
): void {
  storeHint.textContent = `${items.length} 条 · ${fileLabel} · 默认折叠`;
  storeView.replaceChildren();
  if (!items.length) return;
  const list = document.createElement("div");
  list.className = "context-list";
  items.forEach((item, index) => {
    const rendered = render(item, index);
    const entry = document.createElement("details");
    entry.className = rendered.className ? `context-entry ${rendered.className}` : "context-entry";
    const summary = document.createElement("summary");
    summary.textContent = rendered.summary;
    const highlightUser = rendered.className.includes("is-user") && fileLabel === "messages.jsonl";
    entry.append(summary, storeJsonPre(item, highlightUser));
    list.append(entry);
  });
  storeView.append(list);
}

function messageRecordSummary(row: Record<string, unknown>, index: number): string {
  const role = recordString(row, "role") || "未知";
  const name = recordString(row, "name");
  const who = name ? `${role} ${name}` : role;
  const flags: string[] = [];
  if (row.is_error === true) flags.push("错误");
  if (row.interrupted === true) flags.push("已中断");
  const images = Array.isArray(row.images) ? row.images.length : 0;
  if (images) flags.push(`${images} 张图`);
  const calls = toolCallNames(row.tool_calls);
  const content = recordString(row, "content");
  const preview = oneLinePreview(content);
  const tail = [preview, calls.join(", ")].filter(Boolean).join(" · ");
  return [`${index + 1} · ${who}`, flags.join(" · "), tail].filter(Boolean).join(" · ");
}

function renderMessageEntry(item: unknown, index: number): { summary: string; className: string } {
  if (!isRecord(item)) return { summary: `${index + 1} · 无法解析`, className: "" };
  const className =
    item.name === "task-notification" ? "is-notice" : item.role === "user" ? "is-user" : item.is_error === true ? "is-error" : "";
  return { summary: messageRecordSummary(item, index), className };
}

function traceRecordSummary(row: Record<string, unknown>, index: number): string {
  const type = recordString(row, "type") || "未知";
  const detail = isRecord(row.detail) ? row.detail : {};
  const bits = [`${index + 1}`, type];
  if (type === "llm_request") {
    const id = recordString(detail, "context_id") || recordString(row, "id");
    if (id) bits.push(`context_id ${id}`);
    if (typeof detail.message_count === "number") bits.push(`${detail.message_count} 条消息`);
    const model = recordString(detail, "model");
    if (model) bits.push(model);
    return bits.join(" · ");
  }
  if (type === "user_message") {
    if (typeof detail.content_chars === "number") bits.push(`${detail.content_chars} 字`);
    if (typeof detail.image_count === "number" && detail.image_count > 0) {
      bits.push(`${detail.image_count} 张图`);
    }
    return bits.join(" · ");
  }
  if (type === "llm_response" || type === "max_steps") {
    if (detail.interrupted === true) bits.push("已中断");
    const calls = toolCallNames(detail.tool_calls);
    const preview = oneLinePreview(recordString(detail, "content"));
    const tail = [preview, calls.join(", ")].filter(Boolean).join(" · ");
    if (tail) bits.push(tail);
    return bits.join(" · ");
  }
  if (type === "llm_error") {
    const preview = oneLinePreview(recordString(row, "error"));
    if (preview) bits.push(preview);
    return bits.join(" · ");
  }
  if (type === "tool_call") {
    const tool = recordString(detail, "tool");
    if (tool) bits.push(tool);
    bits.push("开始");
    return bits.join(" · ");
  }
  if (type === "tool_result") {
    const tool = recordString(detail, "tool");
    if (tool) bits.push(tool);
    if (typeof detail.duration_ms === "number") bits.push(formatDuration(detail.duration_ms));
    if (detail.denied === true) bits.push("已拒绝");
    else if (detail.cancelled === true) bits.push("已终止");
    else if (detail.is_error === true) bits.push("错误");
    const preview = oneLinePreview(recordString(detail, "content"));
    if (preview) bits.push(preview);
    return bits.join(" · ");
  }
  if (type === "cancel") bits.push("用户取消");
  return bits.join(" · ");
}

function renderTraceEntry(item: unknown, index: number): { summary: string; className: string } {
  if (!isRecord(item)) return { summary: `${index + 1} · 无法解析`, className: "" };
  const detail = isRecord(item.detail) ? item.detail : {};
  const className =
    item.type === "user_message"
      ? "is-user"
      : item.type === "llm_error" || (item.type === "tool_result" && detail.is_error === true)
        ? "is-error"
        : "";
  return { summary: traceRecordSummary(item, index), className };
}

function contextRecordSummary(row: Record<string, unknown>, index: number): string {
  const type = recordString(row, "type") || "未知";
  const bits = [`${index + 1}`, type];
  if (type === "tools") {
    const sha = recordString(row, "sha256");
    if (sha) bits.push(sha.slice(0, 12));
    if (Array.isArray(row.tools)) bits.push(`${row.tools.length} 个工具`);
    return bits.join(" · ");
  }
  if (type === "request") {
    const id = recordString(row, "id");
    if (id) bits.push(id);
    if (Array.isArray(row.messages)) bits.push(`${row.messages.length} 条消息`);
    const model = recordString(row, "model");
    if (model) bits.push(model);
    return bits.join(" · ");
  }
  return bits.join(" · ");
}

function renderContextEntry(item: unknown, index: number): { summary: string; className: string } {
  if (!isRecord(item)) return { summary: `${index + 1} · 无法解析`, className: "" };
  return { summary: contextRecordSummary(item, index), className: "" };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.round(ms / 1000)} 秒`;
}

function oneLinePreview(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function toolCallNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const call of value) {
    if (!call || typeof call !== "object") continue;
    const fn = (call as { function?: { name?: unknown } }).function;
    if (typeof fn?.name === "string" && fn.name) names.push(fn.name);
  }
  return names;
}

function hideStoreDock(): void {
  sessionArtifacts = null;
  storeTabs.hidden = true;
  storeView.textContent = "";
  storeHint.textContent = "";
  setMainView("chat");
}

async function refreshStoreDock(sessionId: string | null): Promise<void> {
  if (!sessionId || !window.agent?.loadSessionArtifacts) {
    hideStoreDock();
    return;
  }
  try {
    sessionArtifacts =
      viewWorkspace && !sameWorkspace(viewWorkspace, activeWorkspace)
        ? await window.agent.loadWorkspaceArtifacts(viewWorkspace, sessionId)
        : await window.agent.loadSessionArtifacts(sessionId);
    storeTabs.hidden = false;
    const labels: Record<StoreTab, string> = {
      meta: "meta",
      messages: `messages (${sessionArtifacts.messages.length})`,
      trace: `trace (${sessionArtifacts.traces.length})`,
      context: `context (${sessionArtifacts.context.length})`,
    };
    for (const name of FILE_TABS) {
      const tab = storeTabs.querySelector(`[data-store-tab="${name}"]`);
      if (!(tab instanceof HTMLElement)) continue;
      const label = tab.querySelector(".view-tab-label");
      if (label) label.textContent = labels[name];
      else tab.textContent = labels[name];
      tab.title = labels[name];
    }
    setMainView(activeView);
  } catch (err) {
    sessionArtifacts = null;
    storeTabs.hidden = false;
    storeHint.textContent = "";
    const message = `加载失败：${errText(err)}`;
    setMainView(activeView);
    if (activeView === "chat") setStatus(`会话文件加载失败：${errText(err)}`, true);
    else storeView.textContent = message;
  }
}

mainTitle.addEventListener("click", () => {
  leaveSkillsPage();
  setMainView("chat");
});
for (const btn of storeTabButtons()) {
  btn.addEventListener("click", () => {
    if (!isFileTab(btn.dataset.storeTab)) return;
    leaveSkillsPage();
    setMainView(btn.dataset.storeTab);
  });
}
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-app-menu]"))) {
  btn.addEventListener("click", () => {
    const index = Number(btn.dataset.appMenu);
    if (!Number.isInteger(index) || !window.agent?.popupAppMenu) return;
    const rect = btn.getBoundingClientRect();
    // Content-relative. Electron adds the window origin itself; adding
    // screenX/screenY again detaches the menu whenever the window is not at (0, 0).
    void window.agent.popupAppMenu(index, Math.round(rect.left), Math.round(rect.bottom));
  });
}

function hidePageCtxMenu(): void {
  pageCtxMenu.hidden = true;
}

function selectionTextIn(root: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const anchor =
    common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  if (!anchor || !root.contains(anchor)) return "";
  return sel.toString();
}

function pageCopyText(): string {
  const root =
    ctxSource === "explain" && explainApi?.searchRoot()
      ? explainApi.searchRoot()!
      : activeView === "chat"
        ? messagesEl
        : storeView;
  const selected = selectionTextIn(root);
  if (selected) return selected;
  if (ctxSource === "file") return (storeView.textContent || "").trim();
  return (root.innerText || root.textContent || "").trim();
}

function selectedMessageIds(root: HTMLElement): string[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const ids: string[] = [];
  root.querySelectorAll<HTMLElement>(".msg[data-message-id]").forEach((node) => {
    if (!range.intersectsNode(node)) return;
    const id = node.dataset.messageId;
    if (id) ids.push(id);
  });
  return ids;
}

async function copyPageContent(): Promise<void> {
  const text = pageCopyText();
  if (!text) {
    setStatus("没有可复制的内容", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus("已复制", true);
    window.setTimeout(() => {
      if (statusEl.textContent === "已复制") setStatus("", false);
    }, 1200);
  } catch (err) {
    showStatusError(err);
  }
}

function showPageCtxMenu(clientX: number, clientY: number): void {
  pageCtxMenu.hidden = false;
  const pad = 6;
  const rect = pageCtxMenu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - pad);
  const y = Math.min(clientY, window.innerHeight - rect.height - pad);
  pageCtxMenu.style.left = `${Math.max(pad, x)}px`;
  pageCtxMenu.style.top = `${Math.max(pad, y)}px`;
}

function onPageContextMenu(ev: MouseEvent): void {
  const target = ev.target;
  if (!(target instanceof Node)) return;
  if (explainApi?.contains(target)) {
    if (target instanceof Element && target.closest("#explain-composer")) return;
    ctxSource = "explain";
  } else if (messagesEl.contains(target)) {
    ctxSource = "main";
  } else {
    ctxSource = "file";
  }
  ev.preventDefault();
  const root =
    ctxSource === "explain" && explainApi?.searchRoot()
      ? explainApi.searchRoot()!
      : ctxSource === "main"
        ? messagesEl
        : storeView;
  const selected = selectionTextIn(root).trim();
  const showExplain = ctxSource === "main" || ctxSource === "explain";
  pageCtxExplain.hidden = !showExplain;
  pageCtxExplain.disabled = !selected;
  showPageCtxMenu(ev.clientX, ev.clientY);
}

messagesEl.addEventListener("contextmenu", onPageContextMenu);
document.getElementById("explain-conversation")?.addEventListener("contextmenu", onPageContextMenu);
messagesEl.addEventListener(
  "scroll",
  () => {
    const top = messagesEl.scrollTop;
    if (applyingTailScroll) {
      tailAnchor = top;
      return;
    }
    // At the bottom again: follow. Any upward move away from it: the user is reading.
    if (distanceFromTail() <= 4) followTail = true;
    else if (top < tailAnchor - 1) followTail = false;
    tailAnchor = top;
  },
  { passive: true },
);
storeView.addEventListener("contextmenu", onPageContextMenu);
pageCtxCopy.addEventListener("click", (ev) => {
  ev.preventDefault();
  hidePageCtxMenu();
  void copyPageContent();
});
pageCtxExplain.addEventListener("click", (ev) => {
  ev.preventDefault();
  const source = ctxSource;
  const root =
    source === "explain" && explainApi?.searchRoot()
      ? explainApi.searchRoot()!
      : messagesEl;
  const text = selectionTextIn(root);
  const ids = source === "main" ? selectedMessageIds(messagesEl) : null;
  hidePageCtxMenu();
  if (!text.trim() || !explainApi) return;
  explainApi.ask(text, source === "main" ? ids : null);
});

const EXPLAIN_DRAG_MIME = "application/x-csq-explain";
type ExplainDrag = { text: string; ids: string[] | null };
let explainDrag: ExplainDrag | null = null;

function dragTypesHave(ev: DragEvent, mime: string): boolean {
  const types = ev.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === mime) return true;
  }
  return false;
}

function rememberExplainDrag(root: HTMLElement, fromMain: boolean, ev: DragEvent): void {
  if (ev.target instanceof Element && ev.target.closest("textarea, input, button")) return;
  const text = selectionTextIn(root).trim();
  if (!text || !ev.dataTransfer) return;
  const payload: ExplainDrag = { text, ids: fromMain ? selectedMessageIds(messagesEl) : null };
  explainDrag = payload;
  ev.dataTransfer.setData(EXPLAIN_DRAG_MIME, JSON.stringify(payload));
  ev.dataTransfer.setData("text/plain", text);
  ev.dataTransfer.effectAllowed = "copy";
}

function readExplainDrag(ev: DragEvent): ExplainDrag | null {
  const raw = ev.dataTransfer?.getData(EXPLAIN_DRAG_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ExplainDrag>;
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        return { text: parsed.text, ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === "string") : null };
      }
    } catch {
      /* The in-memory copy from dragstart still applies. */
    }
  }
  return explainDrag;
}

function bindExplainDragSource(root: HTMLElement, fromMain: boolean): void {
  root.addEventListener("dragstart", (ev) => rememberExplainDrag(root, fromMain, ev));
}

bindExplainDragSource(messagesEl, true);
const explainConversation = document.getElementById("explain-conversation");
if (explainConversation) bindExplainDragSource(explainConversation, false);

const explainPane = document.getElementById("explain-pane");
explainPane?.addEventListener("dragover", (ev) => {
  if (!dragTypesHave(ev, EXPLAIN_DRAG_MIME)) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  explainPane.classList.add("is-explain-drop");
});
explainPane?.addEventListener("dragleave", (ev) => {
  const next = ev.relatedTarget;
  if (next instanceof Node && explainPane.contains(next)) return;
  explainPane.classList.remove("is-explain-drop");
});
explainPane?.addEventListener("drop", (ev) => {
  if (!dragTypesHave(ev, EXPLAIN_DRAG_MIME)) return;
  ev.preventDefault();
  explainPane.classList.remove("is-explain-drop");
  const payload = readExplainDrag(ev);
  explainDrag = null;
  if (!payload?.text.trim() || !explainApi) return;
  explainApi.ask(payload.text, payload.ids);
});
document.addEventListener("dragend", () => {
  explainDrag = null;
  explainPane?.classList.remove("is-explain-drop");
});
document.addEventListener("click", (ev) => {
  if (pageCtxMenu.hidden) return;
  const t = ev.target;
  if (t instanceof Node && pageCtxMenu.contains(t)) return;
  hidePageCtxMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || pageCtxMenu.hidden) return;
  ev.preventDefault();
  hidePageCtxMenu();
});
window.addEventListener("blur", hidePageCtxMenu);
window.addEventListener("resize", hidePageCtxMenu);
window.addEventListener("scroll", hidePageCtxMenu, true);

btnNew.disabled = true;
btnSend.disabled = true;

const PHASE_LABEL: Record<string, string> = {
  assembling: "整理上下文…",
  llm: "思考中……",
  tool: "执行工具…",
  awaiting_permission: "等待确认权限…",
  awaiting_user: "等你回答…",
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setStatus(text: string, busy = false, source: "page" | "run" = "page"): void {
  statusEl.textContent = text || "";
  statusEl.hidden = !busy || !text;
  statusIsRun = source === "run" && Boolean(text);
  syncHomeBar();
  syncFloatPad();
}

/** Remember the running session's phase. Paint it only while that page is open. */
function showRunStatus(text: string, run: RunPaint | null = drawing): void {
  if (!run) return;
  run.liveStatus = text;
  if (!run.gate.isRunning || currentSessionId !== run.sessionId || !sameWorkspace(viewWorkspace, run.workspace)) {
    return;
  }
  setStatus(text, true, "run");
}

/** No open session: the title row is the home page the user asked to remove. */
function syncHomeBar(): void {
  const home = !currentSessionId && storeTabs.hidden;
  mainTitle.hidden = home;
  mainBar.hidden = home;
}

function showStatusError(err: unknown): void {
  setStatus(errText(err), true);
}

function showChatError(err: unknown): void {
  const msg = errText(err);
  setStatus(msg, true);
  appendMessage(messagesEl, "error", msg);
}

function clearOpenTools(run: RunPaint | null = drawing): void {
  if (!run) return;
  run.openTools.clear();
  run.toolStepNodes.clear();
  run.nestedTails.clear();
  run.openToolDetail = null;
}

function toolRowKey(callId: string, parentId?: string): string {
  return parentId ? `${parentId}\n${callId}` : callId;
}

function stepWrap(body: HTMLElement): HTMLElement | null {
  const wrap = body.closest(".msg.tool-step");
  return wrap instanceof HTMLElement ? wrap : null;
}

function rowByToolCall(host: HTMLElement, callId: string, parentId?: string): HTMLElement | null {
  const nodes = host.querySelectorAll<HTMLElement>("[data-tool-call-id]");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.dataset.toolCallId !== callId) continue;
    if ((node.dataset.parentToolCallId ?? "") !== (parentId ?? "")) continue;
    return node;
  }
  return null;
}

/** Where the next nested row goes. Maps are cleared when the parent turn ends; the DOM row stays. */
function anchorForParent(host: HTMLElement, parentId: string, run: RunPaint | null = drawing): HTMLElement | undefined {
  const fromTail = run?.nestedTails.get(parentId);
  if (fromTail?.isConnected) return fromTail;
  const fromMap = run?.toolStepNodes.get(parentId);
  if (fromMap?.isConnected) return fromMap;
  let last: HTMLElement | undefined;
  const nested = host.querySelectorAll<HTMLElement>("[data-parent-tool-call-id]");
  for (let i = 0; i < nested.length; i++) {
    const node = nested[i]!;
    if (node.dataset.parentToolCallId === parentId) last = node;
  }
  if (last) return last;
  return rowByToolCall(host, parentId) ?? undefined;
}

function toolCallTitle(name: string, argsJson: string): string {
  let hint = "";
  try {
    const args = JSON.parse(argsJson) as {
      path?: unknown;
      query?: unknown;
      queries?: unknown;
      command?: unknown;
      question?: unknown;
      description?: unknown;
    };
    const termText = [
      typeof args.query === "string" ? args.query : "",
      Array.isArray(args.queries) ? args.queries.map((term) => String(term)).filter(Boolean).join(", ") : "",
    ]
      .filter(Boolean)
      .join(", ");
    const scope = typeof args.path === "string" ? args.path.trim() : "";
    const search = [scope, termText].filter(Boolean).join(" ");
    const raw = String(search || args.question || args.command || args.description || "")
      .trim()
      .replace(/\s+/g, " ");
    if (raw) hint = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
  } catch {
    hint = "";
  }
  return hint ? `调用 ${name} · ${hint}` : `调用 ${name}`;
}

function historyToolTitle(name: string, argsJson?: string): string {
  const live = toolCallTitle(name, argsJson ?? "{}");
  return live.startsWith("调用 ") ? `工具结果 · ${live.slice("调用 ".length)}` : `工具结果 · ${name}`;
}

function sameWorkspace(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function workspaceLabel(path: string): string {
  const key = Object.keys(workspaceLabels).find((item) => item.toLowerCase() === path.toLowerCase());
  const custom = key ? workspaceLabels[key].trim() : "";
  return custom || folderName(path);
}

function updateChrome(): void {
  const sessionTitle = currentSessionId ? currentSessionTitle || "会话" : "";
  const titleLabel = mainTitle.querySelector(".view-tab-label");
  if (titleLabel) titleLabel.textContent = sessionTitle;
  else mainTitle.textContent = sessionTitle;
  mainTitle.title = sessionTitle;
  syncHomeBar();
  const run = pageRun();
  const running = Boolean(run?.gate.isRunning);
  const asking = Boolean(run?.pendingAsk);
  const wakeHere = Boolean(run?.wakeAcceptsInput) && !asking;
  const wakeDraft = wakeHere && (inputEl.value.trim().length > 0 || pendingImages.length > 0);
  const canCompose = hasWorkspace && !asking && !creatingSession && (!running || wakeHere);
  const hasDraft = inputEl.value.trim().length > 0 || pendingImages.length > 0;
  // Stop belongs to this session. Another session's turn does not lock this box.
  const stopHere = running && !asking && !wakeDraft;
  const stopping = stopHere && Boolean(run?.stopRequested);
  btnSend.disabled = stopping ? true : stopHere || asking ? false : !canCompose || !hasDraft;
  btnSend.textContent = asking ? "回答" : stopping ? "正在停止" : stopHere ? "停止" : "发送";
  btnSend.classList.toggle("is-stop", stopHere && !stopping);
  btnSend.classList.toggle("is-stopping", stopping);
  btnSend.setAttribute(
    "aria-label",
    asking ? "回答" : stopping ? "正在停止" : stopHere ? "停止" : canCompose && hasDraft ? "发送" : "发送已禁用",
  );
  btnNew.disabled = !hasWorkspace || creatingSession;
  inputEl.disabled = creatingSession || (running && !asking && !wakeHere);
  composerEl.classList.remove("is-locked");
  composerEl.classList.remove("has-draft");
  composerLockNote.hidden = true;
  inputEl.placeholder = asking
    ? "回答上面的问题… Enter 发送，Shift+Enter 换行"
    : "向CSQ-Agent发送消息...";
  if (running && run?.liveStatus) {
    setStatus(run.liveStatus, true, "run");
  }
  btnImage.disabled = !canCompose;
  syncImageRemoveLock();
  syncLiveDock();
  syncTaskChrome();
  explainApi?.sync(currentSessionId, viewWorkspace ?? activeWorkspace);
}

function syncTaskChrome(): void {
  const chat = !composerDock.hidden && !skillsPageOpen;
  const hasTasks = taskPanel.rows.length > 0 || taskPanel.unreadable.length > 0;
  btnTasks.hidden = !chat || !hasTasks;
  const open = chat && taskPanelOpen && hasTasks;
  taskPanelEl.hidden = !open;
  btnTasks.setAttribute("aria-expanded", open ? "true" : "false");
  btnTasks.classList.toggle("is-attention", taskPanel.attention > 0);
  taskCountEl.textContent = hasTasks ? String(taskPanel.rows.length) : "";
}

async function refreshTasks(): Promise<void> {
  const token = ++taskLoad;
  const sessionId = currentSessionId;
  if (!sessionId) {
    taskPanel = { rows: [], unreadable: [], attention: 0 };
    taskPanelOpen = false;
    syncTaskChrome();
    return;
  }
  const other = viewWorkspace && !sameWorkspace(viewWorkspace, activeWorkspace) ? viewWorkspace : null;
  try {
    const next = other
      ? await window.agent.loadWorkspaceTasks(other, sessionId)
      : await window.agent.loadTasks(sessionId);
    if (token !== taskLoad || sessionId !== currentSessionId) return;
    taskPanel = next;
    if (!next.rows.length && !next.unreadable.length) taskPanelOpen = false;
    if (taskPanelOpen) renderTaskPanel(taskPanelEl, taskPanel);
    syncTaskChrome();
  } catch (err) {
    if (token !== taskLoad) return;
    showStatusError(err);
  }
}

function composerKey(workspace: string | null, sessionId: string | null): string {
  if (!sessionId) return "new";
  const dir = (workspace ?? "").replace(/[\\/]+$/, "").toLowerCase();
  return `session\0${dir}\0${sessionId}`;
}

function currentComposerKey(): string {
  if (!currentSessionId) return "new";
  return composerKey(viewWorkspace ?? activeWorkspace, currentSessionId);
}

function rememberComposer(): void {
  const key = currentComposerKey();
  const text = inputEl.value;
  if (!text && pendingImages.length === 0) {
    composerDrafts.delete(key);
    return;
  }
  composerDrafts.set(key, { text, images: pendingImages });
}

function restoreComposer(): void {
  const saved = composerDrafts.get(currentComposerKey());
  inputEl.value = saved?.text ?? "";
  pendingImages = saved?.images ?? [];
  renderPendingImages();
}

function forgetComposer(workspace: string | null, sessionId: string | null): void {
  const key = composerKey(workspace, sessionId);
  const draft = composerDrafts.get(key);
  if (!draft) return;
  if (pendingImages === draft.images) pendingImages = [];
  for (const image of draft.images) URL.revokeObjectURL(image.previewUrl);
  composerDrafts.delete(key);
}

function syncImageRemoveLock(): void {
  const locked = inputEl.disabled;
  composerImages.querySelectorAll("button").forEach((node) => {
    if (node instanceof HTMLButtonElement) node.disabled = locked;
  });
}

function sessionViewKey(workspace: string | null, sessionId: string | null): string | null {
  if (!sessionId) return null;
  return composerKey(workspace, sessionId);
}

function ensureSessionView(key: string): StashedSessionView {
  const existing = sessionViews.get(key);
  if (existing) {
    sessionViews.delete(key);
    sessionViews.set(key, existing);
    return existing;
  }
  const created: StashedSessionView = {
    holder: document.createElement("div"),
    scrollTop: 0,
    followTail: true,
  };
  sessionViews.set(key, created);
  return created;
}

function evictSessionViews(keep: string | null): void {
  for (const key of sessionViews.keys()) {
    if (sessionViews.size <= SESSION_VIEW_LIMIT) return;
    const live = runs.get(key);
    if (key === keep || sessionStillHeld(live) || live?.prompt || sessionLoads.has(key)) continue;
    sessionViews.delete(key);
  }
}

function dropSessionView(workspace: string | null, sessionId: string | null): void {
  const key = sessionViewKey(workspace, sessionId);
  if (!key) return;
  sessionViews.delete(key);
  sessionLoads.delete(key);
}

function dropWorkspaceViews(workspace: string): void {
  const dir = workspace.replace(/[\\/]+$/, "").toLowerCase();
  const prefix = `session\0${dir}\0`;
  for (const key of [...sessionViews.keys()]) {
    if (!key.startsWith(prefix)) continue;
    sessionViews.delete(key);
    sessionLoads.delete(key);
  }
}

/** Move the open transcript into its buffer. An empty pane must not wipe a buffer already saved. */
function stashVisibleView(): void {
  const key = sessionViewKey(viewWorkspace ?? activeWorkspace, currentSessionId);
  if (!key || !messagesEl.firstChild) return;
  const entry = ensureSessionView(key);
  entry.scrollTop = messagesEl.scrollTop;
  entry.followTail = followTail;
  entry.holder.replaceChildren();
  while (messagesEl.firstChild) entry.holder.appendChild(messagesEl.firstChild);
  evictSessionViews(key);
}

function mountStashedView(key: string): boolean {
  const entry = sessionViews.get(key);
  if (!entry || entry.holder.childNodes.length === 0) return false;
  ensureSessionView(key);
  messagesEl.replaceChildren();
  while (entry.holder.firstChild) messagesEl.appendChild(entry.holder.firstChild);
  followTail = entry.followTail;
  const previous = messagesEl.style.scrollBehavior;
  messagesEl.style.scrollBehavior = "auto";
  applyingTailScroll = true;
  messagesEl.scrollTop = followTail ? messagesEl.scrollHeight : entry.scrollTop;
  applyingTailScroll = false;
  messagesEl.style.scrollBehavior = previous;
  tailAnchor = messagesEl.scrollTop;
  return true;
}

function mountIfCached(workspace: string, sessionId: string): boolean {
  const key = sessionViewKey(workspace, sessionId);
  return Boolean(key && mountStashedView(key));
}

function markSessionListActive(workspace: string, sessionId: string): void {
  const items = treesEl.querySelectorAll<HTMLElement>(".session-item");
  for (let i = 0; i < items.length; i++) {
    const li = items[i]!;
    const on = li.dataset.sessionId === sessionId && sameWorkspace(li.dataset.workspace ?? null, workspace);
    li.classList.toggle("active", on);
  }
}

function syncEmptyState(): void {
  if (messagesEl.querySelector(".msg, .tool-step")) return;
  if (!hasWorkspace) renderEmptyState(messagesEl, "no-workspace");
  else if (!currentSessionId) renderEmptyState(messagesEl, "no-session");
  else renderEmptyState(messagesEl, "idle");
}

function clearPermissionDock(): void {
  permissionDock.innerHTML = "";
  permissionDock.hidden = true;
  const run = pageRun();
  if (run) {
    run.pendingAsk = null;
    run.prompt = null;
  }
  syncTaskbarAttention();
  updateChrome();
}

let taskbarPromptKey = "";

/** Tell the shell to blink when a card is waiting and this page is not showing it. */
function syncTaskbarAttention(): void {
  let open = false;
  let inView = false;
  for (const run of runs.values()) {
    if (!run.prompt) continue;
    open = true;
    if (promptOnScreen(run)) inView = true;
  }
  const key = `${open}:${inView}`;
  if (key === taskbarPromptKey) return;
  taskbarPromptKey = key;
  void window.agent.setTaskbarPrompt?.(open, inView);
}

function syncLiveDock(): void {
  const run = pageRun();
  const show = Boolean(run?.gate.isRunning && run.prompt && permissionDock.childElementCount > 0);
  permissionDock.hidden = !show;
  syncTaskbarAttention();
}

// Allow / deny removes the card without going through clearPermissionDock.
new MutationObserver(() => syncTaskbarAttention()).observe(permissionDock, { childList: true });

function askQuestion(argsJson: string | undefined): string {
  if (!argsJson) return "";
  try {
    const question = String(
      (JSON.parse(argsJson) as { question?: unknown }).question ?? "",
    ).trim();
    return question.length > 80 ? `${question.slice(0, 80)}…` : question;
  } catch {
    return "";
  }
}

async function answerPending(raw: string): Promise<void> {
  const text = raw.trim();
  const run = pageRun();
  if (!text || !run?.pendingAsk) return;
  const requestId = run.pendingAsk.requestId;
  inputEl.value = "";
  rememberComposer();
  clearPermissionDock();
  try {
    await window.agent.answerAsk(requestId, text);
  } catch (err) {
    showStatusError(err);
  }
}

function closeSessionMenus(): void {
  document.querySelectorAll<HTMLElement>(".session-menu-pop").forEach((el) => {
    el.hidden = true;
  });
  treesEl.querySelectorAll(".session-item.menu-open, .workspace-path-row.menu-open").forEach((el) => {
    el.classList.remove("menu-open");
  });
  treesEl.querySelectorAll('.session-menu-trigger[aria-expanded="true"]').forEach((el) => {
    el.setAttribute("aria-expanded", "false");
  });
}

const MENU_FOLDER =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2h4.1l1.2 1.4H14.2v6.8a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const MENU_PENCIL =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 2.8l3.8 3.8L5.6 14.2H1.8v-3.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8.2 4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const MENU_TRASH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6.2 4.5V3h3.6v1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M4.3 4.6l.6 8.2h6.2l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

function folderName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function isDisplayName(name: string): boolean {
  return name.length > 0 && name.length <= 80 && !/[\r\n]/.test(name);
}

function menuRow(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "session-menu-item workspace-menu-item";
  btn.setAttribute("role", "menuitem");
  btn.innerHTML = `${icon}<span></span>`;
  const span = btn.querySelector("span");
  if (span) span.textContent = label;
  btn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  };
  return btn;
}

async function openWorkspaceMenu(
  path: string,
  trigger: HTMLButtonElement,
  pop: HTMLElement,
  row: HTMLElement,
  removeItem: HTMLButtonElement,
): Promise<void> {
  closeSessionMenus();
  if (!trigger.isConnected) return;
  removeItem.classList.add("is-disabled");
  removeItem.title = "正在确认有没有会话…";
  removeItem.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeSessionMenus();
    setStatus("正在确认有没有会话…", true);
  };
  document.body.appendChild(pop);
  pop.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  row.classList.add("menu-open");
  placeSessionMenu(trigger, pop);
  let sessionCount = 0;
  try {
    sessionCount = (await window.agent.listWorkspaceSessions(path)).length;
  } catch {
    sessionCount = -1;
  }
  if (pop.hidden || !trigger.isConnected) return;
  const canRemove = sessionCount === 0;
  removeItem.classList.toggle("is-disabled", !canRemove);
  removeItem.title = canRemove ? "" : sessionCount > 0 ? "目录下还有会话，不能从列表移除" : "无法确认会话数量";
  removeItem.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeSessionMenus();
    if (!canRemove) {
      setStatus(removeItem.title, true);
      return;
    }
    void removeWorkspaceFromList(path);
  };
}

function startWorkspaceRename(path: string, pathBtn: HTMLButtonElement): void {
  const row = pathBtn.parentElement;
  if (!row || row.querySelector(".workspace-rename-input")) return;
  const current = workspaceLabel(path);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "workspace-rename-input";
  input.value = current;
  input.setAttribute("aria-label", "显示名称");
  pathBtn.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const restore = () => {
    if (input.isConnected) input.replaceWith(pathBtn);
  };
  const finish = async (save: boolean) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (!save || !next || next === current) {
      restore();
      return;
    }
    if (!isDisplayName(next)) {
      finished = false;
      setStatus("显示名不能为空，也不能换行，最多 80 个字", true);
      input.focus();
      return;
    }
    try {
      const result = await window.agent.renameWorkspace(path, next);
      workspaceLabels = result.labels;
      await refreshSessions();
      updateChrome();
    } catch (err) {
      restore();
      showStatusError(err);
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener("blur", () => {
    void finish(true);
  });
}

async function removeWorkspaceFromList(path: string): Promise<void> {
  if (workspaceHasRun(path)) {
    setStatus("请先停止这个工作区里正在执行的会话", true);
    return;
  }
  try {
    const removedActive = path === activeWorkspace;
    const result = await window.agent.removeWorkspace(path);
    workspaceExpanded.delete(path);
    workspacePaths = result.paths;
    workspaceLabels = result.labels;
    activeWorkspace = result.active;
    hasWorkspace = Boolean(activeWorkspace);
    if (removedActive) {
      rememberComposer();
      dropWorkspaceViews(path);
      currentSessionId = null;
      viewWorkspace = result.active;
      currentSessionTitle = "";
      resetStreamTarget(null);
      clearOpenTools();
      clearPermissionDock();
      hideStoreDock();
      messagesEl.innerHTML = "";
      setMainView("chat");
      restoreComposer();
    }
    await refreshSessions();
    syncEmptyState();
    updateChrome();
    const where = result.active ? `当前工作区改为 ${workspaceLabel(result.active)}` : "列表里已经没有工作区";
    setStatus(`已从列表移除，文件夹还在原处。${where}`, true);
  } catch (err) {
    showStatusError(err);
  }
}

function mountWorkspaceTree(path: string, open: boolean): HTMLUListElement {
  const block = document.createElement("div");
  block.className = "workspace-tree";
  const row = document.createElement("div");
  row.className = "workspace-path-row";
  if (!open) row.classList.add("is-collapsed");
  if (path === activeWorkspace) row.classList.add("is-active");

  const pathBtn = document.createElement("button");
  pathBtn.type = "button";
  pathBtn.className = "workspace-path";
  const label = workspaceLabel(path);
  pathBtn.textContent = label;
  pathBtn.title = path;
  pathBtn.setAttribute("aria-expanded", open ? "true" : "false");
  pathBtn.setAttribute("aria-label", open ? `折叠 ${label}` : `展开 ${label}`);
  pathBtn.onclick = (ev) => {
    ev.preventDefault();
    toggleWorkspaceList(path, open);
  };

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "workspace-chevron-btn";
  chevron.setAttribute("aria-label", open ? "折叠会话" : "展开会话");
  chevron.innerHTML =
    '<svg class="workspace-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10 L8 6 L12 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  chevron.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleWorkspaceList(path, open);
  };

  const more = document.createElement("button");
  more.type = "button";
  more.className = "workspace-more session-menu-trigger";
  more.setAttribute("aria-label", "工作区操作");
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.textContent = "⋯";

  const pop = document.createElement("div");
  pop.className = "session-menu-pop workspace-menu-pop";
  pop.setAttribute("role", "menu");
  pop.hidden = true;

  const openFolder = menuRow(MENU_FOLDER, "打开文件夹", () => {
    closeSessionMenus();
    void window.agent.openWorkspaceFolder(path).catch(showStatusError);
  });
  const renameItem = menuRow(MENU_PENCIL, "重命名", () => {
    closeSessionMenus();
    startWorkspaceRename(path, pathBtn);
  });
  const removeItem = menuRow(MENU_TRASH, "从列表中移除", () => {
    /* replaced when the menu opens, after the session count is known */
  });
  pop.append(openFolder, renameItem, removeItem);

  more.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!pop.hidden) {
      closeSessionMenus();
      return;
    }
    void openWorkspaceMenu(path, more, pop, row, removeItem);
  };

  const ul = document.createElement("ul");
  ul.className = "session-list";
  ul.hidden = !open;
  const runningHere = workspaceHasRun(path);
  if (runningHere && !open) row.append(sessionSpinner());
  row.append(pathBtn, chevron, more);
  block.append(row, ul);
  treesEl.appendChild(block);
  return ul;
}

function toggleWorkspaceList(path: string, open: boolean): void {
  const next = !open;
  workspaceExpanded.set(path, next);
  void window.agent.setWorkspaceExpanded(path, next).catch(showStatusError);
  void refreshSessions();
}

function rememberWorkspaceFold(paths: string[], collapsed: string[]): void {
  const folded = new Set(collapsed.map((item) => item.replace(/[\\/]+$/, "").toLowerCase()));
  for (const path of paths) {
    workspaceExpanded.set(path, !folded.has(path.replace(/[\\/]+$/, "").toLowerCase()));
  }
}

function sessionSpinner(waiting = false): HTMLElement {
  const mark = document.createElement("span");
  mark.className = waiting ? "session-spinner is-waiting" : "session-spinner";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", waiting ? "等待确认" : "执行中");
  mark.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.28"/><path d="M8 2.75a5.25 5.25 0 0 1 5.25 5.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  return mark;
}

function placeSessionMenu(trigger: HTMLElement, pop: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect();
  const margin = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  let left = anchor.right - width;
  let top = anchor.bottom + 4;
  if (left < margin) left = margin;
  if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.top - height - 4);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

async function refreshSessions(): Promise<void> {
  document.querySelectorAll(".session-menu-pop").forEach((el) => el.remove());
  treesEl.replaceChildren();
  // Saved order is oldest-first. Show the latest addition at the top.
  for (const workspace of [...workspacePaths].reverse()) {
    const open = workspaceExpanded.get(workspace) !== false;
    const listEl = mountWorkspaceTree(workspace, open);
    if (!open) continue;
    try {
      const sessions = await window.agent.listWorkspaceSessions(workspace);
      for (const s of sessions) {
      const li = document.createElement("li");
      li.className = "session-item";
      li.dataset.sessionId = s.session_id;
      li.dataset.workspace = workspace;
      const viewingThis =
        s.session_id === currentSessionId && sameWorkspace(workspace, viewWorkspace);
      if (viewingThis) li.classList.add("active");
      const live = sessionRun(workspace, s.session_id);
      const executing = sessionStillHeld(live);
      const waiting = Boolean(live?.prompt);

      const label = document.createElement("button");
      label.type = "button";
      label.className = "session-label";
      label.textContent = s.title || s.session_id;
      label.onclick = () => {
        void showSession(workspace, s.session_id, s.title || "会话");
      };

      const menu = document.createElement("div");
      menu.className = "session-menu";

      const btnMore = document.createElement("button");
      btnMore.type = "button";
      btnMore.className = "session-menu-trigger";
      btnMore.setAttribute("aria-label", "更多操作");
      btnMore.setAttribute("aria-haspopup", "menu");
      btnMore.setAttribute("aria-expanded", "false");
      btnMore.textContent = "⋯";

      const pop = document.createElement("div");
      pop.className = "session-menu-pop";
      pop.setAttribute("role", "menu");
      pop.hidden = true;

      const closeMenu = () => {
        closeSessionMenus();
      };

      const openMenu = () => {
        closeSessionMenus();
        document.body.appendChild(pop);
        pop.hidden = false;
        btnMore.setAttribute("aria-expanded", "true");
        li.classList.add("menu-open");
        placeSessionMenu(btnMore, pop);
      };

      btnMore.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (pop.hidden) openMenu();
        else closeMenu();
      };

      const startRename = () => {
        closeMenu();
        // Electron renderer: window.prompt is unavailable — use inline edit.
        if (li.querySelector(".session-rename-input")) return;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "session-rename-input";
        input.value = s.title || "会话";
        input.setAttribute("aria-label", "会话名称");
        label.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const restoreLabel = () => {
          if (input.isConnected) input.replaceWith(label);
        };
        const finish = async (save: boolean) => {
          if (finished) return;
          finished = true;
          const next = input.value.trim();
          if (!save || !next || next === (s.title || "会话")) {
            restoreLabel();
            return;
          }
          try {
            const meta = await window.agent.renameWorkspaceSession(workspace, s.session_id, next, {
              source: "user",
            });
            if (currentSessionId === s.session_id) {
              currentSessionTitle = meta.title || next;
              updateChrome();
            }
            await refreshSessions();
          } catch (err) {
            restoreLabel();
            showStatusError(err);
          }
        };
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            void finish(true);
          } else if (ke.key === "Escape") {
            ke.preventDefault();
            void finish(false);
          }
        });
        input.addEventListener("blur", () => {
          void finish(true);
        });
      };

      const btnRename = document.createElement("button");
      btnRename.type = "button";
      btnRename.className = "session-menu-item";
      btnRename.setAttribute("role", "menuitem");
      btnRename.textContent = "重命名";
      btnRename.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        startRename();
      };

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "session-menu-item danger";
      btnDel.setAttribute("role", "menuitem");
      btnDel.textContent = "删除";
      btnDel.onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
        if (!window.confirm(`删除会话「${s.title || s.session_id}」？`)) return;
        try {
          await window.agent.deleteWorkspaceSession(workspace, s.session_id);
          forgetComposer(workspace, s.session_id);
          releasedRuns.add(runKeyOf(workspace, s.session_id));
          dropRun(workspace, s.session_id);
          dropSessionView(workspace, s.session_id);
          if (currentSessionId === s.session_id && sameWorkspace(workspace, viewWorkspace)) {
            currentSessionId = null;
            viewWorkspace = activeWorkspace;
            currentSessionTitle = "";
            messagesEl.innerHTML = "";
            restoreComposer();
            syncEmptyState();
          }
          await refreshSessions();
          updateChrome();
        } catch (err) {
          showStatusError(err);
        }
      };

      pop.append(btnRename, btnDel);
      menu.append(btnMore, pop);
      if (waiting) li.append(sessionSpinner(true));
      else if (executing) li.append(sessionSpinner());
      li.append(label, menu);
      listEl.appendChild(li);
      }
    } catch (err) {
      showStatusError(err);
    }
  }
}

async function showSession(workspace: string, sessionId: string, title: string): Promise<void> {
  const sameSession = sessionId === currentSessionId && sameWorkspace(workspace, viewWorkspace);
  leaveSkillsPage();
  if (sameSession) {
    setMainView(activeView);
    if (!statusIsRun) setStatus("", false);
    void refreshTasks();
    return;
  }
  rememberComposer();
  stashVisibleView();
  try {
    if (!sameWorkspace(workspace, activeWorkspace)) {
      await window.agent.activateWorkspace(workspace);
      activeWorkspace = workspace;
      hasWorkspace = true;
    }
    viewWorkspace = workspace;
    currentSessionId = sessionId;
    currentSessionTitle = title || "会话";
    restoreComposer();
    setMainView("chat");
    markSessionListActive(workspace, sessionId);
    updateChrome();
    const key = sessionViewKey(workspace, sessionId);
    const loading = key ? sessionLoads.get(key) : undefined;
    const fromBuffer = mountIfCached(workspace, sessionId);
    if (!fromBuffer && !loading) {
      const job = loadCurrent().finally(() => {
        if (key) sessionLoads.delete(key);
      });
      if (key) sessionLoads.set(key, job);
      await job;
    } else if (!fromBuffer && loading) {
      await loading;
    } else {
      void refreshStoreDock(sessionId);
    }
    const shown = pageRun();
    if (shown) paintPrompt(shown);
    else clearPermissionDock();
    await refreshSessions();
    updateChrome();
    void window.agent.watchSession(sessionId, workspace);
    if (!statusIsRun) setStatus("", false);
    void refreshTasks();
  } catch (err) {
    showStatusError(err);
  }
}

async function showNewPage(): Promise<void> {
  if (!hasWorkspace) {
    setStatus("请先选择工作区", true);
    return;
  }
  leaveSkillsPage();
  if (creatingSession) {
    setMainView(activeView);
    return;
  }
  if (!currentSessionId && sameWorkspace(viewWorkspace, activeWorkspace)) {
    setMainView("chat");
    if (!inputEl.disabled) inputEl.focus();
    return;
  }
  rememberComposer();
  stashVisibleView();
  currentSessionId = null;
  viewWorkspace = activeWorkspace;
  currentSessionTitle = "";
  resetStreamTarget(null);
  clearOpenTools();
  clearPermissionDock();
  hideStoreDock();
  messagesEl.innerHTML = "";
  followTail = true;
  setMainView("chat");
  restoreComposer();
  await refreshSessions();
  syncEmptyState();
  setStatus("", false);
  updateChrome();
  void refreshTasks();
  if (!inputEl.disabled) inputEl.focus();
}

async function loadCurrent(): Promise<void> {
  const sessionId = currentSessionId;
  const workspace = viewWorkspace;
  const paint = (): HTMLElement => {
    if (sessionId && sessionId === currentSessionId && sameWorkspace(workspace, viewWorkspace)) return messagesEl;
    const key = sessionViewKey(workspace, sessionId);
    return key ? ensureSessionView(key).holder : messagesEl;
  };
  const live = sessionId && workspace ? sessionRun(workspace, sessionId) : null;
  if (live?.gate.isRunning || live?.prompt) {
    if (live.prompt && promptOnScreen(live)) paintPrompt(live);
    return;
  }
  paint().replaceChildren();
  clearPermissionDock();
  if (!sessionId) {
    hideStoreDock();
    syncEmptyState();
    updateChrome();
    return;
  }
  void refreshStoreDock(sessionId);
  if (paint() === messagesEl) messagesEl.classList.add("is-restoring");
  try {
    const otherWorkspace =
      workspace && !sameWorkspace(workspace, activeWorkspace) ? workspace : null;
    const msgs = otherWorkspace
      ? await window.agent.loadWorkspaceMessages(otherWorkspace, sessionId)
      : await window.agent.loadMessages(sessionId);
    let childSteps: SubagentToolRow[] = [];
    try {
      childSteps = otherWorkspace
        ? await window.agent.loadWorkspaceSubagentSteps(otherWorkspace, sessionId)
        : await window.agent.loadSubagentSteps(sessionId);
    } catch {
      childSteps = [];
    }
    const childrenByParent = new Map<string, SubagentToolRow[]>();
    for (const step of childSteps) {
      const list = childrenByParent.get(step.parent_tool_call_id) ?? [];
      list.push(step);
      childrenByParent.set(step.parent_tool_call_id, list);
    }
    if (!msgs.length) {
      renderEmptyState(paint(), "idle");
      return;
    }
    let openQuestion: { body: HTMLElement; text: string } | null = null;
    const liveHere = Boolean(live?.gate.isRunning);
    const closeUnanswered = () => {
      if (!openQuestion) return;
      ensureReask(openQuestion.body, openQuestion.text);
      appendCancelledNotice(paint());
      openQuestion = null;
    };
    for (const m of msgs) {
      const into = paint();
      if (m.role === "tool" && m.name === "ask_user") {
        openQuestion = null;
        const question = askQuestion(m.tool_call_arguments);
        appendToolStep(into, {
          title: question ? `提问 · ${question}` : "提问",
          detail: m.content.slice(0, 4000),
          open: false,
          error: m.is_error === true,
          toolCallId: m.tool_call_id,
          messageId: m.id,
        });
      } else if (m.role === "tool") {
        const body = appendToolStep(into, {
          title: `工具结果${m.name ? ` · ${m.name}` : ""}`,
          detail: m.content.slice(0, 4000),
          open: false,
          error: m.is_error === true,
          toolCallId: m.tool_call_id,
          messageId: m.id,
        });
        if ((m.name === "subagent" || m.name === "agent") && m.tool_call_id) {
          let after = stepWrap(body) ?? undefined;
          for (const step of childrenByParent.get(m.tool_call_id) ?? []) {
            const child = appendToolStep(into, {
              title: historyToolTitle(step.name, step.arguments),
              detail: step.content.slice(0, 4000),
              open: false,
              error: step.is_error === true,
              nested: true,
              after,
              parentToolCallId: m.tool_call_id,
            });
            after = stepWrap(child) ?? after;
          }
        }
      } else if (m.role === "assistant") {
        if (isCancelledNotice(m.content)) {
          if (openQuestion) {
            ensureReask(openQuestion.body, openQuestion.text);
            openQuestion = null;
          }
          const body = appendMessage(into, "assistant", m.content, { rich: true, messageId: m.id });
          body.closest(".msg")?.classList.add("is-cancelled");
        } else {
          openQuestion = null;
          appendMessage(into, "assistant", m.content, { rich: true, messageId: m.id });
        }
      } else if (m.role === "user" && m.name === "task-notification") {
        if (openQuestion) closeUnanswered();
        openQuestion = null;
        appendTaskNotice(into, m.content);
      } else if (m.role === "user") {
        if (openQuestion) closeUnanswered();
        const urls = await imageDataUrls(workspace, sessionId, m.images);
        openQuestion = {
          body: appendMessage(paint(), "user", m.content, {
            ...(urls.length ? { images: urls } : {}),
            ...(m.id ? { messageId: m.id } : {}),
          }),
          text: m.content,
        };
      } else {
        openQuestion = null;
        const urls = await imageDataUrls(workspace, sessionId, m.images);
        appendMessage(paint(), m.role, m.content, urls.length ? { images: urls } : undefined);
      }
    }
    if (openQuestion && !liveHere) closeUnanswered();
    if (paint() === messagesEl) {
      followTail = true;
      revealTail();
    }
  } catch (err) {
    showStatusError(err);
  } finally {
    messagesEl.classList.remove("is-restoring");
  }
}

async function applyWorkspace(path: string | null): Promise<void> {
  activeWorkspace = path;
  hasWorkspace = Boolean(path);
  currentSessionId = null;
  viewWorkspace = null;
  currentSessionTitle = "";
  runs.clear();
  releasedRuns.clear();
  drawing = null;
  resetStreamTarget(null);
  clearOpenTools();
  clearPermissionDock();
  hideStoreDock();
  messagesEl.innerHTML = "";
  await refreshSessions();
  setStatus("", false);
  syncEmptyState();
  updateChrome();
  void refreshTasks();
}

document.getElementById("btn-workspace")!.onclick = async () => {
  if (!window.agent?.addWorkspace) {
    setStatus("预加载失败：window.agent 不可用，请重启应用", true);
    return;
  }
  setStatus("选择要增加的工作区…", true);
  try {
    const added = await window.agent.addWorkspace();
    if (!added) {
      setStatus("未增加工作区");
      return;
    }
    const first = workspacePaths.length === 0;
    workspacePaths = added.paths;
    activeWorkspace = added.active;
    hasWorkspace = Boolean(activeWorkspace);
    workspaceExpanded.set(added.added, true);
    void window.agent.setWorkspaceExpanded(added.added, true).catch(showStatusError);
    if (first) {
      currentSessionId = null;
      viewWorkspace = null;
      currentSessionTitle = "";
      messagesEl.innerHTML = "";
    }
    await refreshSessions();
    setStatus(added.already ? "这个工作区已经在列表里" : "", false);
    syncEmptyState();
    updateChrome();
  } catch (err) {
    showStatusError(err);
  }
};

btnNew.onclick = () => {
  void showNewPage();
};

attachSkillLibrary(btnSkills, skillsPage, { onOpen: openSkillsPage, onClose: closeSkillsPage });
attachSkillMenu(inputEl, skillMenu);

document.getElementById("btn-config")!.onclick = async () => {
  try {
    const cur = (await window.agent.getConfig()) ?? {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "",
    };
    (document.getElementById("cfg-baseUrl") as HTMLInputElement).value = cur.baseUrl ?? "";
    (document.getElementById("cfg-model") as HTMLInputElement).value = cur.model ?? "";
    (document.getElementById("cfg-apiKey") as HTMLInputElement).value = cur.apiKey ?? "";
    configDialog.showModal();
  } catch (err) {
    showStatusError(err);
  }
};

configForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
  const action = submitter?.value ?? "cancel";
  if (action === "cancel") {
    configDialog.close();
    return;
  }
  try {
    const cur = (await window.agent.getConfig()) ?? {};
    const baseUrl = (document.getElementById("cfg-baseUrl") as HTMLInputElement).value.trim();
    const model = (document.getElementById("cfg-model") as HTMLInputElement).value.trim();
    const apiKey = (document.getElementById("cfg-apiKey") as HTMLInputElement).value.trim();
    await window.agent.saveConfig({ ...cur, baseUrl, model, apiKey });
    configDialog.close();
    // A running turn owns the status line. Saving must not clear 「等待确认权限」 or 「等你回答」.
    if (!pageRun()?.gate.isRunning) setStatus("配置已保存");
  } catch (err) {
    showStatusError(err);
  }
});

async function imageDataUrls(
  workspace: string | null,
  sessionId: string,
  images: Array<{ path: string }> | undefined,
): Promise<string[]> {
  if (!images?.length) return [];
  const foreign = Boolean(workspace && !sameWorkspace(workspace, activeWorkspace));
  const urls: string[] = [];
  for (const image of images) {
    try {
      urls.push(
        foreign
          ? await window.agent.readWorkspaceImage(workspace!, sessionId, image.path)
          : await window.agent.readSessionImage(sessionId, image.path),
      );
    } catch {
      /* skip a missing file rather than failing the whole transcript */
    }
  }
  return urls;
}

function renderPendingImages(): void {
  composerImages.innerHTML = "";
  composerImages.hidden = pendingImages.length === 0;
  pendingImages.forEach((image, index) => {
    const thumb = document.createElement("div");
    thumb.className = "composer-thumb";
    const img = document.createElement("img");
    img.src = image.previewUrl;
    img.alt = "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "移除图片");
    remove.onclick = () => {
      if (inputEl.disabled) return;
      URL.revokeObjectURL(image.previewUrl);
      pendingImages.splice(index, 1);
      renderPendingImages();
      rememberComposer();
      updateChrome();
    };
    thumb.append(img, remove);
    composerImages.append(thumb);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

async function fileToPendingImage(file: File): Promise<PendingImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const keepPng = file.type === "image/png";
  let blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("无法压缩图片"))),
      keepPng ? "image/png" : "image/jpeg",
      0.86,
    );
  });
  if (blob.size > 900_000) {
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("无法压缩图片"))),
        "image/jpeg",
        0.8,
      );
    });
  }
  const mime = blob.type === "image/png" ? "image/png" : "image/jpeg";
  return { previewUrl: URL.createObjectURL(blob), mime, base64: await blobToBase64(blob) };
}

async function addImageFiles(files: File[]): Promise<void> {
  const accepted = files.filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
  if (!accepted.length) {
    setStatus("只能上传 png、jpeg、webp 或 gif", true);
    return;
  }
  const room = MAX_PENDING_IMAGES - pendingImages.length;
  if (room <= 0) {
    setStatus(`一次最多 ${MAX_PENDING_IMAGES} 张图片`, true);
    return;
  }
  const batch = accepted.slice(0, room);
  if (accepted.length > room) setStatus(`一次最多 ${MAX_PENDING_IMAGES} 张图片`, true);
  for (const file of batch) {
    try {
      pendingImages.push(await fileToPendingImage(file));
    } catch (err) {
      showStatusError(err);
    }
  }
  renderPendingImages();
  rememberComposer();
}

async function ensureSession(): Promise<string | null> {
  if (currentSessionId) return currentSessionId;
  if (!hasWorkspace) {
    setStatus("请先选择工作区", true);
    return null;
  }
  creatingSession = true;
  updateChrome();
  try {
    const meta = await window.agent.createSession("会话");
    currentSessionId = meta.session_id;
    viewWorkspace = activeWorkspace;
    currentSessionTitle = meta.title || "会话";
    resetStreamTarget(null);
    clearOpenTools();
    await refreshSessions();
    return currentSessionId;
  } catch (err) {
    showStatusError(err);
    return null;
  } finally {
    creatingSession = false;
    updateChrome();
  }
}

async function acceptSkillTokens(text: string): Promise<boolean> {
  try {
    const tokens = await window.agent.skillTokens(text);
    if (!tokens.length) return true;
    const installed = await window.agent.listSkills();
    const byName = new Map(installed.map((skill) => [skill.name, skill]));
    for (const name of tokens) {
      const skill = byName.get(name);
      if (!skill) {
        showChatError(new Error(`未知技能 /${name}。如果这是路径，放进反引号里：\`/${name}\``));
        return false;
      }
      if (!skill.enabled) {
        showChatError(new Error(`技能 /${name} 已停用`));
        return false;
      }
    }
  } catch (err) {
    showChatError(err);
    return false;
  }
  return true;
}

function isSkillSendFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("未知技能 /") || message.includes("无法读取技能 /") || message.includes("已停用");
}

function appendCancelledNotice(container: HTMLElement): void {
  const body = appendMessage(container, "assistant", CANCELLED_TURN_NOTICE, { rich: false });
  body.closest(".msg")?.classList.add("is-cancelled");
}

function ensureReask(body: HTMLElement, text: string): void {
  if (!text.trim() || body.parentElement?.querySelector(".reask")) return;
  appendReaskButton(body, () => {
    void reask(text);
  });
}

function appendUserQuestion(text: string, images: string[], messageId?: string): HTMLElement {
  return appendMessage(messagesEl, "user", text, {
    ...(images.length ? { images } : {}),
    ...(messageId ? { messageId } : {}),
  });
}

async function reask(text: string): Promise<void> {
  if (!text.trim()) return;
  const run = pageRun();
  if (creatingSession || run?.gate.isRunning) {
    setStatus("请先停止当前任务再重新问", true);
    return;
  }
  inputEl.value = text;
  await sendMessage();
}

async function sendMessage(): Promise<void> {
  const page = pageRun();
  if (page?.pendingAsk) {
    await answerPending(inputEl.value);
    return;
  }
  if (creatingSession) return;
  if (page?.gate.isRunning && !page.wakeAcceptsInput) return;
  const text = inputEl.value.trim();
  const images = pendingImages.slice();
  if (!text && images.length === 0) return;
  if (text && !(await acceptSkillTokens(text))) return;
  const draftKey = currentComposerKey();
  const workspace = viewWorkspace ?? activeWorkspace;
  if (!workspace) return;
  try {
    if (!sameWorkspace(workspace, activeWorkspace)) {
      await window.agent.activateWorkspace(workspace);
      activeWorkspace = workspace;
    }
  } catch (err) {
    showStatusError(err);
    return;
  }
  const sessionId = await ensureSession();
  if (!sessionId) return;
  composerDrafts.delete(draftKey);
  composerDrafts.delete(currentComposerKey());
  pendingImages = [];
  composerImages.innerHTML = "";
  composerImages.hidden = true;
  inputEl.value = "";
  if (messagesEl.querySelector(".empty-state")) messagesEl.innerHTML = "";
  followTail = true;
  releasedRuns.delete(runKeyOf(workspace, sessionId));
  const run = ensureRun(workspace, sessionId);
  const alreadyHeld = run.slotHeld;
  const joiningWake = run.gate.isRunning && run.wakeAcceptsInput;
  drawing = run;
  try {
    appendUserQuestion(text, images.map((image) => image.previewUrl));
    if (!joiningWake) {
      resetStreamTarget(appendMessage(messagesEl, "assistant", ""), run);
      clearOpenTools(run);
      run.liveStatus = "运行中…";
      run.gate = beginRun(sessionId);
      run.wakeAcceptsInput = false;
      run.stopRequested = false;
    }
  } finally {
    drawing = null;
  }
  updateChrome();
  void refreshSessions();
  try {
    await window.agent.submit(
      sessionId,
      text,
      images.length
        ? images.map((image) => ({ mime: image.mime, base64: image.base64 }))
        : undefined,
      workspace,
    );
  } catch (err) {
    if (!joiningWake) {
      run.gate = idleGate();
      if (!alreadyHeld) dropRun(workspace, sessionId);
    }
    if (isSkillSendFailure(err)) {
      inputEl.value = text;
      pendingImages = images;
      renderPendingImages();
      rememberComposer();
      removeLastTranscriptNodes(messagesEl, 2);
      if (!messagesEl.querySelector(".msg")) renderEmptyState(messagesEl, "idle");
    }
    showChatError(err);
    updateChrome();
    void refreshSessions();
  }
}

function requestStop(): void {
  const run = pageRun();
  if (!run?.gate.isRunning || run.stopRequested) return;
  run.stopRequested = true;
  run.prompt = null;
  run.pendingAsk = null;
  permissionDock.innerHTML = "";
  permissionDock.hidden = true;
  updateChrome();
  void (async () => {
    try {
      await window.agent.cancel(run.sessionId, run.workspace);
      showRunStatus("已请求停止", run);
    } catch (err) {
      run.stopRequested = false;
      updateChrome();
      showStatusError(err);
    }
  })();
}

btnTasks.onclick = () => {
  if (btnTasks.hidden) return;
  taskPanelOpen = !taskPanelOpen;
  if (taskPanelOpen) renderTaskPanel(taskPanelEl, taskPanel);
  syncTaskChrome();
};

taskPanelEl.addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof Element) || !target.closest(".task-panel-close")) return;
  taskPanelOpen = false;
  syncTaskChrome();
});

btnSend.onclick = () => {
  const run = pageRun();
  if (run?.pendingAsk) {
    void answerPending(inputEl.value);
    return;
  }
  if (run?.gate.isRunning) {
    if (run.wakeAcceptsInput && (inputEl.value.trim() || pendingImages.length > 0)) {
      void sendMessage();
      return;
    }
    requestStop();
    return;
  }
  void sendMessage();
};

inputEl.addEventListener("keydown", (ev) => {
  if (onSkillMenuKey(ev)) return;
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void sendMessage();
  }
});
inputEl.addEventListener("input", () => {
  rememberComposer();
  updateChrome();
});

btnImage.onclick = () => imageInput.click();
imageInput.onchange = () => {
  const files = Array.from(imageInput.files ?? []);
  imageInput.value = "";
  void addImageFiles(files);
};
inputEl.addEventListener("paste", (ev) => {
  const files = Array.from(ev.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (!files.length || btnImage.disabled) return;
  ev.preventDefault();
  void addImageFiles(files);
});

const localLinkExists = new Map<string, boolean>();

function linkKey(raw: string): string {
  return `${activeWorkspace ?? ""}\0${raw}`;
}

function unwrapLocalLink(node: Element): void {
  const parent = node.parentElement;
  if (parent?.classList.contains("md-inline-link")) parent.classList.remove("md-inline-link");
  node.replaceWith(document.createTextNode(node.textContent ?? ""));
}

function dropMissingLocalLinks(root: ParentNode): void {
  root.querySelectorAll('a.md-link[data-local="1"]').forEach((node) => {
    const raw = node.getAttribute("data-open") ?? "";
    if (localLinkExists.get(linkKey(raw)) !== false) return;
    unwrapLocalLink(node);
  });
}

let linkCheckTimer = 0;
let linkCheckGen = 0;

function scheduleLocalLinkCheck(): void {
  if (linkCheckTimer) clearTimeout(linkCheckTimer);
  linkCheckTimer = window.setTimeout(() => {
    linkCheckTimer = 0;
    void confirmLocalLinks(messagesEl);
  }, 150);
}

async function confirmLocalLinks(root: HTMLElement): Promise<void> {
  const workspace = activeWorkspace;
  const unknown: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll('a.md-link[data-local="1"]').forEach((node) => {
    const raw = node.getAttribute("data-open") ?? "";
    if (!raw || seen.has(raw) || localLinkExists.has(`${workspace ?? ""}\0${raw}`)) return;
    seen.add(raw);
    unknown.push(raw);
  });
  dropMissingLocalLinks(root);
  if (!unknown.length || !window.agent?.localTargetsExist) return;
  const gen = ++linkCheckGen;
  try {
    for (let i = 0; i < unknown.length; i += 500) {
      const slice = unknown.slice(i, i + 500);
      const found = await window.agent.localTargetsExist(slice);
      if (gen !== linkCheckGen && activeWorkspace !== workspace) return;
      for (const raw of slice) {
        localLinkExists.set(`${workspace ?? ""}\0${raw}`, found[raw] === true);
      }
    }
  } catch {
    return;
  }
  dropMissingLocalLinks(root);
}

new MutationObserver(() => scheduleLocalLinkCheck()).observe(messagesEl, {
  childList: true,
  subtree: true,
});

messagesEl.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const a = t.closest("a.md-link");
  if (!a) return;
  ev.preventDefault();
  const raw = a.getAttribute("data-open") || "";
  if (!raw || !window.agent?.openExternal) return;
  if (a.getAttribute("data-local") === "1" && localLinkExists.get(linkKey(raw)) === false) {
    unwrapLocalLink(a);
    return;
  }
  void window.agent.openExternal(raw).then((res) => {
    if (res.ok) return;
    if (
      a.isConnected &&
      a.getAttribute("data-local") === "1" &&
      (res.error || "").startsWith("Path not found")
    ) {
      localLinkExists.set(linkKey(raw), false);
      unwrapLocalLink(a);
      return;
    }
    setStatus(res.error || "无法打开链接", true);
  });
});

window.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    findScope = explainApi?.focusInside() ? "explain" : "main";
    openFindBar();
    return;
  }
  if (ev.key !== "Escape") return;
  const action = escapeAction({
    handled: ev.defaultPrevented,
    composing: ev.isComposing,
    dialogOpen: configDialog.open,
    findOpen: !findBar.hidden || Boolean(explainApi && !explainApi.findBar.hidden),
    taskPanelOpen: taskPanelOpen && !taskPanelEl.hidden,
    viewingRun: Boolean(pageRun()?.gate.isRunning),
  });
  if (action === "none") return;
  ev.preventDefault();
  if (action === "close-find") {
    closeFindBar();
  } else if (action === "close-tasks") {
    taskPanelOpen = false;
    syncTaskChrome();
  } else {
    requestStop();
  }
});

type FindHighlight = { add(range: Range): void; clear(): void };
const findHits = new Highlight() as unknown as FindHighlight;
const findCurrent = new Highlight() as unknown as FindHighlight;
(CSS.highlights as unknown as { set(name: string, highlight: FindHighlight): void }).set(
  "find-hit",
  findHits,
);
(CSS.highlights as unknown as { set(name: string, highlight: FindHighlight): void }).set(
  "find-current",
  findCurrent,
);

let findRanges: Range[] = [];
let findIndex = 0;
let findTimer = 0;
let findScope: "main" | "explain" = "main";

function findUi(): { bar: HTMLElement; input: HTMLInputElement; count: HTMLElement } {
  if (findScope === "explain" && explainApi) {
    return { bar: explainApi.findBar, input: explainApi.findInput, count: explainApi.findCount };
  }
  return { bar: findBar, input: findInput, count: findCount };
}

function findRoot(): HTMLElement {
  if (findScope === "explain" && explainApi?.searchRoot()) return explainApi.searchRoot()!;
  if (skillsPageOpen) return skillsPage;
  return activeView === "chat" ? messagesEl : storeView;
}

function clearFindPaint(): void {
  findHits.clear();
  findCurrent.clear();
  findRanges = [];
  findCount.textContent = "";
  if (explainApi) explainApi.findCount.textContent = "";
}

function collectFindRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? "";
    const folded = text.toLowerCase();
    if (folded.length === text.length && needle) {
      let from = 0;
      while (from < folded.length) {
        const at = folded.indexOf(needle, from);
        if (at < 0) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        from = at + needle.length;
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

function revealFindRange(range: Range): void {
  const details: HTMLDetailsElement[] = [];
  let node: Node | null = range.startContainer;
  while (node) {
    if (node instanceof HTMLDetailsElement && !node.open) details.push(node);
    node = node.parentNode;
  }
  for (const el of details.reverse()) el.open = true;
}

function scrollFindRange(container: HTMLElement, range: Range): void {
  revealFindRange(range);
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 8) return;
  container.scrollTop += rect.top - box.top - box.height / 3;
}

function paintFind(scroll: boolean): void {
  findHits.clear();
  findCurrent.clear();
  const ui = findUi();
  const query = ui.input.value;
  if (!query) {
    findRanges = [];
    ui.count.textContent = "";
    return;
  }
  if (findIndex >= findRanges.length) findIndex = 0;
  findRanges.forEach((range, i) => {
    if (i === findIndex) findCurrent.add(range);
    else findHits.add(range);
  });
  if (!findRanges.length) {
    ui.count.textContent = "无匹配";
    return;
  }
  ui.count.textContent = `${findIndex + 1}/${findRanges.length}`;
  if (scroll) scrollFindRange(findRoot(), findRanges[findIndex]!);
}

function runFind(resetIndex: boolean, scroll = true): void {
  const ui = findUi();
  const query = ui.input.value;
  ui.input.placeholder =
    findScope === "explain" || activeView === "chat" && !skillsPageOpen ? "搜索对话内容" : "搜索当前页";
  if (!query) {
    clearFindPaint();
    return;
  }
  findRanges = collectFindRanges(findRoot(), query);
  if (resetIndex || findIndex >= findRanges.length) findIndex = 0;
  paintFind(scroll);
}

function stepFind(delta: number): void {
  if (!findRanges.length) {
    runFind(true);
    return;
  }
  findIndex = (findIndex + delta + findRanges.length) % findRanges.length;
  paintFind(true);
}

function openFindBar(): void {
  findBar.hidden = findScope === "explain";
  if (explainApi) explainApi.findBar.hidden = findScope !== "explain";
  const ui = findUi();
  ui.bar.hidden = false;
  ui.input.placeholder =
    findScope === "explain" || (activeView === "chat" && !skillsPageOpen) ? "搜索对话内容" : "搜索当前页";
  ui.input.focus();
  ui.input.select();
  if (ui.input.value) runFind(false);
}

function closeFindBar(): void {
  findBar.hidden = true;
  if (explainApi) explainApi.findBar.hidden = true;
  clearFindPaint();
  findIndex = 0;
}

findInput.addEventListener("input", () => runFind(true));
findInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    stepFind(ev.shiftKey ? -1 : 1);
  }
});
document.getElementById("find-next")!.addEventListener("click", () => stepFind(1));
document.getElementById("find-prev")!.addEventListener("click", () => stepFind(-1));
document.getElementById("find-close")!.addEventListener("click", () => closeFindBar());

const findObserver = new MutationObserver(() => {
  const ui = findUi();
  if (ui.bar.hidden || !ui.input.value) return;
  if (findTimer) cancelAnimationFrame(findTimer);
  findTimer = requestAnimationFrame(() => {
    findTimer = 0;
    runFind(false, false);
  });
});
findObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });
findObserver.observe(storeView, { childList: true, subtree: true, characterData: true });
findObserver.observe(document.getElementById("explain-conversation")!, {
  childList: true,
  subtree: true,
  characterData: true,
});

function promptOnScreen(run: RunPaint): boolean {
  return run.sessionId === currentSessionId && sameWorkspace(run.workspace, viewWorkspace);
}

function paintPrompt(run: RunPaint): void {
  if (!promptOnScreen(run)) {
    syncTaskbarAttention();
    return;
  }
  permissionDock.innerHTML = "";
  const prompt = run.prompt;
  if (!prompt) {
    permissionDock.hidden = true;
    syncTaskbarAttention();
    return;
  }
  if (prompt.kind === "permission") {
    appendPermissionCard(permissionDock, {
      requestId: prompt.requestId,
      tool: prompt.tool,
      summary: prompt.summary,
      command: prompt.command,
      onAllow: () => {
        void window.agent.respondPermission(prompt.requestId, "allow");
      },
      onDeny: () => {
        void window.agent.respondPermission(prompt.requestId, "deny");
      },
      onStop: () => {
        requestStop();
      },
    });
  } else {
    appendAskCard(permissionDock, {
      requestId: prompt.requestId,
      question: prompt.question,
      options: prompt.options,
      onAnswer: (text) => {
        void answerPending(text);
      },
      onCancel: () => {
        requestStop();
      },
    });
  }
  permissionDock.hidden = false;
  syncLiveDock();
  if (prompt.kind === "ask") inputEl.focus();
}

function recordLivePrompt(
  e: {
    type: string;
    request_id: string;
    tool?: string;
    summary?: string;
    command?: string;
    question?: string;
    options?: string[];
  },
  run: RunPaint,
): void {
  if (run.streamingEl && run.streamBuffer) paintStreamRich(true, run);
  resetStreamTarget(null, run);
  if (e.type === "permission_request") {
    run.pendingAsk = null;
    run.prompt = {
      kind: "permission",
      requestId: e.request_id,
      tool: e.tool ?? "",
      summary: e.summary ?? "",
      command: e.command,
    };
    showRunStatus("等待确认权限…", run);
  } else {
    run.pendingAsk = { requestId: e.request_id };
    run.prompt = {
      kind: "ask",
      requestId: e.request_id,
      question: e.question ?? "",
      options: e.options ?? [],
    };
    showRunStatus("等你回答…", run);
  }
  paintPrompt(run);
  updateChrome();
  void refreshSessions();
}

function runStatusText(reason: string): string {
  if (reason === "max_steps") return "已达步数上限，可继续或改指令";
  if (reason === "cancelled") return "已停止";
  if (reason === "error") return "出错";
  return "完成";
}

function applyTranscript(host: HTMLElement, e: {
  type: string;
  delta?: string;
  message?: string;
  content?: string;
  is_error?: boolean;
  tool_call?: { id: string; function: { name: string; arguments: string } };
  tool_call_id?: string;
  parent_tool_call_id?: string;
  session_id?: string;
}): boolean {
  const run = drawing;
  if (!run) return false;
  const place = (mutate: () => void) => {
    if (host === messagesEl) keepTail(mutate);
    else mutate();
  };
  if (e.type === "task_notification") {
    if (run.streamingEl && run.streamBuffer) paintStreamRich(true);
    resetStreamTarget(null);
    place(() => appendTaskNotice(host, e.content ?? ""));
    return true;
  }
  if (e.type === "held_user") {
    if (run.streamingEl && run.streamBuffer) paintStreamRich(true);
    resetStreamTarget(null);
    return true;
  }
  if (e.type === "text") {
    if (!run.streamingEl) place(() => resetStreamTarget(appendMessage(host, "assistant", "")));
    run.streamBuffer += e.delta ?? "";
    paintStreamRich(false);
    return true;
  }
  if (e.type === "tool_call" && e.tool_call) {
    const call = e.tool_call;
    const parentId = e.parent_tool_call_id;
    if (!parentId && run.streamingEl && run.streamBuffer) paintStreamRich(true);
    if (!parentId) resetStreamTarget(null);
    place(() => {
      const after = parentId ? anchorForParent(host, parentId) : undefined;
      const body = appendToolStep(host, {
        title: toolCallTitle(call.function.name, call.function.arguments),
        detail: "等待结果…",
        open: true,
        nested: Boolean(parentId),
        after,
        toolCallId: call.id,
        parentToolCallId: parentId,
      });
      const key = toolRowKey(call.id, parentId);
      run.openTools.set(key, body);
      const wrap = stepWrap(body);
      if (wrap) {
        run.toolStepNodes.set(key, wrap);
        if (parentId) run.nestedTails.set(parentId, wrap);
        else run.toolStepNodes.set(call.id, wrap);
      }
      if (!parentId) run.openToolDetail = body;
    });
    return true;
  }
  if (e.type === "tool_result") {
    const detail = (e.content ?? "").slice(0, 4000);
    const key = e.tool_call_id ? toolRowKey(e.tool_call_id, e.parent_tool_call_id) : "";
    const node = key ? run.openTools.get(key) : undefined;
    const fill = (body: HTMLElement) => {
      setToolDetailContent(body, detail);
      const details = body.parentElement instanceof HTMLDetailsElement ? body.parentElement : null;
      const step = stepWrap(body);
      step?.classList.remove("is-pending");
      step?.classList.toggle("is-error", e.is_error === true);
      if (details) details.open = false;
      refreshToolGroup(body.closest(".tool-group"));
      if (key) run.openTools.delete(key);
      if (run.openToolDetail === body) run.openToolDetail = null;
    };
    if (node) {
      place(() => fill(node));
    } else {
      const existing = e.tool_call_id ? rowByToolCall(host, e.tool_call_id, e.parent_tool_call_id) : null;
      const existingBody = existing?.querySelector(".tool-detail");
      if (existingBody instanceof HTMLElement) {
        place(() => fill(existingBody));
      } else {
        place(() => {
          const after = e.parent_tool_call_id ? anchorForParent(host, e.parent_tool_call_id) : undefined;
          const body = appendToolStep(host, {
            title: "工具结果",
            detail,
            open: false,
            error: e.is_error === true,
            nested: Boolean(e.parent_tool_call_id),
            after,
            toolCallId: e.tool_call_id,
            parentToolCallId: e.parent_tool_call_id,
          });
          const wrap = stepWrap(body);
          if (wrap && e.parent_tool_call_id) run.nestedTails.set(e.parent_tool_call_id, wrap);
        });
      }
    }
    return true;
  }
  if (e.type === "error") {
    run.prompt = null;
    run.pendingAsk = null;
    if (promptOnScreen(run)) {
      permissionDock.innerHTML = "";
      permissionDock.hidden = true;
      syncTaskbarAttention();
    }
    place(() => appendMessage(host, "error", e.message ?? ""));
    return true;
  }
  return false;
}

function finishRun(run: RunPaint, reason: string, onScreen: boolean): void {
  const host = run.streamingEl?.closest(".messages");
  if (reason === "cancelled" && run.streamingEl && !run.streamBuffer.trim()) {
    run.streamingEl.textContent = CANCELLED_TURN_NOTICE;
    run.streamingEl.closest(".msg")?.classList.add("is-cancelled");
    const questions = host?.querySelectorAll(":scope > .turn > .msg.user .msg-body, :scope > .msg.user .msg-body");
    const asked = questions?.[questions.length - 1];
    if (asked instanceof HTMLElement) ensureReask(asked, asked.textContent ?? "");
  } else if (run.streamingEl && run.streamBuffer) {
    paintStreamRich(true, run);
  }
  resetStreamTarget(null, run);
  run.prompt = null;
  run.pendingAsk = null;
  if (onScreen) {
    permissionDock.innerHTML = "";
    permissionDock.hidden = true;
  }
  clearOpenTools(run);
  run.liveStatus = "";
  run.gate = idleGate();
  run.wakeAcceptsInput = false;
  run.stopRequested = false;
  run.slotHeld = true;
  if (onScreen) setStatus(runStatusText(reason), reason !== "completed");
  else if (statusIsRun && currentSessionId === run.sessionId && sameWorkspace(viewWorkspace, run.workspace)) {
    setStatus("", false);
  }
  if (onScreen && currentSessionId) void refreshStoreDock(currentSessionId);
  syncTaskbarAttention();
  updateChrome();
  void refreshSessions();
}

window.agent.onEvent((e) => {
  if (e.type === "session_title") {
    if (currentSessionId === e.session_id && (!e.workspace || sameWorkspace(viewWorkspace, e.workspace))) {
      currentSessionTitle = e.title;
      updateChrome();
    }
    void refreshSessions();
    return;
  }
  const sessionId = typeof e.session_id === "string" ? e.session_id : "";
  const workspace = typeof e.workspace === "string" ? e.workspace : "";
  if (!sessionId || !workspace) return;
  if (e.type === "session_idle") {
    releaseHeldRun(workspace, sessionId);
    return;
  }
  const key = runKeyOf(workspace, sessionId);
  if (releasedRuns.has(key)) return;
  const run = ensureRun(workspace, sessionId);
  run.slotHeld = true;
  const onScreen = sessionId === currentSessionId && sameWorkspace(workspace, viewWorkspace);
  drawing = run;
  try {
    if (
      (e.type === "tool_result" || e.type === "task_notification" || e.type === "done") &&
      onScreen
    ) {
      void refreshTasks();
    }
    if (e.type === "inbox_wake") {
      run.wakeAcceptsInput = onScreen;
      run.gate = beginRun(sessionId);
      if (run.streamingEl && run.streamBuffer) paintStreamRich(true, run);
      resetStreamTarget(null, run);
      if (run.wakeAcceptsInput) showRunStatus("正在把后台结果交给模型", run);
      updateChrome();
      void refreshSessions();
      return;
    }
    const decision = decideEvent(run.gate, onScreen ? currentSessionId : null, e);
    run.gate = decision.next;
    if (!decision.paint && !decision.keep && !decision.stashFor) return;
    if (e.type === "status") {
      showRunStatus(PHASE_LABEL[e.phase] ?? e.phase, run);
      return;
    }
    if (e.type === "ask_user" || e.type === "permission_request") {
      recordLivePrompt(e, run);
      return;
    }
    if (e.type === "done") {
      finishRun(run, e.reason, onScreen);
      return;
    }
    const host = onScreen ? messagesEl : ensureSessionView(runKeyOf(workspace, sessionId)).holder;
    applyTranscript(host, e);
  } finally {
    drawing = null;
  }
});

function refreshVisibleAssistantMarkdown(): void {
  if (pageRun()?.gate.isRunning) return;
  rerenderAllAssistantMarkdown(messagesEl);
}

const floatStack = document.querySelector(".float-stack");
function syncFloatPad(): void {
  const stackH =
    floatStack instanceof HTMLElement
      ? Math.ceil(floatStack.getBoundingClientRect().height) + 12
      : 120;
  const statusH = statusEl.hidden ? 0 : Math.ceil(statusEl.getBoundingClientRect().height) + 8;
  const stick = followTail;
  messagesEl.style.paddingBottom = `${stackH + statusH}px`;
  storeView.style.paddingBottom = `${stackH}px`;
  statusEl.style.bottom = `${stackH}px`;
  if (stick) revealTail();
}
if (floatStack instanceof HTMLElement) {
  new ResizeObserver(syncFloatPad).observe(floatStack);
  syncFloatPad();
}

async function boot(): Promise<void> {
  syncEmptyState();
  updateChrome();
  // Soft reload / HMR: re-paint any bubbles that survived with data-raw-md.
  refreshVisibleAssistantMarkdown();
  if (!window.agent?.restoreWorkspace) return;
  try {
    const restored = await window.agent.restoreWorkspace();
    workspacePaths = restored?.paths ?? [];
    workspaceLabels = restored?.labels ?? {};
    rememberWorkspaceFold(workspacePaths, restored?.collapsed ?? []);
    if (restored?.active) await applyWorkspace(restored.active);
    else {
      await refreshSessions();
      syncEmptyState();
      updateChrome();
    }
  } catch (err) {
    showStatusError(err);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshVisibleAssistantMarkdown();
});

document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t instanceof Element && t.closest(".session-menu, .session-menu-pop")) return;
  closeSessionMenus();
});

treesEl.addEventListener("scroll", () => closeSessionMenus(), { passive: true });
window.addEventListener("resize", () => closeSessionMenus());

explainApi = mountExplainPane();

const explainComposer = document.getElementById("explain-composer");
const sidebarEl = document.getElementById("sidebar");
const mainEl = document.getElementById("main");

/** One tall composer at a time. The sidebar counts as the main conversation. */
function setActiveComposer(which: "main" | "explain"): void {
  const explainOpen = Boolean(explainPane && !explainPane.hidden);
  const active = which === "explain" && explainOpen ? "explain" : "main";
  composerEl.classList.toggle("is-compact", explainOpen && active !== "main");
  explainComposer?.classList.toggle("is-compact", active !== "explain");
  mainEl?.classList.toggle("is-scrollbar-off", explainOpen && active !== "main");
  explainPane?.classList.toggle("is-scrollbar-off", explainOpen && active !== "explain");
}

setActiveComposer("main");
document.addEventListener(
  "click",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (explainPane && !explainPane.hidden && explainPane.contains(target)) {
      setActiveComposer("explain");
      return;
    }
    if ((sidebarEl && sidebarEl.contains(target)) || (mainEl && mainEl.contains(target))) {
      setActiveComposer("main");
    }
  },
  true,
);
document.addEventListener("focusin", (ev) => {
  const target = ev.target;
  if (!(target instanceof Node)) return;
  if (explainPane && !explainPane.hidden && explainPane.contains(target)) setActiveComposer("explain");
  else if ((sidebarEl && sidebarEl.contains(target)) || (mainEl && mainEl.contains(target))) {
    setActiveComposer("main");
  }
});
if (explainPane) {
  new MutationObserver(() => {
    if (explainPane.hidden) setActiveComposer("main");
  }).observe(explainPane, { attributes: true, attributeFilter: ["hidden"] });
}
explainApi.findInput.addEventListener("input", () => {
  findScope = "explain";
  runFind(true);
});
explainApi.findInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  findScope = "explain";
  stepFind(ev.shiftKey ? -1 : 1);
});
explainApi.findNext.addEventListener("click", () => {
  findScope = "explain";
  stepFind(1);
});
explainApi.findPrev.addEventListener("click", () => {
  findScope = "explain";
  stepFind(-1);
});
explainApi.findClose.addEventListener("click", () => closeFindBar());
window.addEventListener("resize", () => {
  if (explainApi && !explainApi.pane.hidden) explainApi.sync(currentSessionId, viewWorkspace ?? activeWorkspace);
});

mountQuestionNav(document.getElementById("question-nav")!, messagesEl);

void boot();
