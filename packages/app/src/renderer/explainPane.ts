import {
  appendMessage,
  appendToolStep,
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
};

type PendingImage = { previewUrl: string; mime: "image/png" | "image/jpeg"; base64: string };

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
  ask(text: string, sourceMessageIds: string[] | null): void;
  contains(node: Node | null): boolean;
  focusInside(): boolean;
  searchRoot(): HTMLElement | null;
};

const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_EDGE = 1600;

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
  const imageRow = document.getElementById("explain-images") as HTMLElement;
  const lockNote = document.getElementById("explain-lock") as HTMLElement;
  const composer = document.getElementById("explain-composer") as HTMLElement;
  const floatStack = document.getElementById("explain-float") as HTMLElement;
  const placeholder = document.getElementById("explain-messages") as HTMLElement;

  const slots = new Map<string, Slot>();
  let loadGen = 0;
  const drafts = new Map<string, { text: string; images: PendingImage[] }>();
  let current: { sessionId: string; workspace: string } | null = null;
  let shown: HTMLElement | null = placeholder;
  let pending: PendingImage[] = [];
  let runKey: string | null = null;
  let runPhase = "";

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

  function setStatus(text: string, busy = false): void {
    statusEl.textContent = text;
    statusEl.hidden = !busy || !text;
    pad();
  }

  function rememberDraft(sessionId: string | null): void {
    if (!sessionId) return;
    drafts.set(sessionId, { text: input.value, images: pending });
  }

  function restoreDraft(sessionId: string): void {
    const saved = drafts.get(sessionId);
    pending = saved?.images ?? [];
    input.value = saved?.text ?? "";
    paintImages();
  }

  function paintImages(): void {
    imageRow.innerHTML = "";
    imageRow.hidden = pending.length === 0;
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
  }

  function paintComposer(): void {
    const here = Boolean(current && runKey === current.sessionId);
    const elsewhere = Boolean(runKey) && !here;
    input.disabled = here || elsewhere;
    imageBtn.disabled = input.disabled;
    lockNote.hidden = !elsewhere;
    composer.classList.toggle("is-locked", elsewhere);
    sendBtn.classList.toggle("is-stop", here);
    sendBtn.classList.remove("is-stopping");
    sendBtn.textContent = here ? "停止" : "发送";
    sendBtn.disabled = elsewhere || (!here && !input.value.trim() && pending.length === 0);
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
    toggle.textContent = "<-解释";
    if (open && slot) {
      layout();
      showBoard(slot.board);
      const runningHere = runKey === current.sessionId;
      setStatus(runningHere ? runPhase : "", runningHere);
    }
    paintComposer();
  }

  function showBoard(board: HTMLElement): void {
    if (shown === board) return;
    board.classList.add("messages");
    shown?.replaceWith(board);
    shown = board;
    pad();
    stick(board);
  }

  function slotFor(workspace: string, sessionId: string): Slot {
    const existing = slots.get(sessionId);
    if (existing && existing.workspace === workspace) return existing;
    const board = document.createElement("div");
    board.className = "messages";
    board.dataset.follow = "1";
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
        });
        if (message.content === "任务已终止") body.closest(".msg")?.classList.add("is-cancelled");
      } else if (message.role === "user") {
        const urls: string[] = [];
        for (const image of message.images ?? []) {
          try {
            urls.push(await window.agent.explainReadImage(slot.workspace, slot.sessionId, image.path));
          } catch {
            /* missing file */
          }
        }
        appendMessage(slot.board, "user", visibleExplainText(message.content), {
          images: urls.length ? urls : undefined,
          messageId: message.id,
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
      if (current?.sessionId === sessionId) setStatus(runPhase, true);
      return;
    }
    if (event.type === "text" && event.delta) {
      const body = ensureBubble(slot);
      slot.streamText += event.delta;
      body.textContent = slot.streamText;
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
    sourceMessageIds: string[] | null,
  ): Promise<void> {
    if (!current) return;
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
    appendMessage(slot.board, "user", text, previews.length ? { images: previews } : undefined);
    slot.stream = null;
    slot.streamText = "";
    slot.afterTool = false;
    stick(slot.board);
    runKey = current.sessionId;
    runPhase = "思考中……";
    setStatus(runPhase, true);
    paintComposer();
    drafts.delete(current.sessionId);
    try {
      await window.agent.explainSubmit(
        current.workspace,
        current.sessionId,
        text,
        images.length ? images.map((image) => ({ mime: image.mime, base64: image.base64 })) : undefined,
        sourceMessageIds,
      );
      void window.agent.explainSetOpen(current.workspace, current.sessionId, true);
    } catch (err) {
      runKey = null;
      runPhase = "";
      if (sourceMessageIds === null && current?.sessionId === slot.sessionId) {
        input.value = text;
        pending = images;
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
    if (current) drafts.set(current.sessionId, { text: input.value, images: pending });
  }

  function setPanelOpen(open: boolean): void {
    if (!current) return;
    const slot = slotFor(current.workspace, current.sessionId);
    slot.open = open;
    applyVisibility();
    void window.agent.explainSetOpen(current.workspace, current.sessionId, open);
    if (open) input.focus();
  }
  toggle.addEventListener("click", () => setPanelOpen(true));
  collapse.addEventListener("click", () => setPanelOpen(false));
  sendBtn.addEventListener("click", () => {
    if (runKey && current && runKey === current.sessionId) {
      sendBtn.classList.add("is-stopping");
      void window.agent.explainCancel();
      return;
    }
    const text = input.value.trim();
    const images = pending.slice();
    if (!text && images.length === 0) return;
    pending = [];
    paintImages();
    input.value = "";
    void submitExplain(text, images, null);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendBtn.click();
    }
  });
  input.addEventListener("input", () => {
    paintComposer();
    if (current) drafts.set(current.sessionId, { text: input.value, images: pending });
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
  window.agent?.onExplainEvent?.((event) => onEvent(event));
  window.addEventListener("resize", () => {
    if (!pane.hidden) layout();
  });
  new ResizeObserver(pad).observe(floatStack);

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
      const next = sessionId && workspace ? { sessionId, workspace } : null;
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
      void slot.loaded.then(() => {
        if (current?.sessionId !== slot.sessionId) return;
        applyVisibility();
      });
      applyVisibility();
    },
    ask(text, sourceMessageIds) {
      const trimmed = text.trim();
      if (!trimmed || !current) return;
      if (runKey) {
        setStatus(runKey === current.sessionId ? "解释还在进行" : "另一个会话的解释正在进行", true);
        const slot = slots.get(current.sessionId);
        if (slot) {
          slot.open = true;
          applyVisibility();
        }
        return;
      }
      void submitExplain(trimmed, [], sourceMessageIds);
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
