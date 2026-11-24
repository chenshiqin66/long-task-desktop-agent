import { attachComposerModelSizing, fitComposerModelEmpty, fitComposerModelSelect } from "./composerModelFit.js";
import { paintExplainIcons } from "./explainIcons.js";
import { attachComposerResize } from "./composerResize.js";
import { attachComposerCollapse, type ComposerCollapse } from "./composerCollapse.js";
import { bindQuestionBubbleToggle, expandTurnForQuestion, questionsOnly, setQuestionsOnly } from "./questionsOnly.js";
import { paintSendButton } from "./sendButton.js";
import { createThinkingHint, thinkingLabel } from "./thinkingHint.js";
import {
  appendMessage,
  appendToolStep,
  ensureMessageTime,
  removeLastTranscriptNodes,
  refreshToolGroup,
  rerenderAllAssistantMarkdown,
  setRichText,
  setToolDetailContent,
} from "./ui.js";

type ExplainMessage = {
  id?: string;
  role: string;
  content: string;
  name?: string;
  is_error?: boolean;
  tool_call_id?: string;
  tool_call_arguments?: string;
  images?: Array<{ path: string }>;
  videos?: Array<{ path: string }>;
  created_at?: string;
};

type ModelKind = "text" | "image" | "video" | "tts" | "asr" | "search";
const MODEL_KINDS: readonly ModelKind[] = ["text", "image", "video", "tts", "asr", "search"];

type PendingImage = { previewUrl: string; mime: "image/png" | "image/jpeg"; base64: string };
type PendingVideo = { previewUrl: string; mime: "video/mp4" | "video/webm" | "video/quicktime"; base64: string };

type Slot = {
  workspace: string;
  sessionId: string;
  board: HTMLElement;
  loaded: Promise<void>;
  open: boolean;
  stream: HTMLElement | null;
  streamText: string;
  afterTool: boolean;
  tools: Map<string, HTMLElement>;
};

export type ExplainPane = {
  pane: HTMLElement;
  conversation: HTMLElement;
  findBar: HTMLElement;
  findInput: HTMLInputElement;
  findCount: HTMLElement;
  findPrev: HTMLButtonElement;
  findNext: HTMLButtonElement;
  findClose: HTMLButtonElement;
  sync(sessionId: string | null, workspace: string | null): void;
  /**
   * Point the pane at another record for a while (the browser's), whatever `sync` is told. `null` gives it
   * back to the session on screen.
   */
  use(slot: { sessionId: string; workspace: string } | null): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  ask(text: string, sourceMessageIds: string[] | null): void;
  contains(node: Node | null): boolean;
  focusInside(): boolean;
  searchRoot(): HTMLElement | null;
};

const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_EDGE = 1600;
const MAX_PENDING_VIDEOS = 1;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

const PHASE: Record<string, string> = {
  assembling: "整理上下文…",
  llm: "思考中……",
  tool: "执行工具…",
};

/** Matches `visibleExplainText` in @agent/core. The renderer cannot import that package. */
function visibleExplainText(content: string): string {
  const marker = "\n</system reminder>\n";
  if (!content.startsWith("<system reminder>\n")) return content;
  const at = content.indexOf(marker);
  if (at < 0) return content;
  return content.slice(at + marker.length);
}

function toolTitle(name: string, argsJson?: string): string {
  let hint = "";
  try {
    const args = JSON.parse(argsJson || "{}") as { query?: unknown };
    if (typeof args.query === "string" && args.query.trim()) hint = args.query.trim();
  } catch {
    hint = "";
  }
  if (hint.length > 36) hint = `${hint.slice(0, 36)}…`;
  return hint ? `调用 ${name} · ${hint}` : `调用 ${name || "工具"}`;
}

export function mountExplainPane(): ExplainPane {
  paintExplainIcons();
  attachComposerResize(
    document.getElementById("explain-composer") as HTMLElement,
    document.getElementById("explain-input") as HTMLTextAreaElement,
    document.querySelector("#explain-composer .composer-resize") as HTMLElement,
  );
  const pane = document.getElementById("explain-pane") as HTMLElement;
  const toggle = document.getElementById("explain-toggle") as HTMLButtonElement;
  const collapse = document.getElementById("explain-collapse") as HTMLButtonElement;
  const conversation = document.getElementById("explain-conversation") as HTMLElement;
  const statusEl = document.getElementById("explain-status") as HTMLElement;
  const findBar = document.getElementById("explain-find-bar") as HTMLElement;
  const findInput = document.getElementById("explain-find-input") as HTMLInputElement;
  const findCount = document.getElementById("explain-find-count") as HTMLElement;
  const findPrev = document.getElementById("explain-find-prev") as HTMLButtonElement;
  const findNext = document.getElementById("explain-find-next") as HTMLButtonElement;
  const findClose = document.getElementById("explain-find-close") as HTMLButtonElement;
  const input = document.getElementById("explain-input") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("explain-send") as HTMLButtonElement;
  const imageBtn = document.getElementById("explain-image") as HTMLButtonElement;
  const fileInput = document.getElementById("explain-file") as HTMLInputElement;
  const videoBtn = document.getElementById("explain-video") as HTMLButtonElement;
  const videoInput = document.getElementById("explain-video-file") as HTMLInputElement;
  const imageRow = document.getElementById("explain-images") as HTMLElement;
  const lockNote = document.getElementById("explain-lock") as HTMLElement;
  const composer = document.getElementById("explain-composer") as HTMLElement;
  const modelSelect = document.getElementById("explain-model") as HTMLSelectElement;
  const modelEmpty = document.getElementById("explain-model-empty") as HTMLButtonElement;
  const floatStack = document.getElementById("explain-float") as HTMLElement;
  const placeholder = document.getElementById("explain-messages") as HTMLElement;
  const questionsToggle = document.getElementById("explain-questions-toggle") as HTMLButtonElement;
  bindQuestionBubbleToggle(placeholder);

  const slots = new Map<string, Slot>();
  let loadGen = 0;
  const drafts = new Map<string, { text: string; images: PendingImage[]; videos: PendingVideo[] }>();
  let current: { sessionId: string; workspace: string } | null = null;
  let shown: HTMLElement | null = placeholder;
  let pending: PendingImage[] = [];
  let pendingVideos: PendingVideo[] = [];
  let hasTextModel = false;
  let paintingPicker = false;
  let runKey: string | null = null;
  let runPhase = "";
  /**
   * This session's explain is running: the composer is folded and its placeholder carries the
   * phase ("思考中……"), so the run line above it stays hidden. There is no ask_user here, so it
   * stays folded until the run ends.
   */
  let thinking = false;
  let statusIsRun = false;
  /** Folds the box to one row until it is used. Attached at the end of this function. */
  let composerFold: ComposerCollapse | null = null;
  const idlePlaceholder = input.placeholder;
  const thinkingHint = createThinkingHint(input);

  function layout(): void {
    const sidebar = document.getElementById("sidebar");
    const side = sidebar?.getBoundingClientRect().width ?? 0;
    const avail = Math.max(0, window.innerWidth - side);
    let width = Math.min(520, Math.max(360, Math.round(avail * 0.38)));
    if (avail - width < 240) width = Math.max(280, avail - 240);
    pane.style.width = `${Math.round(width * 0.8)}px`;
  }

  function pad(): void {
    const stackH = Math.ceil(floatStack.getBoundingClientRect().height) + 12;
    const statusH = statusEl.hidden ? 0 : Math.ceil(statusEl.getBoundingClientRect().height) + 8;
    if (shown) shown.style.paddingBottom = `${stackH + statusH}px`;
    statusEl.style.bottom = `${stackH}px`;
  }

  new ResizeObserver(() => pad()).observe(floatStack);

  function stick(board: HTMLElement): void {
    if (board.dataset.follow === "0") return;
    board.scrollTop = board.scrollHeight;
  }

  /** `run`: the text is the run phase. Errors and notices pass false and always show. */
  function setStatus(text: string, busy = false, run = false): void {
    const folded = run && thinking && Boolean(text);
    statusEl.textContent = text;
    statusEl.hidden = !busy || !text || folded;
    statusIsRun = run && Boolean(text);
    if (folded) thinkingHint.show(thinkingLabel(text));
    pad();
  }

  function parseModelKind(raw: unknown): ModelKind {
    return typeof raw === "string" && (MODEL_KINDS as readonly string[]).includes(raw)
      ? (raw as ModelKind)
      : "text";
  }

  function paintExplainPicker(cfg: unknown): void {
    const stored = cfg && typeof cfg === "object" ? (cfg as { models?: unknown; currentModelId?: unknown; currentExplainModelId?: unknown }) : {};
    const entries = Array.isArray(stored.models)
      ? stored.models.filter((row): row is { id?: unknown; name?: unknown; model?: unknown; kind?: unknown } => Boolean(row) && typeof row === "object")
      : [];
    const textModels = entries.filter((row) => typeof row.id === "string" && parseModelKind(row.kind) === "text");
    const explainId = typeof stored.currentExplainModelId === "string" ? stored.currentExplainModelId : "";
    const currentId = typeof stored.currentModelId === "string" ? stored.currentModelId : "";
    const selected =
      textModels.find((row) => row.id === explainId) ??
      textModels.find((row) => row.id === currentId) ??
      textModels[0];
    hasTextModel = Boolean(selected);
    paintingPicker = true;
    modelSelect.replaceChildren();
    if (!textModels.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未配置模型";
      modelSelect.append(option);
      modelSelect.value = "";
      modelSelect.hidden = true;
      modelSelect.disabled = true;
      modelEmpty.hidden = false;
    } else {
      for (const entry of textModels) {
        const option = document.createElement("option");
        option.value = String(entry.id);
        const name =
          (typeof entry.name === "string" && entry.name) ||
          (typeof entry.model === "string" && entry.model) ||
          "未命名模型";
        option.textContent = `${name}（生文）`;
        modelSelect.append(option);
      }
      modelSelect.value = String(selected!.id);
      modelSelect.hidden = false;
      modelSelect.disabled = false;
      modelEmpty.hidden = true;
    }
    paintingPicker = false;
    fitComposerModelSelect(modelSelect);
    fitComposerModelEmpty(modelEmpty);
  }

  async function refreshExplainModels(): Promise<void> {
    try {
      paintExplainPicker(await window.agent.getConfig());
    } catch {
      hasTextModel = false;
      paintExplainPicker(null);
    }
    paintComposer();
  }

  function rememberDraft(sessionId: string | null): void {
    if (!sessionId) return;
    drafts.set(sessionId, { text: input.value, images: pending, videos: pendingVideos });
  }

  function restoreDraft(sessionId: string): void {
    const saved = drafts.get(sessionId);
    pending = saved?.images ?? [];
    pendingVideos = saved?.videos ?? [];
    input.value = saved?.text ?? "";
    paintImages();
  }

  function paintImages(): void {
    imageRow.innerHTML = "";
    imageRow.hidden = pending.length === 0 && pendingVideos.length === 0;
    composerFold?.refresh();
    pending.forEach((image, index) => {
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
        if (input.disabled) return;
        URL.revokeObjectURL(image.previewUrl);
        pending.splice(index, 1);
        paintImages();
        paintComposer();
      };
      thumb.append(img, remove);
      imageRow.append(thumb);
    });
    pendingVideos.forEach((video, index) => {
      const thumb = document.createElement("div");
      thumb.className = "composer-thumb";
      const node = document.createElement("video");
      node.src = video.previewUrl;
      node.muted = true;
      node.preload = "metadata";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "移除视频");
      remove.onclick = () => {
        if (input.disabled) return;
        URL.revokeObjectURL(video.previewUrl);
        pendingVideos.splice(index, 1);
        paintImages();
        paintComposer();
      };
      thumb.append(node, remove);
      imageRow.append(thumb);
    });
  }

  function paintComposer(): void {
    const here = Boolean(current && runKey === current.sessionId);
    const elsewhere = Boolean(runKey) && !here;
    const blocked = !hasTextModel;
    input.disabled = here || elsewhere || blocked;
    imageBtn.disabled = true;
    videoBtn.disabled = true;
    lockNote.hidden = !elsewhere;
    lockNote.textContent = "另一个会话的解释正在进行";
    composer.classList.toggle("is-locked", elsewhere);
    thinking = here;
    composer.classList.toggle("is-thinking", thinking);
    if (thinking) {
      thinkingHint.show(thinkingLabel(runPhase));
      if (statusIsRun) statusEl.hidden = true;
    } else {
      thinkingHint.hide();
      input.placeholder = idlePlaceholder;
    }
    const empty = !input.value.trim() && pending.length === 0 && pendingVideos.length === 0;
    sendBtn.disabled = elsewhere || (blocked && !here) || (!here && empty);
    paintSendButton(sendBtn, here ? "stop" : "send");
    composerFold?.refresh();
    pad();
  }

  function applyVisibility(): void {
    if (!current) {
      pane.hidden = true;
      toggle.hidden = true;
      return;
    }
    const slot = slots.get(current.sessionId);
    const open = slot?.open ?? false;
    pane.hidden = !open;
    toggle.hidden = open;
    if (open && slot) {
      layout();
      showBoard(slot.board);
      const runningHere = runKey === current.sessionId;
      setStatus(runningHere ? runPhase : "", runningHere, true);
    }
    paintComposer();
  }

  function paintQuestionsToggle(): void {
    const state = questionsOnly(shown);
    questionsToggle.setAttribute("aria-pressed", state ? "true" : "false");
    const label = state ? "显示全部消息" : "只看用户问题";
    questionsToggle.title = label;
    questionsToggle.setAttribute("aria-label", label);
  }

  /** Shown only while the pane has a conversation, like the main page's button, which needs a session. */
  function syncQuestionsToggle(): void {
    questionsToggle.hidden = !shown || Boolean(shown.querySelector(".empty-state"));
    paintQuestionsToggle();
  }

  questionsToggle.addEventListener("click", () => {
    if (!shown) return;
    const slot = current ? slots.get(current.sessionId) : undefined;
    // Only a run that is still going on this session has a turn to keep open.
    const streaming = slot && runKey === slot.sessionId ? slot.stream?.closest(".turn") ?? null : null;
    setQuestionsOnly(shown, !questionsOnly(shown), streaming as HTMLElement | null, () => paintQuestionsToggle());
  });

  function showBoard(board: HTMLElement): void {
    if (shown === board) return;
    board.classList.add("messages");
    shown?.replaceWith(board);
    shown = board;
    syncQuestionsToggle();
    pad();
    stick(board);
  }

  function slotFor(workspace: string, sessionId: string): Slot {
    const existing = slots.get(sessionId);
    if (existing && existing.workspace === workspace) return existing;
    const board = document.createElement("div");
    board.className = "messages";
    board.dataset.follow = "1";
    bindQuestionBubbleToggle(board);
    showExplainEmpty(board);
    board.addEventListener(
      "scroll",
      () => {
        const distance = board.scrollHeight - board.scrollTop - board.clientHeight;
        board.dataset.follow = distance < 48 ? "1" : "0";
      },
      { passive: true },
    );
    const slot: Slot = {
      workspace,
      sessionId,
      board,
      loaded: Promise.resolve(),
      open: false,
      stream: null,
      streamText: "",
      afterTool: false,
      tools: new Map(),
    };
    slot.loaded = loadSlot(slot);
    slots.set(sessionId, slot);
    return slot;
  }

  async function loadSlot(slot: Slot): Promise<void> {
    const gen = String(++loadGen);
    slot.board.dataset.gen = gen;
    try {
      const data = await window.agent.explainLoad(slot.workspace, slot.sessionId);
      if (slot.board.dataset.gen !== gen) return;
      slot.open = data.open;
      await renderHistory(slot, data.messages as ExplainMessage[]);
    } catch (err) {
      if (slot.board.dataset.gen !== gen) return;
      slot.board.innerHTML = "";
      appendMessage(slot.board, "error", err instanceof Error ? err.message : String(err));
    }
  }

  async function renderHistory(slot: Slot, messages: ExplainMessage[]): Promise<void> {
    slot.board.innerHTML = "";
    if (!messages.length) {
      showExplainEmpty(slot.board);
      return;
    }
    for (const message of messages) {
      if (message.role === "tool") {
        appendToolStep(slot.board, {
          title: toolTitle(message.name || "工具", message.tool_call_arguments).replace(/^调用 /, "工具结果 · "),
          detail: message.content.slice(0, 4000),
          open: false,
          error: message.is_error === true,
          toolCallId: message.tool_call_id,
          messageId: message.id,
        });
      } else if (message.role === "assistant") {
        if (!message.content.trim()) continue;
        const body = appendMessage(slot.board, "assistant", message.content, {
          rich: true,
          messageId: message.id,
          at: message.created_at,
        });
        if (message.content === "任务已终止") body.closest(".msg")?.classList.add("is-cancelled");
      } else if (message.role === "user") {
        const urls: Array<{ src: string; path: string; sessionId: string; workspace: string }> = [];
        for (const image of message.images ?? []) {
          try {
            urls.push({
              src: await window.agent.explainReadImage(slot.workspace, slot.sessionId, image.path),
              path: image.path,
              sessionId: slot.sessionId,
              workspace: slot.workspace,
            });
          } catch {
            /* missing file */
          }
        }
        const videoUrls: Array<{ src: string; path: string; sessionId: string; workspace: string }> = [];
        for (const video of message.videos ?? []) {
          try {
            videoUrls.push({
              src: await window.agent.explainReadVideo(slot.workspace, slot.sessionId, video.path),
              path: video.path,
              sessionId: slot.sessionId,
              workspace: slot.workspace,
            });
          } catch {
            /* missing file */
          }
        }
        appendMessage(slot.board, "user", visibleExplainText(message.content), {
          images: urls.length ? urls : undefined,
          videos: videoUrls.length ? videoUrls : undefined,
          messageId: message.id,
          at: message.created_at,
        });
      }
    }
    rerenderAllAssistantMarkdown(slot.board);
    if (!slot.board.querySelector(".msg")) showExplainEmpty(slot.board);
  }

  function showExplainEmpty(board: HTMLElement): void {
    if (board.querySelector(".msg") || board.querySelector(".explain-empty")) return;
    const hint = document.createElement("p");
    hint.className = "empty-state explain-empty";
    hint.textContent = "试试把文本拖到这里~";
    board.append(hint);
  }

  function ensureBubble(slot: Slot): HTMLElement {
    if (!slot.stream || slot.afterTool) {
      slot.board.querySelector(".empty-state")?.remove();
      slot.stream = appendMessage(slot.board, "assistant", "");
      slot.streamText = "";
      slot.afterTool = false;
    }
    return slot.stream;
  }

  function onEvent(event: {
    type: string;
    session_id?: string;
    delta?: string;
    phase?: string;
    message?: string;
    reason?: string;
    tool_call?: { id: string; function: { name: string; arguments: string } };
    tool_call_id?: string;
    content?: string;
    is_error?: boolean;
  }): void {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const slot = slots.get(sessionId);
    if (!slot) return;
    if (event.type === "status") {
      runPhase = PHASE[event.phase || ""] ?? event.phase ?? "";
      if (current?.sessionId === sessionId) setStatus(runPhase, true, true);
      return;
    }
    if (event.type === "text" && event.delta) {
      const body = ensureBubble(slot);
      slot.streamText += event.delta;
      body.textContent = slot.streamText;
      if (slot.streamText.trim()) ensureMessageTime(body);
      if (shown === slot.board) stick(slot.board);
      return;
    }
    if (event.type === "tool_call" && event.tool_call) {
      slot.afterTool = true;
      slot.board.querySelector(".empty-state")?.remove();
      const body = appendToolStep(slot.board, {
        title: toolTitle(event.tool_call.function.name, event.tool_call.function.arguments),
        detail: "",
        open: false,
        toolCallId: event.tool_call.id,
      });
      slot.tools.set(event.tool_call.id, body);
      if (shown === slot.board) stick(slot.board);
      return;
    }
    if (event.type === "tool_result" && event.tool_call_id) {
      const body = slot.tools.get(event.tool_call_id);
      if (body) {
        setToolDetailContent(body, (event.content || "").slice(0, 4000));
        body.closest(".tool-step")?.classList.toggle("is-error", event.is_error === true);
        refreshToolGroup(body.closest(".tool-group"));
      }
      return;
    }
    if (event.type === "error") {
      slot.board.querySelector(".empty-state")?.remove();
      appendMessage(slot.board, "error", event.message || "解释失败");
      runKey = null;
      runPhase = "";
      if (current?.sessionId === sessionId) setStatus("", false);
      paintComposer();
      return;
    }
    if (event.type === "done") {
      if (event.reason === "cancelled" && slot.stream && !slot.streamText.trim()) {
        slot.stream.textContent = "任务已终止";
        slot.stream.closest(".msg")?.classList.add("is-cancelled");
        ensureMessageTime(slot.stream);
      } else if (slot.stream && slot.streamText) {
        setRichText(slot.stream, slot.streamText, true);
      }
      slot.stream = null;
      slot.streamText = "";
      slot.afterTool = false;
      if (runKey === sessionId) {
        runKey = null;
        runPhase = "";
      }
      if (current?.sessionId === sessionId) {
        setStatus(event.reason && event.reason !== "completed" ? statusFor(event.reason) : "", event.reason !== "completed");
      }
      paintComposer();
    }
  }

  function statusFor(reason: string): string {
    if (reason === "cancelled") return "已停止";
    if (reason === "max_steps") return "已达到工具步数上限";
    if (reason === "error") return "解释失败";
    return "";
  }

  async function submitExplain(
    text: string,
    images: PendingImage[],
    videos: PendingVideo[],
    sourceMessageIds: string[] | null,
  ): Promise<void> {
    if (!current) return;
    if (!hasTextModel) {
      const slot = slotFor(current.workspace, current.sessionId);
      slot.open = true;
      applyVisibility();
      return;
    }
    if (runKey && runKey !== current.sessionId) {
      setStatus("另一个会话的解释正在进行", true);
      return;
    }
    if (runKey === current.sessionId) return;
    const slot = slotFor(current.workspace, current.sessionId);
    slot.open = true;
    applyVisibility();
    await slot.loaded;
    showBoard(slot.board);
    slot.board.querySelector(".empty-state")?.remove();
    const previews = images.map((image) => image.previewUrl);
    const videoPreviews = videos.map((video) => video.previewUrl);
    const sent = appendMessage(slot.board, "user", text, {
      ...(previews.length ? { images: previews } : {}),
      ...(videoPreviews.length ? { videos: videoPreviews } : {}),
      at: new Date().toISOString(),
    });
    expandTurnForQuestion(slot.board, sent);
    slot.stream = null;
    slot.streamText = "";
    slot.afterTool = false;
    stick(slot.board);
    runKey = current.sessionId;
    runPhase = "思考中……";
    setStatus(runPhase, true, true);
    paintComposer();
    drafts.delete(current.sessionId);
    try {
      await window.agent.explainSubmit(
        current.workspace,
        current.sessionId,
        text,
        images.length ? images.map((image) => ({ mime: image.mime, base64: image.base64 })) : undefined,
        sourceMessageIds,
        videos.length ? videos.map((video) => ({ mime: video.mime, base64: video.base64 })) : undefined,
      );
      void window.agent.explainSetOpen(current.workspace, current.sessionId, true);
    } catch (err) {
      runKey = null;
      runPhase = "";
      if (sourceMessageIds === null && current?.sessionId === slot.sessionId) {
        input.value = text;
        pending = images;
        pendingVideos = videos;
        paintImages();
      }
      removeLastTranscriptNodes(slot.board, 1);
      appendMessage(slot.board, "error", err instanceof Error ? err.message : String(err));
      setStatus("", false);
      paintComposer();
    }
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

  async function fileToPending(file: File): Promise<PendingImage> {
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
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("无法压缩图片"))),
        keepPng ? "image/png" : "image/jpeg",
        0.86,
      );
    });
    const mime = blob.type === "image/png" ? "image/png" : "image/jpeg";
    return { previewUrl: URL.createObjectURL(blob), mime, base64: await blobToBase64(blob) };
  }

  async function addFiles(files: File[]): Promise<void> {
    const accepted = files.filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
    if (!accepted.length) {
      setStatus("只能上传 png、jpeg、webp 或 gif", true);
      return;
    }
    const room = MAX_PENDING_IMAGES - pending.length;
    if (room <= 0) {
      setStatus(`一次最多 ${MAX_PENDING_IMAGES} 张图片`, true);
      return;
    }
    for (const file of accepted.slice(0, room)) {
      try {
        pending.push(await fileToPending(file));
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
    }
    paintImages();
    paintComposer();
    if (current) drafts.set(current.sessionId, { text: input.value, images: pending, videos: pendingVideos });
  }

  async function addVideoFiles(files: File[]): Promise<void> {
    const accepted = files.filter((file) => /^(video\/(mp4|webm|quicktime))$/.test(file.type));
    if (!accepted.length) {
      setStatus("只能上传 mp4、webm 或 mov", true);
      return;
    }
    if (pendingVideos.length >= MAX_PENDING_VIDEOS) {
      setStatus(`一次最多 ${MAX_PENDING_VIDEOS} 个视频`, true);
      return;
    }
    const file = accepted[0];
    if (accepted.length > 1 || pendingVideos.length + accepted.length > MAX_PENDING_VIDEOS) {
      setStatus(`一次最多 ${MAX_PENDING_VIDEOS} 个视频`, true);
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setStatus("视频不能超过 20 MiB", true);
      return;
    }
    try {
      pendingVideos.push({
        previewUrl: URL.createObjectURL(file),
        mime: file.type as PendingVideo["mime"],
        base64: await blobToBase64(file),
      });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
    paintImages();
    paintComposer();
    if (current) drafts.set(current.sessionId, { text: input.value, images: pending, videos: pendingVideos });
  }

  /** The session on screen, as `sync` last heard it, and the record the browser has borrowed the pane for. */
  let onScreen: { sessionId: string; workspace: string } | null = null;
  let borrowed: { sessionId: string; workspace: string } | null = null;

  function switchTo(next: { sessionId: string; workspace: string } | null): void {
    if (current?.sessionId === next?.sessionId && current?.workspace === next?.workspace) {
      applyVisibility();
      return;
    }
    rememberDraft(current?.sessionId ?? null);
    current = next;
    if (!current) {
      applyVisibility();
      return;
    }
    const slot = slotFor(current.workspace, current.sessionId);
    restoreDraft(current.sessionId);
    void refreshExplainModels();
    void slot.loaded.then(() => {
      if (current?.sessionId !== slot.sessionId) return;
      applyVisibility();
    });
    applyVisibility();
  }

  function setPanelOpen(open: boolean): void {
    if (!current) return;
    const slot = slotFor(current.workspace, current.sessionId);
    slot.open = open;
    applyVisibility();
    void window.agent.explainSetOpen(current.workspace, current.sessionId, open);
    if (open) {
      void refreshExplainModels();
      input.focus();
    }
  }
  toggle.addEventListener("click", () => setPanelOpen(true));
  collapse.addEventListener("click", () => setPanelOpen(false));
  sendBtn.addEventListener("click", () => {
    if (runKey && current && runKey === current.sessionId) {
      sendBtn.disabled = true;
      paintSendButton(sendBtn, "stopping");
      void window.agent.explainCancel();
      return;
    }
    const text = input.value.trim();
    const images = pending.slice();
    const videos = pendingVideos.slice();
    if (!text && images.length === 0 && videos.length === 0) return;
    if (!hasTextModel) return;
    pending = [];
    pendingVideos = [];
    paintImages();
    input.value = "";
    void submitExplain(text, images, videos, null);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendBtn.click();
    }
  });
  input.addEventListener("input", () => {
    paintComposer();
    if (current) drafts.set(current.sessionId, { text: input.value, images: pending, videos: pendingVideos });
  });
  input.addEventListener("paste", (ev) => {
    const files = Array.from(ev.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length || imageBtn.disabled) return;
    ev.preventDefault();
    void addFiles(files);
  });
  imageBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    void addFiles(files);
  });
  videoBtn.addEventListener("click", () => videoInput.click());
  videoInput.addEventListener("change", () => {
    const files = Array.from(videoInput.files ?? []);
    videoInput.value = "";
    void addVideoFiles(files);
  });
  modelSelect.addEventListener("change", () => {
    if (paintingPicker) return;
    const id = modelSelect.value;
    if (!id) return;
    void (async () => {
      const cur = await window.agent.getConfig();
      if (!cur || typeof cur !== "object") return;
      await window.agent.saveConfig({ ...(cur as object), currentExplainModelId: id });
      await refreshExplainModels();
    })();
  });
  modelEmpty.addEventListener("click", () => {
    document.getElementById("btn-config")?.click();
  });
  attachComposerModelSizing(modelSelect);
  window.addEventListener("agent-models-changed", () => {
    void refreshExplainModels();
  });
  void refreshExplainModels();
  window.agent?.onExplainEvent?.((event) => onEvent(event));
  window.addEventListener("resize", () => {
    if (!pane.hidden) layout();
  });
  new ResizeObserver(pad).observe(floatStack);
  composerFold = attachComposerCollapse({
    composer,
    input,
    conversation,
    hasDraft: () => input.value.trim().length > 0 || pending.length > 0 || pendingVideos.length > 0,
    held: () => thinking || input.disabled || composer.classList.contains("is-locked"),
  });
  new MutationObserver(syncQuestionsToggle).observe(conversation, { childList: true, subtree: true });
  syncQuestionsToggle();

  return {
    pane,
    conversation,
    findBar,
    findInput,
    findCount,
    findPrev,
    findNext,
    findClose,
    sync(sessionId, workspace) {
      onScreen = sessionId && workspace ? { sessionId, workspace } : null;
      // While the browser has the pane, the session on screen is only remembered.
      if (borrowed) return;
      switchTo(onScreen);
    },
    use(slot) {
      borrowed = slot;
      switchTo(borrowed ?? onScreen);
    },
    setOpen(open) {
      setPanelOpen(open);
    },
    isOpen() {
      return !pane.hidden;
    },
    ask(text, sourceMessageIds) {
      const trimmed = text.trim();
      if (!trimmed || !current) return;
      if (!hasTextModel) {
        const slot = slotFor(current.workspace, current.sessionId);
        slot.open = true;
        applyVisibility();
        return;
      }
      if (runKey) {
        setStatus(runKey === current.sessionId ? "解释还在进行" : "另一个会话的解释正在进行", true);
        const slot = slots.get(current.sessionId);
        if (slot) {
          slot.open = true;
          applyVisibility();
        }
        return;
      }
      void submitExplain(trimmed, [], [], sourceMessageIds);
    },
    contains(node) {
      return Boolean(node && pane.contains(node));
    },
    focusInside() {
      if (pane.hidden) return false;
      const active = document.activeElement;
      if (active instanceof Node && pane.contains(active)) return true;
      const anchor = window.getSelection()?.anchorNode ?? null;
      return Boolean(anchor && shown && shown.contains(anchor));
    },
    searchRoot() {
      return shown;
    },
  };
}
