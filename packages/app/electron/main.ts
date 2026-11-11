import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentError,
  AgentRuntime,
  ExplainRuntime,
  SessionRuntimePool,
  sessionRunKey,
  ExplainStore,
  SessionStore,
  sourceTurnContext,
  TraceStore,
  ContextStore,
  OpenAICompatibleProvider,
  loadStoredConfig,
  saveStoredConfig,
  toAgentConfig,
  assertValidSessionId,
  DeferredPermissionGate,
  DeferredAskGate,
  defaultSkillsRoot,
  extractSkillTokens,
  installSkill,
  isPathInside,
  isSkillName,
  listInstalledSkills,
  setSkillEnabled,
  skillDirectory,
  uninstallSkill,
  listSubagentToolRows,
  listSubagentStatuses,
  TaskStore,
  buildTaskPanel,
} from "@agent/core";
import type { AgentConfig, ImageMime, PermissionDecision, StoredConfig, SubmittedImage } from "@agent/core";
import { localTargetsExist, openTarget } from "./openTarget.js";
import { TaskbarAlert } from "./taskbarAlert.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let taskbarAlert: TaskbarAlert | null = null;
let appMenu: Menu | null = null;
let explainRt: ExplainRuntime | null = null;
let explainKey = "";
/** Workspace the sidebar last focused. Not the only workspace that can run. */
let workspacePath: string | null = null;

type LiveRun = {
  runtime: AgentRuntime;
  permissions: DeferredPermissionGate;
  asks: DeferredAskGate;
};

const lives = new Map<string, LiveRun>();

const runPool = new SessionRuntimePool<AgentRuntime>(async (workspace, sessionId) => {
  const config = await readAgentConfig();
  const permissions = new DeferredPermissionGate();
  const asks = new DeferredAskGate();
  const runtime = new AgentRuntime({
    workspacePath: workspace,
    config,
    provider: new OpenAICompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    }),
    permissions,
    asks,
  });
  const key = sessionRunKey(workspace, sessionId);
  lives.set(key, { runtime, permissions, asks });
  runtime.onEvent((event) => {
    const session_id = "session_id" in event && event.session_id ? event.session_id : sessionId;
    win?.webContents.send("agent:event", { ...event, session_id, workspace });
  });
  return runtime;
}, (workspace, sessionId) => {
  win?.webContents.send("agent:event", { type: "session_idle", session_id: sessionId, workspace });
});

/** Replace Electron's English default menu with zh-CN labels. */
function installChineseAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [{ role: "quit", label: "退出" }],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 Long-Task Agent",
          click: async () => {
            await dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: "Long-Task Desktop Agent",
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\nauthor.ChenShiqin`,
            });
          },
        },
      ],
    },
  ];
  appMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(appMenu);
}

/** Native menu bars are always full-window. Drop the bar; the sidebar pops the same menus. */
function hideNativeMenuBar(target: BrowserWindow): void {
  target.removeMenu();
}

const CONFIG_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
} as const;

function cleanPath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

async function pickSkillFolder(title: string): Promise<string | null> {
  const opts = {
    title,
    properties: ["openDirectory" as const],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  win?.focus();
  if (res.canceled || !res.filePaths[0]) return null;
  const picked = cleanPath(res.filePaths[0]);
  await access(picked);
  return picked;
}

function samePath(a: string, b: string): boolean {
  return cleanPath(a).toLowerCase() === cleanPath(b).toLowerCase();
}

function isDisplayName(name: string): boolean {
  return name.length > 0 && name.length <= 80 && !/[\r\n]/.test(name);
}

function labelsFor(stored: StoredConfig | null, paths: string[]): Record<string, string> {
  const raw = stored?.workspaceLabels;
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!isDisplayName(name)) continue;
    const match = paths.find((p) => samePath(p, key));
    if (!match || name === basename(match)) continue;
    out[match] = name;
  }
  return out;
}

function workspaceList(stored: StoredConfig | null): string[] {
  const raw: string[] = [];
  if (stored?.workspacePaths) raw.push(...stored.workspacePaths);
  if (stored?.lastWorkspacePath) raw.push(stored.lastWorkspacePath);
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim()) continue;
    const cleaned = cleanPath(p.trim());
    if (out.some((x) => samePath(x, cleaned))) continue;
    out.push(cleaned);
  }
  return out;
}

async function existingWorkspaces(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      await access(p);
      out.push(p);
    } catch {
      /* directory gone */
    }
  }
  return out;
}

async function readTaskPanel(workspace: string, sessionId: string) {
  const snapshot = await TaskStore.forSession(workspace, sessionId).list();
  const statuses = await listSubagentStatuses(workspace, sessionId);
  return buildTaskPanel(snapshot, statuses);
}

async function assertKnownWorkspace(raw: string): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Invalid workspace");
  const stored = await loadStoredConfig();
  const match = workspaceList(stored).find((p) => samePath(p, raw));
  if (!match) throw new Error("Unknown workspace");
  await access(match);
  return match;
}

async function readAgentConfig() {
  const stored = (await loadStoredConfig()) ?? {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
  };
  return toAgentConfig(stored);
}

function agentConfigKey(config: AgentConfig): string {
  return JSON.stringify([
    config.baseUrl,
    config.model,
    config.apiKey,
    config.bashTimeoutMs,
    config.maxSteps,
    config.contextCharLimit,
    config.maxToolOutputChars,
    config.maxReadChars,
    config.maxSearchResults,
  ]);
}

async function currentConfigKey(): Promise<string> {
  return agentConfigKey(await readAgentConfig());
}

function liveFor(workspace: string, sessionId: string): LiveRun | undefined {
  return lives.get(sessionRunKey(workspace, sessionId));
}

function cancelLive(workspace: string, sessionId: string): void {
  const live = liveFor(workspace, sessionId);
  live?.permissions.denyAll();
  live?.asks.cancelAll();
  runPool.cancel(workspace, sessionId);
}

/** Page reload. Stop every live turn instead of dropping the object while it still runs. */
async function resetAllRuntimes(): Promise<void> {
  for (const live of lives.values()) {
    live.permissions.denyAll();
    live.asks.cancelAll();
    live.runtime.cancel();
  }
  for (const live of lives.values()) {
    await live.runtime.stopDeferred();
  }
  runPool.clear();
  lives.clear();
}

const IMAGE_MIMES = new Set<ImageMime>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function normalizeSubmittedImages(raw: unknown): SubmittedImage[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new Error("Invalid images");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid image");
    const mime = (item as { mime?: unknown }).mime;
    const base64 = (item as { base64?: unknown }).base64;
    if (typeof mime !== "string" || !IMAGE_MIMES.has(mime as ImageMime)) {
      throw new Error("Unsupported image type");
    }
    if (typeof base64 !== "string" || !base64.length) throw new Error("Invalid image");
    return { mime: mime as ImageMime, base64 };
  });
}

async function ensureExplainRuntime(workspace: string): Promise<ExplainRuntime> {
  const config = await readAgentConfig();
  const key = `${workspace}\0${agentConfigKey(config)}`;
  if (explainRt?.isRunning) {
    if (!samePath(explainRt.workspacePath, workspace)) {
      throw new AgentError("解释还在进行", "busy");
    }
    return explainRt;
  }
  if (explainRt && explainKey === key) return explainRt;
  const provider = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  explainRt = new ExplainRuntime({ workspacePath: workspace, config, provider });
  explainKey = key;
  explainRt.onEvent((event) => {
    win?.webContents.send("agent:explain-event", event);
  });
  return explainRt;
}

function createWindow() {
  const preloadPath = join(__dirname, "preload.cjs");
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    icon: taskbarAlert?.restIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("preload-error", (_event, path, error) => {
    console.error("preload-error", path, error);
  });
  hideNativeMenuBar(win);
  taskbarAlert?.attach(win);
  win.once("ready-to-show", () => {
    if (win) hideNativeMenuBar(win);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.loadFile(join(__dirname, "../src/renderer/index.html"));
  if (win) watchSkillFolders(win);
}

function watchSkillFolders(window: BrowserWindow): void {
  const root = defaultSkillsRoot();
  void mkdir(root, { recursive: true })
    .then(() => {
      let timer: NodeJS.Timeout | undefined;
      const watcher: FSWatcher = watch(root, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!window.isDestroyed()) window.webContents.send("agent:skillsChanged");
        }, 400);
      });
      window.once("closed", () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      });
    })
    .catch((err) => {
      console.error("skill watch failed", err);
    });
}

type ArtifactPart = "meta" | "messages" | "trace" | "context";

function artifactPart(value: unknown): ArtifactPart | undefined {
  if (value == null || value === "") return undefined;
  if (value === "meta" || value === "messages" || value === "trace" || value === "context") return value;
  throw new Error("Invalid log file");
}

/** One log file. Omitting `part` still returns every file, for older callers. */
async function readSessionArtifacts(workspace: string, sessionId: string, part?: ArtifactPart) {
  const store = new SessionStore(workspace);
  const readTrace = async () => {
    try {
      return await new TraceStore(workspace).read(sessionId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }
  };
  if (part === "meta") return { meta: await store.getMeta(sessionId) };
  if (part === "messages") return { messages: await store.readMessages(sessionId) };
  if (part === "trace") return { traces: await readTrace() };
  if (part === "context") return { context: await new ContextStore(workspace).read(sessionId) };
  const meta = await store.getMeta(sessionId);
  const messages = await store.readMessages(sessionId);
  const traces = await readTrace();
  const context = await new ContextStore(workspace).read(sessionId);
  return { meta, messages, traces, context };
}

app.whenReady().then(() => {
  taskbarAlert = new TaskbarAlert();
  installChineseAppMenu();
  createWindow();

  ipcMain.handle("agent:setTaskbarPrompt", (_event, open: unknown, inView: unknown) => {
    taskbarAlert?.setPrompt(open === true, inView === true);
  });

  ipcMain.handle("agent:popupAppMenu", (_event, index: unknown, x: unknown, y: unknown) => {
    if (!win || !appMenu) return;
    if (typeof index !== "number" || !Number.isInteger(index)) return;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const submenu = appMenu.items[index]?.submenu;
    if (!submenu) return;
    submenu.popup({ window: win, x, y });
  });

  ipcMain.handle("agent:getWorkspace", async () => workspacePath);

  ipcMain.handle("agent:restoreWorkspace", async () => {
    const stored = await loadStoredConfig();
    const paths = await existingWorkspaces(workspaceList(stored));
    const active =
      (stored?.lastWorkspacePath && paths.find((p) => samePath(p, stored.lastWorkspacePath!))) ||
      paths[0] ||
      null;
    workspacePath = active;
    await resetAllRuntimes();
    const labels = labelsFor(stored, paths);
    const labelsDirty =
      JSON.stringify(labels) !== JSON.stringify(stored?.workspaceLabels ?? {});
    if (
      stored &&
      (paths.length !== workspaceList(stored).length || stored.lastWorkspacePath !== active || labelsDirty)
    ) {
      await saveStoredConfig({
        ...stored,
        workspacePaths: paths,
        workspaceLabels: labels,
        lastWorkspacePath: active ?? undefined,
      });
    }
    const collapsed = (stored?.workspaceCollapsed ?? []).filter(
      (item) => typeof item === "string" && paths.some((known) => samePath(known, item)),
    );
    return { active, paths, labels, collapsed };
  });

  ipcMain.handle("agent:addWorkspace", async () => {
    const opts = {
      title: "增加工作区",
      properties: ["openDirectory" as const],
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    win?.focus();
    if (res.canceled || !res.filePaths[0]) return null;
    const picked = cleanPath(res.filePaths[0]);
    await access(picked);
    const stored = (await loadStoredConfig()) ?? { ...CONFIG_DEFAULTS };
    const paths = workspaceList(stored);
    const existing = paths.find((p) => samePath(p, picked));
    if (!existing) paths.push(picked);
    const added = existing ?? picked;
    if (!workspacePath) workspacePath = added;
    await saveStoredConfig({
      ...stored,
      workspacePaths: paths,
      lastWorkspacePath: workspacePath ?? undefined,
    });
    return { active: workspacePath, paths, added, already: Boolean(existing) };
  });

  ipcMain.handle("agent:activateWorkspace", async (_e, raw: string) => {
    const path = await assertKnownWorkspace(raw);
    workspacePath = path;
    const stored = (await loadStoredConfig()) ?? { ...CONFIG_DEFAULTS };
    await saveStoredConfig({
      ...stored,
      workspacePaths: workspaceList(stored),
      lastWorkspacePath: path,
    });
    return path;
  });

  ipcMain.handle("agent:listWorkspaceSessions", async (_e, raw: string) => {
    const path = await assertKnownWorkspace(raw);
    return new SessionStore(path).listSessions();
  });
  ipcMain.handle("agent:loadWorkspaceMessages", async (_e, raw: string, sessionId: string) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    return new SessionStore(path).readMessages(sessionId);
  });
  ipcMain.handle("agent:loadWorkspaceSubagentSteps", async (_e, raw: string, sessionId: string) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    return listSubagentToolRows(path, sessionId);
  });
  ipcMain.handle("agent:loadWorkspaceArtifacts", async (_e, raw: string, sessionId: string, part?: unknown) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    return readSessionArtifacts(path, sessionId, artifactPart(part));
  });
  ipcMain.handle(
    "agent:readWorkspaceImage",
    async (_e, raw: string, sessionId: string, relativePath: string) => {
      const path = await assertKnownWorkspace(raw);
      assertValidSessionId(sessionId);
      if (typeof relativePath !== "string") throw new Error("Invalid image");
      return new SessionStore(path).readImageDataUrl(sessionId, relativePath);
    },
  );
  ipcMain.handle(
    "agent:renameWorkspaceSession",
    async (
      _e,
      raw: string,
      sessionId: string,
      title: string,
      opts?: { source?: "user" | "auto" },
    ) => {
      const path = await assertKnownWorkspace(raw);
      assertValidSessionId(sessionId);
      if (typeof title !== "string") throw new Error("Invalid title");
      return new SessionStore(path).renameSession(sessionId, title, opts);
    },
  );
  ipcMain.handle("agent:deleteWorkspaceSession", async (_e, raw: string, sessionId: string) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    // Background subagents live in the runtime; it stops them before the directory goes.
    const live = liveFor(path, sessionId);
    if (live) {
      live.permissions.denyAll();
      live.asks.cancelAll();
      live.runtime.cancel();
      runPool.forget(path, sessionId);
      lives.delete(sessionRunKey(path, sessionId));
      await live.runtime.deleteSession(sessionId);
    } else {
      await new SessionStore(path).deleteSession(sessionId);
    }
  });

  ipcMain.handle("agent:openWorkspaceFolder", async (_e, raw: string) => {
    const path = await assertKnownWorkspace(raw);
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  });

  ipcMain.handle("agent:renameWorkspace", async (_e, raw: string, nextName: string) => {
    const path = await assertKnownWorkspace(raw);
    if (typeof nextName !== "string") throw new Error("显示名称无效");
    const name = nextName.trim();
    if (!isDisplayName(name)) throw new Error("显示名称无效");
    const stored = (await loadStoredConfig()) ?? { ...CONFIG_DEFAULTS };
    const paths = workspaceList(stored);
    const labels = labelsFor(stored, paths);
    for (const key of Object.keys(labels)) {
      if (samePath(key, path)) delete labels[key];
    }
    if (name !== basename(path)) labels[path] = name;
    await saveStoredConfig({
      ...stored,
      workspacePaths: paths,
      workspaceLabels: labels,
      lastWorkspacePath: workspacePath ?? stored.lastWorkspacePath,
    });
    return { path, labels };
  });

  ipcMain.handle("agent:removeWorkspace", async (_e, raw: string) => {
    const path = await assertKnownWorkspace(raw);
    const sessions = await new SessionStore(path).listSessions();
    if (sessions.length > 0) throw new Error("目录下还有会话，不能从列表移除");
    const stored = (await loadStoredConfig()) ?? { ...CONFIG_DEFAULTS };
    const paths = workspaceList(stored).filter((item) => !samePath(item, path));
    const labels = labelsFor(stored, paths);
    await runPool.discardWorkspace(path);
    const head = sessionRunKey(path, "x");
    const prefix = head.slice(0, head.length - 1);
    for (const key of [...lives.keys()]) {
      if (key.startsWith(prefix)) lives.delete(key);
    }
    if (workspacePath && samePath(workspacePath, path)) workspacePath = paths[0] ?? null;
    await saveStoredConfig({
      ...stored,
      workspacePaths: paths,
      workspaceLabels: labels,
      workspaceCollapsed: (stored.workspaceCollapsed ?? []).filter(
        (item) => typeof item === "string" && paths.some((known) => samePath(known, item)),
      ),
      lastWorkspacePath: workspacePath ?? undefined,
    });
    return { paths, active: workspacePath, labels };
  });

  ipcMain.handle("agent:createSession", async (_e, title?: string) => {
    if (!workspacePath) throw new Error("No workspace selected");
    return new SessionStore(workspacePath).createSession(title);
  });
  ipcMain.handle("agent:listSessions", async () => {
    if (!workspacePath) return [];
    return new SessionStore(workspacePath).listSessions();
  });
  ipcMain.handle("agent:loadMessages", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) return [];
    return new SessionStore(workspacePath).readMessages(sessionId);
  });
  ipcMain.handle("agent:loadSubagentSteps", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) return [];
    return listSubagentToolRows(workspacePath, sessionId);
  });
  ipcMain.handle("agent:loadTasks", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) return { rows: [], unreadable: [], attention: 0 };
    return readTaskPanel(workspacePath, sessionId);
  });
  ipcMain.handle("agent:loadWorkspaceTasks", async (_e, raw: string, sessionId: string) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    return readTaskPanel(path, sessionId);
  });
  ipcMain.handle("agent:loadSessionArtifacts", async (_e, sessionId: string, part?: unknown) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) throw new Error("No workspace selected");
    return readSessionArtifacts(workspacePath, sessionId, artifactPart(part));
  });
  ipcMain.handle(
    "agent:renameSession",
    async (
      _e,
      sessionId: string,
      title: string,
      opts?: { source?: "user" | "auto" },
    ) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) throw new Error("No workspace selected");
    return new SessionStore(workspacePath).renameSession(sessionId, title, opts);
  });
  ipcMain.handle("agent:deleteSession", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    if (!workspacePath) throw new Error("No workspace selected");
    const live = liveFor(workspacePath, sessionId);
    if (live) {
      live.permissions.denyAll();
      live.asks.cancelAll();
      live.runtime.cancel();
      runPool.forget(workspacePath, sessionId);
      lives.delete(sessionRunKey(workspacePath, sessionId));
      await live.runtime.deleteSession(sessionId);
      return;
    }
    await new SessionStore(workspacePath).deleteSession(sessionId);
  });
  ipcMain.handle(
    "agent:submit",
    async (_e, sessionId: string, text: string, images?: unknown, workspaceRaw?: unknown) => {
      assertValidSessionId(sessionId);
      const workspace =
        typeof workspaceRaw === "string" ? await assertKnownWorkspace(workspaceRaw) : workspacePath;
      if (!workspace) throw new Error("No workspace selected");
      await runPool.submit(
        workspace,
        sessionId,
        text,
        normalizeSubmittedImages(images),
        await currentConfigKey(),
      );
    },
  );
  ipcMain.handle("agent:watchSession", async (_e, sessionId: unknown, workspaceRaw?: unknown) => {
    if (sessionId != null && typeof sessionId !== "string") throw new Error("Invalid session id");
    if (typeof sessionId !== "string") return;
    assertValidSessionId(sessionId);
    const workspace =
      typeof workspaceRaw === "string" ? await assertKnownWorkspace(workspaceRaw) : workspacePath;
    if (!workspace) return;
    await runPool.watch(workspace, sessionId, await currentConfigKey());
  });
  ipcMain.handle(
    "agent:readSessionImage",
    async (_e, sessionId: string, relativePath: string) => {
      assertValidSessionId(sessionId);
      if (typeof relativePath !== "string") throw new Error("Invalid image path");
      if (!workspacePath) throw new Error("No workspace selected");
      return new SessionStore(workspacePath).readImageDataUrl(sessionId, relativePath);
    },
  );
  ipcMain.handle("agent:cancel", async (_e, sessionId?: unknown, workspaceRaw?: unknown) => {
    if (typeof sessionId === "string" && typeof workspaceRaw === "string") {
      assertValidSessionId(sessionId);
      cancelLive(await assertKnownWorkspace(workspaceRaw), sessionId);
    }
  });
  ipcMain.handle("agent:explainLoad", async (_e, rawWorkspace: string, sessionId: string) => {
    assertValidSessionId(sessionId);
    const path = await assertKnownWorkspace(rawWorkspace);
    const store = new ExplainStore(path);
    const [open, messages] = await Promise.all([
      store.getOpen(sessionId),
      store.readMessages(sessionId),
    ]);
    return { open, messages };
  });
  ipcMain.handle(
    "agent:explainSetOpen",
    async (_e, rawWorkspace: string, sessionId: string, open: unknown) => {
      assertValidSessionId(sessionId);
      if (typeof open !== "boolean") throw new Error("Invalid explain state");
      const path = await assertKnownWorkspace(rawWorkspace);
      await new ExplainStore(path).setOpen(sessionId, open);
    },
  );
  ipcMain.handle(
    "agent:explainSubmit",
    async (
      _e,
      rawWorkspace: string,
      sessionId: string,
      text: unknown,
      images?: unknown,
      sourceMessageIds?: unknown,
    ) => {
      assertValidSessionId(sessionId);
      if (typeof text !== "string") throw new Error("Invalid message");
      const path = await assertKnownWorkspace(rawWorkspace);
      const rt = await ensureExplainRuntime(path);
      let context: { user: string; assistant: string } | null = null;
      if (Array.isArray(sourceMessageIds)) {
        const ids = sourceMessageIds.filter((id): id is string => typeof id === "string");
        const main = await new SessionStore(path).readMessages(sessionId);
        context = sourceTurnContext(main, ids, text);
      }
      await rt.submit(sessionId, text, normalizeSubmittedImages(images), context);
    },
  );
  ipcMain.handle("agent:explainCancel", async () => {
    explainRt?.cancel();
  });
  ipcMain.handle(
    "agent:explainReadImage",
    async (_e, rawWorkspace: string, sessionId: string, relativePath: string) => {
      assertValidSessionId(sessionId);
      if (typeof relativePath !== "string") throw new Error("Invalid image path");
      const path = await assertKnownWorkspace(rawWorkspace);
      return new SessionStore(path).readImageDataUrl(sessionId, relativePath);
    },
  );
  ipcMain.handle("agent:answerAsk", async (_e, requestId: string, text: string) => {
    if (typeof requestId !== "string" || typeof text !== "string") return false;
    for (const live of lives.values()) {
      if (live.asks.answer(requestId, text)) return true;
    }
    return false;
  });
  ipcMain.handle(
    "agent:permissionRespond",
    async (_e, requestId: string, decision: PermissionDecision) => {
      if (decision !== "allow" && decision !== "deny") return false;
      for (const live of lives.values()) {
        if (live.permissions.respond(requestId, decision)) return true;
      }
      return false;
    },
  );
  ipcMain.handle("agent:listSkills", async () => listInstalledSkills());
  ipcMain.handle("agent:skillTokens", async (_e, text: unknown) => {
    if (typeof text !== "string") throw new Error("Invalid text");
    return extractSkillTokens(text);
  });
  ipcMain.handle("agent:installSkill", async () => {
    const picked = await pickSkillFolder("添加技能");
    if (!picked) return null;
    return installSkill(picked);
  });
  ipcMain.handle("agent:setSkillEnabled", async (_e, name: unknown, enabled: unknown) => {
    if (typeof name !== "string" || !isSkillName(name)) throw new Error(`未找到技能 ${String(name)}`);
    if (typeof enabled !== "boolean") throw new Error("技能开关无效");
    await setSkillEnabled(name, enabled);
  });
  ipcMain.handle("agent:uninstallSkill", async (_e, name: unknown) => {
    if (typeof name !== "string" || !isSkillName(name)) throw new Error(`未找到技能 ${String(name)}`);
    await uninstallSkill(name);
  });
  ipcMain.handle("agent:openSkillFolder", async (_e, name: unknown) => {
    if (typeof name !== "string" || !isSkillName(name)) throw new Error(`未找到技能 ${String(name)}`);
    const root = defaultSkillsRoot();
    let realRoot: string;
    let realDir: string;
    try {
      realRoot = await realpath(root);
      realDir = await realpath(skillDirectory(name));
    } catch {
      throw new Error(`未找到技能 ${name}`);
    }
    const inside =
      isPathInside(realRoot, realDir) ||
      (process.platform === "win32" && isPathInside(realRoot.toLowerCase(), realDir.toLowerCase()));
    if (!inside || realDir.toLowerCase() === realRoot.toLowerCase()) {
      throw new Error(`未找到技能 ${name}`);
    }
    const err = await shell.openPath(realDir);
    if (err) throw new Error(err);
  });
  ipcMain.handle("agent:setWorkspaceExpanded", async (_e, raw: unknown, open: unknown) => {
    if (typeof raw !== "string" || typeof open !== "boolean") throw new Error("折叠状态无效");
    const path = await assertKnownWorkspace(raw);
    const stored = (await loadStoredConfig()) ?? { ...CONFIG_DEFAULTS };
    const paths = workspaceList(stored);
    const collapsed = (stored.workspaceCollapsed ?? []).filter(
      (item) => typeof item === "string" && paths.some((known) => samePath(known, item)) && !samePath(item, path),
    );
    if (!open) collapsed.push(path);
    await saveStoredConfig({ ...stored, workspaceCollapsed: collapsed });
  });
  ipcMain.handle("agent:getConfig", async () => loadStoredConfig());
  ipcMain.handle("agent:saveConfig", async (_e, cfg: StoredConfig) => {
    const prev = await loadStoredConfig();
    await saveStoredConfig({
      ...cfg,
      workspacePaths: cfg.workspacePaths ?? prev?.workspacePaths,
      workspaceLabels: cfg.workspaceLabels ?? prev?.workspaceLabels,
      workspaceCollapsed: cfg.workspaceCollapsed ?? prev?.workspaceCollapsed,
      lastWorkspacePath: cfg.lastWorkspacePath ?? prev?.lastWorkspacePath,
    });
  });
  ipcMain.handle("agent:localTargetsExist", async (_e, targets: unknown) => {
    if (!Array.isArray(targets) || targets.some((item) => typeof item !== "string")) return {};
    return localTargetsExist(targets, workspacePath);
  });
  ipcMain.handle("agent:openExternal", async (_e, target: string) => {
    if (typeof target !== "string") return { ok: false, error: "Invalid target" };
    return openTarget(target, workspacePath);
  });
});
