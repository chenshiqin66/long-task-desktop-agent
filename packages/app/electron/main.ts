import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  SessionStore,
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
  installSkill,
  isPathInside,
  isSkillName,
  listInstalledSkills,
  setSkillEnabled,
  skillDirectory,
  uninstallSkill,
} from "@agent/core";
import type { ImageMime, PermissionDecision, RuntimeEvent, StoredConfig, SubmittedImage } from "@agent/core";
import { localTargetsExist, openTarget } from "./openTarget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let appMenu: Menu | null = null;
let runtime: AgentRuntime | null = null;
let permissionGate: DeferredPermissionGate | null = null;
let askGate: DeferredAskGate | null = null;
let workspacePath: string | null = null;

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
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
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

function sendEvent(e: RuntimeEvent) {
  win?.webContents.send("agent:event", e);
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

async function assertKnownWorkspace(raw: string): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Invalid workspace");
  const stored = await loadStoredConfig();
  const match = workspaceList(stored).find((p) => samePath(p, raw));
  if (!match) throw new Error("Unknown workspace");
  await access(match);
  return match;
}

async function ensureRuntime(): Promise<AgentRuntime> {
  if (!workspacePath) throw new Error("No workspace selected");
  if (runtime) return runtime;
  const stored = (await loadStoredConfig()) ?? {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
  };
  const config = toAgentConfig(stored);
  const provider = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  permissionGate = new DeferredPermissionGate();
  askGate = new DeferredAskGate();
  runtime = new AgentRuntime({
    workspacePath,
    config,
    provider,
    permissions: permissionGate,
    asks: askGate,
  });
  runtime.onEvent(sendEvent);
  return runtime;
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

function resetRuntime(): void {
  permissionGate?.denyAll();
  permissionGate = null;
  askGate?.cancelAll();
  askGate = null;
  runtime = null;
}

function createWindow() {
  const preloadPath = join(__dirname, "preload.cjs");
  win = new BrowserWindow({
    width: 1100,
    height: 720,
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

app.whenReady().then(() => {
  installChineseAppMenu();
  createWindow();

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
    resetRuntime();
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
    if (!workspacePath) {
      workspacePath = added;
      resetRuntime();
    }
    await saveStoredConfig({
      ...stored,
      workspacePaths: paths,
      lastWorkspacePath: workspacePath ?? undefined,
    });
    return { active: workspacePath, paths, added, already: Boolean(existing) };
  });

  ipcMain.handle("agent:activateWorkspace", async (_e, raw: string) => {
    const path = await assertKnownWorkspace(raw);
    if (!workspacePath || !samePath(workspacePath, path)) {
      workspacePath = path;
      resetRuntime();
    }
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
  ipcMain.handle("agent:loadWorkspaceArtifacts", async (_e, raw: string, sessionId: string) => {
    const path = await assertKnownWorkspace(raw);
    assertValidSessionId(sessionId);
    const store = new SessionStore(path);
    const meta = await store.getMeta(sessionId);
    const messages = await store.readMessages(sessionId);
    let traces: unknown[] = [];
    try {
      traces = await new TraceStore(path).read(sessionId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const context = await new ContextStore(path).read(sessionId);
    return { meta, messages, traces, context };
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
    await new SessionStore(path).deleteSession(sessionId);
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
    if (workspacePath && samePath(workspacePath, path)) {
      workspacePath = paths[0] ?? null;
      resetRuntime();
    }
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
    return (await ensureRuntime()).createSession(title);
  });
  ipcMain.handle("agent:listSessions", async () => (await ensureRuntime()).listSessions());
  ipcMain.handle("agent:loadMessages", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    return (await ensureRuntime()).loadMessages(sessionId);
  });
  ipcMain.handle("agent:loadSessionArtifacts", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    return (await ensureRuntime()).loadSessionArtifacts(sessionId);
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
    return (await ensureRuntime()).renameSession(sessionId, title, opts);
  });
  ipcMain.handle("agent:deleteSession", async (_e, sessionId: string) => {
    assertValidSessionId(sessionId);
    await (await ensureRuntime()).deleteSession(sessionId);
  });
  ipcMain.handle(
    "agent:submit",
    async (_e, sessionId: string, text: string, images?: unknown) => {
      assertValidSessionId(sessionId);
      await (await ensureRuntime()).submit(sessionId, text, normalizeSubmittedImages(images));
    },
  );
  ipcMain.handle(
    "agent:readSessionImage",
    async (_e, sessionId: string, relativePath: string) => {
      assertValidSessionId(sessionId);
      if (typeof relativePath !== "string") throw new Error("Invalid image path");
      return (await ensureRuntime()).readSessionImage(sessionId, relativePath);
    },
  );
  ipcMain.handle("agent:cancel", async () => {
    permissionGate?.denyAll();
    askGate?.cancelAll();
    runtime?.cancel();
  });
  ipcMain.handle("agent:answerAsk", async (_e, requestId: string, text: string) => {
    if (typeof requestId !== "string" || typeof text !== "string") return false;
    return askGate?.answer(requestId, text) ?? false;
  });
  ipcMain.handle(
    "agent:permissionRespond",
    async (_e, requestId: string, decision: PermissionDecision) => {
      if (decision !== "allow" && decision !== "deny") return false;
      return permissionGate?.respond(requestId, decision) ?? false;
    },
  );
  ipcMain.handle("agent:listSkills", async () => listInstalledSkills());
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
    resetRuntime();
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
