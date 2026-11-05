import {
  appendAskCard,
  appendMessage,
  appendPermissionCard,
  appendToolStep,
  escapeHtml,
  renderEmptyState,
  rerenderAllAssistantMarkdown,
  setRichText,
  setToolDetailContent,
} from "./ui.js";
import { beginRun, decideEvent, idleGate, type RunGate } from "./runEventGate.js";

declare global {
  interface Window {
    agent: {
      getWorkspace(): Promise<string | null>;
      restoreWorkspace(): Promise<{
        active: string | null;
        paths: string[];
        labels: Record<string, string>;
      }>;
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
          role: string;
          content: string;
          name?: string;
          is_error?: boolean;
          tool_call_arguments?: string;
          images?: Array<{ path: string }>;
        }>
      >;
      loadWorkspaceArtifacts(
        path: string,
        sessionId: string,
      ): Promise<{
        meta: Record<string, unknown>;
        messages: unknown[];
        traces: unknown[];
        context: string;
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
          role: string;
          content: string;
          name?: string;
          is_error?: boolean;
          tool_call_arguments?: string;
          images?: Array<{ path: string }>;
        }>
      >;
      loadSessionArtifacts(sessionId: string): Promise<{
        meta: Record<string, unknown>;
        messages: unknown[];
        traces: unknown[];
        context: string;
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
      ): Promise<void>;
      readSessionImage(sessionId: string, relativePath: string): Promise<string>;
      cancel(): Promise<void>;
      respondPermission(requestId: string, decision: "allow" | "deny"): Promise<boolean>;
      answerAsk(requestId: string, text: string): Promise<boolean>;
      getConfig(): Promise<any>;
      saveConfig(cfg: any): Promise<void>;
      openExternal(target: string): Promise<{ ok: boolean; error?: string }>;
      popupAppMenu(index: number, x: number, y: number): Promise<void>;
      onEvent(cb: (e: any) => void): () => void;
    };
  }
}

const messagesEl = document.getElementById("messages")!;
const treesEl = document.getElementById("workspace-trees")!;
const statusEl = document.getElementById("status")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const btnNew = document.getElementById("btn-new") as HTMLButtonElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;
const btnImage = document.getElementById("btn-image") as HTMLButtonElement;
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
const pageCtxMenu = document.getElementById("page-ctx-menu")!;
const pageCtxCopy = pageCtxMenu.querySelector('[data-ctx="copy"]') as HTMLButtonElement;

let currentSessionId: string | null = null;
let currentSessionTitle = "";
let streamingEl: HTMLElement | null = null;
/** Raw markdown accumulated during stream — never read back from DOM after rich render. */
let streamBuffer = "";
let streamRaf = 0;
let openToolDetail: HTMLElement | null = null;
/** Live tool bars keyed by tool_call id. One slot used to leave earlier bars on「等待结果…」. */
const openTools = new Map<string, HTMLElement>();
let runGate: RunGate = idleGate();
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
/** Live transcript moved here while the user looks at another session. */
const runBoard = document.createElement("div");
let runParked = false;
let parkedSessionId: string | null = null;
let isRunning = false;
let creatingSession = false;
let pendingAsk: { requestId: string } | null = null;

type StoreTab = "meta" | "messages" | "trace" | "context";
type MainView = "chat" | StoreTab;
let activeView: MainView = "chat";
let activeStoreTab: StoreTab = "meta";
let sessionArtifacts: {
  meta: Record<string, unknown>;
  messages: unknown[];
  traces: unknown[];
  context: string;
} | null = null;
const STORE_STRING_PREVIEW = 1600;

function cancelStreamRichPaint(): void {
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
}

function paintStreamRich(immediate = false): void {
  if (!streamingEl) return;
  const paint = () => {
    streamRaf = 0;
    if (!streamingEl) return;
    setRichText(streamingEl, streamBuffer, true);
    if (streamingEl.closest("#messages")) messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  if (immediate) {
    cancelStreamRichPaint();
    paint();
    return;
  }
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(paint);
}

function resetStreamTarget(el: HTMLElement | null = null): void {
  cancelStreamRichPaint();
  streamingEl = el;
  streamBuffer = "";
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
  if (!findBar.hidden) runFind(true);
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
  } else {
    paintContextEntries(sessionArtifacts.context ?? "");
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
  const className = item.role === "user" ? "is-user" : item.is_error === true ? "is-error" : "";
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
  if (type === "tool_result") {
    const tool = recordString(detail, "tool");
    if (tool) bits.push(tool);
    if (detail.is_error === true) bits.push("错误");
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

function contextEntrySummary(row: Record<string, unknown> | null, index: number): string {
  if (!row) return `第 ${index + 1} 条 · 无法解析`;
  if (row.type === "tools") {
    const sha = typeof row.sha256 === "string" ? row.sha256.slice(0, 12) : "";
    const n = Array.isArray(row.tools) ? row.tools.length : 0;
    const count = n ? ` · ${n} 个工具` : "";
    return `工具表${sha ? ` · ${sha}` : ""}${count}`;
  }
  if (row.type === "request") {
    const id = typeof row.id === "string" ? row.id : "";
    const n = Array.isArray(row.messages) ? row.messages.length : 0;
    // Row field is `id`. trace.jsonl stores that same value as context_id.
    return id ? `context_id ${id} · ${n} 条消息` : `请求 · ${n} 条消息`;
  }
  return `第 ${index + 1} 条`;
}

function oneLinePreview(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function contextPre(text: string): HTMLPreElement {
  const body = document.createElement("pre");
  body.className = "context-entry-body";
  body.textContent = text;
  return body;
}

function contextMessageSummary(row: Record<string, unknown>, index: number): string {
  const role = typeof row.role === "string" ? row.role : "未知";
  const name = typeof row.name === "string" ? row.name : "";
  const who = name ? `${role} ${name}` : role;
  const calls = toolCallNames(row.tool_calls);
  const text = typeof row.text === "string" ? row.text : "";
  if (!text.trim() && calls.length) {
    return `${index + 1} · ${who} · ${calls.join(", ")}`;
  }
  const preview = oneLinePreview(text);
  return preview ? `${index + 1} · ${who} · ${preview}` : `${index + 1} · ${who}`;
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

function contextMessageBody(row: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof row.tool_call_id === "string" && row.tool_call_id) {
    parts.push(`tool_call_id ${row.tool_call_id}`);
  }
  if (typeof row.text === "string" && row.text) parts.push(row.text);
  if (Array.isArray(row.images) && row.images.length) {
    const lines = row.images.map((image) => {
      if (!image || typeof image !== "object") return String(image);
      const path = typeof (image as { path?: unknown }).path === "string" ? (image as { path: string }).path : "";
      const bytes = (image as { bytes?: unknown }).bytes;
      return `${path || "图片"}${typeof bytes === "number" ? ` · ${bytes} 字节` : ""}`;
    });
    parts.push(lines.join("\n"));
  }
  if (Array.isArray(row.tool_calls) && row.tool_calls.length) {
    parts.push(JSON.stringify(row.tool_calls, null, 2));
  }
  return parts.join("\n\n") || "（无正文）";
}

function renderContextMessage(message: unknown, index: number): HTMLElement {
  const entry = document.createElement("details");
  entry.className = "context-msg";
  const summary = document.createElement("summary");
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    summary.textContent = `${index + 1} · 无法解析`;
    entry.append(summary, contextPre(typeof message === "string" ? message : JSON.stringify(message, null, 2)));
    return entry;
  }
  const row = message as Record<string, unknown>;
  summary.textContent = contextMessageSummary(row, index);
  entry.append(summary, contextPre(contextMessageBody(row)));
  return entry;
}

function renderContextRequest(row: Record<string, unknown>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "context-request";
  const sha = typeof row.tools_sha256 === "string" ? row.tools_sha256 : "";
  const bits = [
    typeof row.turn_id === "string" ? `turn_id ${row.turn_id}` : "",
    typeof row.model === "string" ? row.model : "",
    sha ? `tools_sha256 ${sha.slice(0, 12)}` : "",
  ].filter(Boolean);
  if (bits.length) {
    const meta = document.createElement("div");
    meta.className = "context-meta";
    meta.textContent = bits.join(" · ");
    if (sha) meta.title = sha;
    wrap.append(meta);
  }
  const messages = Array.isArray(row.messages) ? row.messages : null;
  const msgList = document.createElement("div");
  msgList.className = "context-messages";
  if (!messages) {
    msgList.append(contextPre(JSON.stringify(row, null, 2)));
  } else if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "context-meta";
    empty.textContent = "没有消息";
    msgList.append(empty);
  } else {
    messages.forEach((message, index) => msgList.append(renderContextMessage(message, index)));
  }
  wrap.append(msgList);
  return wrap;
}

function toolRecord(tool: unknown): { name: string; description: string; parameters: unknown } | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return null;
  const rec = fn as { name?: unknown; description?: unknown; parameters?: unknown };
  return {
    name: typeof rec.name === "string" && rec.name ? rec.name : "未命名工具",
    description: typeof rec.description === "string" ? rec.description : "",
    parameters: rec.parameters,
  };
}

function renderContextTools(row: Record<string, unknown>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "context-messages";
  const tools = Array.isArray(row.tools) ? row.tools : null;
  if (!tools) {
    wrap.append(contextPre(JSON.stringify(row, null, 2)));
    return wrap;
  }
  for (const tool of tools) {
    const entry = document.createElement("details");
    entry.className = "context-msg";
    const summary = document.createElement("summary");
    const rec = toolRecord(tool);
    summary.textContent = rec?.name ?? "未命名工具";
    const body = rec
      ? [rec.description, rec.parameters !== undefined ? JSON.stringify(rec.parameters, null, 2) : ""]
          .filter(Boolean)
          .join("\n\n") || "（无说明）"
      : JSON.stringify(tool, null, 2);
    entry.append(summary, contextPre(body));
    wrap.append(entry);
  }
  return wrap;
}

function paintContextEntries(raw: string): void {
  const lines = raw.split("\n").filter((line) => line.trim());
  storeHint.textContent = `${lines.length} 条 · context.jsonl · 点开后按消息拆开`;
  storeView.replaceChildren();
  if (!lines.length) return;
  const list = document.createElement("div");
  list.className = "context-list";
  lines.forEach((line, index) => {
    let row: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        row = parsed as Record<string, unknown>;
      }
    } catch {
      row = null;
    }
    const entry = document.createElement("details");
    entry.className = "context-entry";
    const summary = document.createElement("summary");
    summary.textContent = contextEntrySummary(row, index);
    entry.append(summary);
    if (!row) entry.append(contextPre(line));
    else if (row.type === "request") entry.append(renderContextRequest(row));
    else if (row.type === "tools") entry.append(renderContextTools(row));
    else entry.append(contextPre(JSON.stringify(row, null, 2)));
    list.append(entry);
  });
  storeView.append(list);
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
    const msgTab = storeTabs.querySelector('[data-store-tab="messages"]');
    const trTab = storeTabs.querySelector('[data-store-tab="trace"]');
    if (msgTab) {
      msgTab.textContent = `messages.jsonl (${sessionArtifacts.messages.length})`;
    }
    if (trTab) {
      trTab.textContent = `trace.jsonl (${sessionArtifacts.traces.length})`;
    }
    const ctxTab = storeTabs.querySelector('[data-store-tab="context"]');
    if (ctxTab) {
      const n = (sessionArtifacts.context ?? "").split("\n").filter((line) => line.trim()).length;
      ctxTab.textContent = `context.jsonl (${n})`;
    }
    const metaTab = storeTabs.querySelector('[data-store-tab="meta"]');
    if (metaTab) metaTab.textContent = "meta.json";
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

mainTitle.addEventListener("click", () => setMainView("chat"));
for (const btn of storeTabButtons()) {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.storeTab as StoreTab | undefined;
    if (tab === "meta" || tab === "messages" || tab === "trace" || tab === "context") setMainView(tab);
  });
}
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-app-menu]"))) {
  btn.addEventListener("click", () => {
    const index = Number(btn.dataset.appMenu);
    if (!Number.isInteger(index) || !window.agent?.popupAppMenu) return;
    const rect = btn.getBoundingClientRect();
    void window.agent.popupAppMenu(
      index,
      Math.round(window.screenX + rect.left),
      Math.round(window.screenY + rect.bottom),
    );
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
  const root = activeView === "chat" ? messagesEl : storeView;
  const selected = selectionTextIn(root);
  if (selected) return selected;
  if (activeView !== "chat") return (storeView.textContent || "").trim();
  return (root.innerText || root.textContent || "").trim();
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
  ev.preventDefault();
  showPageCtxMenu(ev.clientX, ev.clientY);
}

messagesEl.addEventListener("contextmenu", onPageContextMenu);
storeView.addEventListener("contextmenu", onPageContextMenu);
pageCtxCopy.addEventListener("click", (ev) => {
  ev.preventDefault();
  hidePageCtxMenu();
  void copyPageContent();
});
document.addEventListener("click", (ev) => {
  if (pageCtxMenu.hidden) return;
  const t = ev.target;
  if (t instanceof Node && pageCtxMenu.contains(t)) return;
  hidePageCtxMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !pageCtxMenu.hidden) hidePageCtxMenu();
});
window.addEventListener("blur", hidePageCtxMenu);
window.addEventListener("resize", hidePageCtxMenu);
window.addEventListener("scroll", hidePageCtxMenu, true);

btnNew.disabled = true;
btnSend.disabled = true;

const PHASE_LABEL: Record<string, string> = {
  assembling: "整理上下文…",
  llm: "调用模型…",
  tool: "执行工具…",
  awaiting_permission: "等待确认权限…",
  awaiting_user: "等你回答…",
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setStatus(text: string, busy = false): void {
  statusEl.textContent = text || "";
  statusEl.hidden = !busy;
  if (busy) statusEl.removeAttribute("data-idle");
  else statusEl.setAttribute("data-idle", "true");
  syncHomeBar();
}

/** No open session: the title row is the home page the user asked to remove. */
function syncHomeBar(): void {
  const home = !currentSessionId && storeTabs.hidden;
  mainTitle.hidden = home;
  mainBar.hidden = home && statusEl.hidden;
}

function showStatusError(err: unknown): void {
  setStatus(errText(err), true);
}

function showChatError(err: unknown): void {
  const msg = errText(err);
  setStatus(msg, true);
  appendMessage(messagesEl, "error", msg);
}

function clearOpenTools(): void {
  openTools.clear();
  openToolDetail = null;
}

function toolCallTitle(name: string, argsJson: string): string {
  let hint = "";
  try {
    const args = JSON.parse(argsJson) as {
      query?: unknown;
      command?: unknown;
      question?: unknown;
    };
    const raw = String(args.question ?? args.query ?? args.command ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (raw) hint = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
  } catch {
    hint = "";
  }
  return hint ? `调用 ${name} · ${hint}` : `调用 ${name}`;
}

function sameWorkspace(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function viewingRun(): boolean {
  return !isRunning || currentSessionId === runGate.runSessionId;
}

function workspaceLabel(path: string): string {
  const key = Object.keys(workspaceLabels).find((item) => item.toLowerCase() === path.toLowerCase());
  const custom = key ? workspaceLabels[key].trim() : "";
  return custom || folderName(path);
}

function updateChrome(): void {
  mainTitle.textContent = currentSessionId ? currentSessionTitle || "会话" : "";
  syncHomeBar();
  const asking = Boolean(pendingAsk) && viewingRun();
  const onRun = viewingRun();
  const lockedOut = isRunning && !onRun;
  const canCompose = hasWorkspace && onRun && !asking && !isRunning && !creatingSession;
  btnSend.disabled = lockedOut ? true : asking || (isRunning && onRun) ? false : !canCompose;
  btnSend.textContent = lockedOut ? "发送" : asking ? "回答" : isRunning && onRun ? "停止" : "发送";
  btnSend.classList.toggle("is-stop", isRunning && onRun && !asking);
  btnSend.setAttribute(
    "aria-label",
    lockedOut ? "发送已禁用" : asking ? "回答" : isRunning && onRun ? "停止" : "发送",
  );
  btnNew.disabled = !hasWorkspace || creatingSession;
  inputEl.disabled = lockedOut || creatingSession || (isRunning && !asking);
  composerEl.classList.toggle("is-locked", lockedOut);
  inputEl.placeholder = lockedOut
    ? "有会话正在执行，不能在这里输入"
    : asking
      ? "回答上面的问题… Enter 发送，Shift+Enter 换行"
      : "向 Agent 下指令… Enter 发送，Shift+Enter 换行";
  btnImage.disabled = !canCompose;
  syncImageRemoveLock();
  syncLiveDock();
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

function parkRun(): void {
  if (!isRunning || !currentSessionId || currentSessionId !== runGate.runSessionId) return;
  if (runParked) return;
  while (messagesEl.firstChild) runBoard.appendChild(messagesEl.firstChild);
  runParked = true;
  parkedSessionId = currentSessionId;
}

function takeParkedRun(sessionId: string): boolean {
  if (!runParked || parkedSessionId !== sessionId) return false;
  messagesEl.replaceChildren();
  while (runBoard.firstChild) messagesEl.appendChild(runBoard.firstChild);
  runParked = false;
  parkedSessionId = null;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return true;
}

function discardParkedRun(): void {
  runBoard.replaceChildren();
  runParked = false;
  parkedSessionId = null;
}

function setRunning(v: boolean): void {
  isRunning = v;
  updateChrome();
}

function noteRunFinished(): void {
  if (!viewWorkspace || sameWorkspace(viewWorkspace, activeWorkspace)) return;
  const next = viewWorkspace;
  void (async () => {
    try {
      await window.agent.activateWorkspace(next);
      activeWorkspace = next;
      await refreshSessions();
      updateChrome();
    } catch (err) {
      showStatusError(err);
    }
  })();
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
  if (pendingAsk) {
    pendingAsk = null;
    updateChrome();
  }
}

function syncLiveDock(): void {
  const show = isRunning && viewingRun() && permissionDock.childElementCount > 0;
  permissionDock.hidden = !show;
}

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
  if (!text || !pendingAsk) return;
  const requestId = pendingAsk.requestId;
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
  if (isRunning && path === activeWorkspace) {
    setStatus("请先停止当前任务再移除工作区", true);
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
      if (isRunning && currentSessionId === runGate.runSessionId) parkRun();
      currentSessionId = null;
      viewWorkspace = result.active;
      currentSessionTitle = "";
      if (!isRunning) {
        resetStreamTarget(null);
        clearOpenTools();
        clearPermissionDock();
      }
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
  row.append(pathBtn, chevron, more);
  block.append(row, ul);
  treesEl.appendChild(block);
  return ul;
}

function toggleWorkspaceList(path: string, open: boolean): void {
  workspaceExpanded.set(path, !open);
  void refreshSessions();
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
  for (const workspace of workspacePaths) {
    const open = workspaceExpanded.get(workspace) !== false;
    const listEl = mountWorkspaceTree(workspace, open);
    if (!open) continue;
    try {
      const sessions = await window.agent.listWorkspaceSessions(workspace);
      for (const s of sessions) {
      const li = document.createElement("li");
      li.className = "session-item";
      const viewingThis =
        s.session_id === currentSessionId && sameWorkspace(workspace, viewWorkspace);
      if (viewingThis) li.classList.add("active");
      const executing =
        isRunning &&
        s.session_id === runGate.runSessionId &&
        sameWorkspace(workspace, activeWorkspace);

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
          if (isRunning && workspace !== activeWorkspace) {
            restoreLabel();
            setStatus("请先停止当前任务再改其他工作区的会话", true);
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
        if (isRunning && s.session_id === runGate.runSessionId) {
          setStatus("请先停止当前任务再删除正在执行的会话", true);
          return;
        }
        if (isRunning && !sameWorkspace(workspace, activeWorkspace)) {
          setStatus("请先停止当前任务再改其他工作区的会话", true);
          return;
        }
        try {
          await window.agent.deleteWorkspaceSession(workspace, s.session_id);
          forgetComposer(workspace, s.session_id);
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
      if (executing) {
        const mark = document.createElement("span");
        mark.className = "session-running";
        mark.textContent = "执行中";
        li.append(label, mark, menu);
      } else {
        li.append(label, menu);
      }
      listEl.appendChild(li);
      }
    } catch (err) {
      showStatusError(err);
    }
  }
}

async function showSession(workspace: string, sessionId: string, title: string): Promise<void> {
  if (sessionId === currentSessionId && sameWorkspace(workspace, viewWorkspace)) return;
  rememberComposer();
  const leavingRun =
    isRunning &&
    currentSessionId === runGate.runSessionId &&
    sameWorkspace(viewWorkspace, activeWorkspace);
  if (leavingRun) parkRun();
  try {
    if (!isRunning && !sameWorkspace(workspace, activeWorkspace)) {
      await window.agent.activateWorkspace(workspace);
      activeWorkspace = workspace;
      hasWorkspace = true;
    }
    viewWorkspace = workspace;
    currentSessionId = sessionId;
    currentSessionTitle = title || "会话";
    restoreComposer();
    setMainView("chat");
    if (takeParkedRun(sessionId)) void refreshStoreDock(sessionId);
    else await loadCurrent();
    await refreshSessions();
    updateChrome();
  } catch (err) {
    showStatusError(err);
  }
}

async function showNewPage(): Promise<void> {
  if (!hasWorkspace) {
    setStatus("请先选择工作区", true);
    return;
  }
  if (creatingSession) return;
  if (!currentSessionId && sameWorkspace(viewWorkspace, activeWorkspace)) {
    if (!inputEl.disabled) inputEl.focus();
    return;
  }
  rememberComposer();
  if (
    isRunning &&
    currentSessionId === runGate.runSessionId &&
    sameWorkspace(viewWorkspace, activeWorkspace)
  ) {
    parkRun();
  }
  currentSessionId = null;
  viewWorkspace = activeWorkspace;
  currentSessionTitle = "";
  if (!isRunning) {
    resetStreamTarget(null);
    clearOpenTools();
    clearPermissionDock();
  }
  hideStoreDock();
  messagesEl.innerHTML = "";
  setMainView("chat");
  restoreComposer();
  await refreshSessions();
  syncEmptyState();
  setStatus("", false);
  updateChrome();
  if (!inputEl.disabled) inputEl.focus();
}

async function loadCurrent(): Promise<void> {
  messagesEl.innerHTML = "";
  if (!runParked) {
    resetStreamTarget(null);
    clearOpenTools();
  }
  if (!isRunning) clearPermissionDock();
  if (!currentSessionId) {
    hideStoreDock();
    syncEmptyState();
    updateChrome();
    return;
  }
  void refreshStoreDock(currentSessionId);
  messagesEl.classList.add("is-restoring");
  try {
    const msgs =
      viewWorkspace && !sameWorkspace(viewWorkspace, activeWorkspace)
        ? await window.agent.loadWorkspaceMessages(viewWorkspace, currentSessionId)
        : await window.agent.loadMessages(currentSessionId);
    if (!msgs.length) {
      renderEmptyState(messagesEl, "idle");
      return;
    }
    for (const m of msgs) {
      if (m.role === "tool" && m.name === "ask_user") {
        const question = askQuestion(m.tool_call_arguments);
        if (question) {
          appendToolStep(messagesEl, {
            title: `提问 · ${question}`,
            detail: m.is_error ? m.content.slice(0, 4000) : "已回答",
            open: false,
          });
        }
        if (!m.is_error) appendMessage(messagesEl, "user", m.content);
        else if (!question) {
          appendToolStep(messagesEl, {
            title: "提问",
            detail: m.content.slice(0, 4000),
            open: false,
          });
        }
      } else if (m.role === "tool") {
        appendToolStep(messagesEl, {
          title: `工具结果${m.name ? ` · ${m.name}` : ""}`,
          detail: m.content.slice(0, 4000),
          open: false,
        });
      } else if (m.role === "assistant") {
        appendMessage(messagesEl, "assistant", m.content, { rich: true });
      } else {
        const urls = await imageDataUrls(viewWorkspace, currentSessionId, m.images);
        appendMessage(messagesEl, m.role, m.content, urls.length ? { images: urls } : undefined);
      }
    }
    // Force a second pass so opening a session always uses the latest renderer.
    rerenderAllAssistantMarkdown(messagesEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
  resetStreamTarget(null);
  clearOpenTools();
  runGate = idleGate();
  setRunning(false);
  clearPermissionDock();
  hideStoreDock();
  messagesEl.innerHTML = "";
  await refreshSessions();
  setStatus("", false);
  syncEmptyState();
  updateChrome();
}

document.getElementById("btn-workspace")!.onclick = async () => {
  if (!window.agent?.addWorkspace) {
    setStatus("预加载失败：window.agent 不可用，请重启应用", true);
    return;
  }
  if (isRunning) {
    setStatus("请先停止当前任务再增加工作区", true);
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
    setStatus("配置已保存");
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

async function sendMessage(): Promise<void> {
  if (pendingAsk && viewingRun()) {
    await answerPending(inputEl.value);
    return;
  }
  if (isRunning || creatingSession) return;
  const text = inputEl.value.trim();
  const images = pendingImages.slice();
  if (!text && images.length === 0) return;
  const draftKey = currentComposerKey();
  try {
    if (viewWorkspace && !sameWorkspace(viewWorkspace, activeWorkspace)) {
      await window.agent.activateWorkspace(viewWorkspace);
      activeWorkspace = viewWorkspace;
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
  discardParkedRun();
  if (messagesEl.querySelector(".empty-state")) messagesEl.innerHTML = "";
  appendMessage(messagesEl, "user", text, {
    images: images.map((image) => image.previewUrl),
  });
  resetStreamTarget(appendMessage(messagesEl, "assistant", ""));
  clearOpenTools();
  setStatus("运行中…", true);
  setRunning(true);
  runGate = beginRun(sessionId);
  try {
    await window.agent.submit(
      sessionId,
      text,
      images.length
        ? images.map((image) => ({ mime: image.mime, base64: image.base64 }))
        : undefined,
    );
  } catch (err) {
    runGate = idleGate();
    setRunning(false);
    showChatError(err);
  }
}

btnSend.onclick = () => {
  if (pendingAsk && viewingRun()) {
    void answerPending(inputEl.value);
    return;
  }
  if (isRunning && viewingRun()) {
    void (async () => {
      try {
        await window.agent.cancel();
        setStatus("已请求停止", true);
      } catch (err) {
        showStatusError(err);
      }
    })();
    return;
  }
  void sendMessage();
};

inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void sendMessage();
  }
});
inputEl.addEventListener("input", () => rememberComposer());

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

messagesEl.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const a = t.closest("a.md-link");
  if (!a) return;
  ev.preventDefault();
  const raw = a.getAttribute("data-open") || "";
  if (!raw || !window.agent?.openExternal) return;
  void window.agent.openExternal(raw).then((res) => {
    if (!res.ok) setStatus(res.error || "无法打开链接", true);
  });
});

window.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    openFindBar();
    return;
  }
  if (ev.key === "Escape" && !findBar.hidden) {
    ev.preventDefault();
    closeFindBar();
    return;
  }
  if (ev.key === "Escape" && isRunning) {
    void window.agent.cancel();
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

function findRoot(): HTMLElement {
  return activeView === "chat" ? messagesEl : storeView;
}

function clearFindPaint(): void {
  findHits.clear();
  findCurrent.clear();
  findRanges = [];
  findCount.textContent = "";
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
  const query = findInput.value;
  if (!query) {
    findRanges = [];
    findCount.textContent = "";
    return;
  }
  if (findIndex >= findRanges.length) findIndex = 0;
  findRanges.forEach((range, i) => {
    if (i === findIndex) findCurrent.add(range);
    else findHits.add(range);
  });
  if (!findRanges.length) {
    findCount.textContent = "无匹配";
    return;
  }
  findCount.textContent = `${findIndex + 1}/${findRanges.length}`;
  if (scroll) scrollFindRange(findRoot(), findRanges[findIndex]!);
}

function runFind(resetIndex: boolean, scroll = true): void {
  const query = findInput.value;
  findInput.placeholder = activeView === "chat" ? "搜索对话内容" : "搜索当前页";
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
  findBar.hidden = false;
  findInput.placeholder = activeView === "chat" ? "搜索对话内容" : "搜索当前页";
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind(false);
}

function closeFindBar(): void {
  findBar.hidden = true;
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
  if (findBar.hidden || !findInput.value) return;
  if (findTimer) cancelAnimationFrame(findTimer);
  findTimer = requestAnimationFrame(() => {
    findTimer = 0;
    runFind(false, false);
  });
});
findObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });
findObserver.observe(storeView, { childList: true, subtree: true, characterData: true });

function recordLivePrompt(e: {
  type: string;
  request_id: string;
  tool?: string;
  summary?: string;
  command?: string;
  question?: string;
  options?: string[];
}): void {
  if (viewingRun() && streamingEl && streamBuffer) paintStreamRich(true);
  if (viewingRun()) resetStreamTarget(null);
  permissionDock
    .querySelectorAll(`[data-request-id="${CSS.escape(String(e.request_id))}"]`)
    .forEach((n) => n.remove());
  if (e.type === "permission_request") {
    setStatus("等待确认权限…", true);
    appendPermissionCard(permissionDock, {
      requestId: e.request_id,
      tool: e.tool ?? "",
      summary: e.summary ?? "",
      command: e.command,
      onAllow: () => {
        void window.agent.respondPermission(e.request_id, "allow");
      },
      onDeny: () => {
        void window.agent.respondPermission(e.request_id, "deny");
      },
    });
    syncLiveDock();
    return;
  }
  pendingAsk = { requestId: e.request_id };
  setStatus("等你回答…", true);
  appendAskCard(permissionDock, {
    requestId: e.request_id,
    question: e.question ?? "",
    options: e.options ?? [],
    onAnswer: (text) => {
      void answerPending(text);
    },
    onCancel: () => {
      void window.agent.cancel();
    },
  });
  updateChrome();
  if (viewingRun()) inputEl.focus();
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
}): boolean {
  if (e.type === "text") {
    if (!streamingEl) resetStreamTarget(appendMessage(host, "assistant", ""));
    streamBuffer += e.delta ?? "";
    paintStreamRich(false);
    return true;
  }
  if (e.type === "tool_call" && e.tool_call) {
    if (streamingEl && streamBuffer) paintStreamRich(true);
    resetStreamTarget(null);
    const body = appendToolStep(host, {
      title: toolCallTitle(e.tool_call.function.name, e.tool_call.function.arguments),
      detail: "等待结果…",
      open: true,
    });
    openTools.set(e.tool_call.id, body);
    openToolDetail = body;
    return true;
  }
  if (e.type === "tool_result") {
    const detail = (e.content ?? "").slice(0, 4000);
    const node = e.tool_call_id ? openTools.get(e.tool_call_id) : undefined;
    if (node) {
      setToolDetailContent(node, detail);
      const details = node.closest("details");
      const summary = details?.querySelector(".tool-summary")?.textContent ?? "";
      const isAsk = summary.includes("ask_user");
      if (details) details.open = false;
      if (e.tool_call_id) openTools.delete(e.tool_call_id);
      if (openToolDetail === node) openToolDetail = null;
      if (isAsk && !e.is_error) appendMessage(host, "user", e.content ?? "");
    } else {
      appendToolStep(host, { title: "工具结果", detail, open: false });
    }
    return true;
  }
  if (e.type === "error") {
    clearPermissionDock();
    appendMessage(host, "error", e.message ?? "");
    return true;
  }
  return false;
}

function finishRun(reason: string, refreshStore: boolean): void {
  if (streamingEl && streamBuffer) paintStreamRich(true);
  resetStreamTarget(null);
  clearPermissionDock();
  clearOpenTools();
  setRunning(false);
  setStatus(runStatusText(reason), reason !== "completed");
  if (refreshStore && currentSessionId) void refreshStoreDock(currentSessionId);
  noteRunFinished();
  void refreshSessions();
}

window.agent.onEvent((e) => {
  // Auto-title may arrive after `done` cleared the run gate — always apply.
  if (e.type === "session_title") {
    if (currentSessionId === e.session_id) {
      currentSessionTitle = e.title;
      updateChrome();
    }
    void refreshSessions();
    return;
  }

  const decision = decideEvent(runGate, currentSessionId, e);
  runGate = decision.next;
  if (!decision.paint) {
    if (!decision.keep) return;
    if (e.type === "ask_user" || e.type === "permission_request") {
      recordLivePrompt(e);
      return;
    }
    if (e.type === "done") {
      finishRun(e.reason, false);
      return;
    }
    if (runParked) applyTranscript(runBoard, e);
    return;
  }

  if (applyTranscript(messagesEl, e)) return;
  if (e.type === "permission_request" || e.type === "ask_user") {
    recordLivePrompt(e);
  } else if (e.type === "done") {
    finishRun(e.reason, true);
  } else if (e.type === "status") {
    setStatus(PHASE_LABEL[e.phase] ?? e.phase, true);
  }
});

function refreshVisibleAssistantMarkdown(): void {
  if (isRunning) return;
  rerenderAllAssistantMarkdown(messagesEl);
}

const floatStack = document.querySelector(".float-stack");
if (floatStack instanceof HTMLElement) {
  const syncFloatPad = () => {
    const h = Math.ceil(floatStack.getBoundingClientRect().height) + 12;
    messagesEl.style.paddingBottom = `${h}px`;
    storeView.style.paddingBottom = `${h}px`;
  };
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

void boot();
