/**
 * Must compile to CommonJS (.cjs). Sandboxed Electron preloads cannot use ESM import.
 */
import { contextBridge, ipcRenderer } from "electron";

type RuntimeEvent = { type: string; [key: string]: unknown };

contextBridge.exposeInMainWorld("agent", {
  getWorkspace: () => ipcRenderer.invoke("agent:getWorkspace"),
  restoreWorkspace: () => ipcRenderer.invoke("agent:restoreWorkspace"),
  addWorkspace: () => ipcRenderer.invoke("agent:addWorkspace"),
  activateWorkspace: (path: string) => ipcRenderer.invoke("agent:activateWorkspace", path),
  setWorkspaceExpanded: (path: string, open: boolean) =>
    ipcRenderer.invoke("agent:setWorkspaceExpanded", path, open),
  listWorkspaceSessions: (path: string) => ipcRenderer.invoke("agent:listWorkspaceSessions", path),
  loadWorkspaceMessages: (path: string, sessionId: string) =>
    ipcRenderer.invoke("agent:loadWorkspaceMessages", path, sessionId),
  loadWorkspaceArtifacts: (path: string, sessionId: string, part?: string) =>
    ipcRenderer.invoke("agent:loadWorkspaceArtifacts", path, sessionId, part),
  readWorkspaceImage: (path: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readWorkspaceImage", path, sessionId, relativePath),
  readWorkspaceVideo: (path: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readWorkspaceVideo", path, sessionId, relativePath),
  readWorkspaceAudio: (path: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readWorkspaceAudio", path, sessionId, relativePath),
  renameWorkspaceSession: (
    path: string,
    sessionId: string,
    title: string,
    opts?: { source?: "user" | "auto" },
  ) => ipcRenderer.invoke("agent:renameWorkspaceSession", path, sessionId, title, opts),
  deleteWorkspaceSession: (path: string, sessionId: string) =>
    ipcRenderer.invoke("agent:deleteWorkspaceSession", path, sessionId),
  openWorkspaceFolder: (path: string) => ipcRenderer.invoke("agent:openWorkspaceFolder", path),
  renameWorkspace: (path: string, name: string) =>
    ipcRenderer.invoke("agent:renameWorkspace", path, name),
  removeWorkspace: (path: string) => ipcRenderer.invoke("agent:removeWorkspace", path),
  createSession: (title?: string, workspace?: string) =>
    ipcRenderer.invoke("agent:createSession", title, workspace),
  listSessions: () => ipcRenderer.invoke("agent:listSessions"),
  loadMessages: (sessionId: string) => ipcRenderer.invoke("agent:loadMessages", sessionId),
  loadSubagentSteps: (sessionId: string) => ipcRenderer.invoke("agent:loadSubagentSteps", sessionId),
  loadTasks: (sessionId: string) => ipcRenderer.invoke("agent:loadTasks", sessionId),
  loadWorkspaceTasks: (path: string, sessionId: string) =>
    ipcRenderer.invoke("agent:loadWorkspaceTasks", path, sessionId),
  loadWorkspaceSubagentSteps: (path: string, sessionId: string) =>
    ipcRenderer.invoke("agent:loadWorkspaceSubagentSteps", path, sessionId),
  loadSessionArtifacts: (sessionId: string, part?: string) =>
    ipcRenderer.invoke("agent:loadSessionArtifacts", sessionId, part),
  renameSession: (
    sessionId: string,
    title: string,
    opts?: { source?: "user" | "auto" },
  ) => ipcRenderer.invoke("agent:renameSession", sessionId, title, opts),
  deleteSession: (sessionId: string) => ipcRenderer.invoke("agent:deleteSession", sessionId),
  submit: (
    sessionId: string,
    text: string,
    images?: Array<{ mime: string; base64: string }>,
    videos?: Array<{ mime: string; base64: string }>,
    workspace?: string,
    audios?: Array<{ mime: string; base64: string }>,
  ) => ipcRenderer.invoke("agent:submit", sessionId, text, images, videos, workspace, audios),
  replay: (
    sessionId: string,
    text: string,
    images: Array<{ id: string; mime: string; path: string }>,
    videos?: Array<{ id: string; mime: string; path: string }>,
    workspace?: string,
    audios?: Array<{ id: string; mime: string; path: string }>,
  ) => ipcRenderer.invoke("agent:replay", sessionId, text, images, videos, workspace, audios),
  watchSession: (sessionId: string | null, workspace?: string) =>
    ipcRenderer.invoke("agent:watchSession", sessionId, workspace),
  listSkills: () => ipcRenderer.invoke("agent:listSkills"),
  skillTokens: (text: string) => ipcRenderer.invoke("agent:skillTokens", text),
  installSkill: () => ipcRenderer.invoke("agent:installSkill"),
  setSkillEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("agent:setSkillEnabled", name, enabled),
  uninstallSkill: (name: string) => ipcRenderer.invoke("agent:uninstallSkill", name),
  openSkillFolder: (name: string) => ipcRenderer.invoke("agent:openSkillFolder", name),
  listMcpServers: () => ipcRenderer.invoke("agent:listMcpServers"),
  addMcpServer: (input: unknown) => ipcRenderer.invoke("agent:addMcpServer", input),
  updateMcpServer: (name: string, input: unknown) => ipcRenderer.invoke("agent:updateMcpServer", name, input),
  removeMcpServer: (name: string) => ipcRenderer.invoke("agent:removeMcpServer", name),
  setMcpEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke("agent:setMcpEnabled", name, enabled),
  setMcpAutoAllow: (name: string, autoAllow: boolean) =>
    ipcRenderer.invoke("agent:setMcpAutoAllow", name, autoAllow),
  reconnectMcpServer: (name: string) => ipcRenderer.invoke("agent:reconnectMcpServer", name),
  onMcpStatus: (cb: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on("agent:mcpStatus", listener);
    return () => ipcRenderer.removeListener("agent:mcpStatus", listener);
  },
  readSessionImage: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readSessionImage", sessionId, relativePath),
  readSessionVideo: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readSessionVideo", sessionId, relativePath),
  readSessionAudio: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readSessionAudio", sessionId, relativePath),
  asrMicStart: () => ipcRenderer.invoke("agent:asrMicStart"),
  asrMicChunk: (pcm: ArrayBuffer | Uint8Array) => ipcRenderer.invoke("agent:asrMicChunk", pcm),
  asrMicStop: () => ipcRenderer.invoke("agent:asrMicStop"),
  onAsrPartial: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: unknown) => {
      if (typeof text === "string") cb(text);
    };
    ipcRenderer.on("agent:asr-partial", listener);
    return () => ipcRenderer.removeListener("agent:asr-partial", listener);
  },
  onAsrFinal: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: unknown) => {
      if (typeof text === "string") cb(text);
    };
    ipcRenderer.on("agent:asr-final", listener);
    return () => ipcRenderer.removeListener("agent:asr-final", listener);
  },
  onAsrError: (cb: (message: string) => void) => {
    const listener = (_: unknown, message: unknown) => {
      if (typeof message === "string") cb(message);
    };
    ipcRenderer.on("agent:asr-error", listener);
    return () => ipcRenderer.removeListener("agent:asr-error", listener);
  },
  onAsrClosed: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("agent:asr-closed", listener);
    return () => ipcRenderer.removeListener("agent:asr-closed", listener);
  },
  cancel: (sessionId?: string, workspace?: string) =>
    ipcRenderer.invoke("agent:cancel", sessionId, workspace),
  explainLoad: (workspace: string, sessionId: string) =>
    ipcRenderer.invoke("agent:explainLoad", workspace, sessionId),
  explainSetOpen: (workspace: string, sessionId: string, open: boolean) =>
    ipcRenderer.invoke("agent:explainSetOpen", workspace, sessionId, open),
  explainSubmit: (
    workspace: string,
    sessionId: string,
    text: string,
    images?: Array<{ mime: string; base64: string }>,
    sourceMessageIds?: string[] | null,
    videos?: Array<{ mime: string; base64: string }>,
  ) => ipcRenderer.invoke("agent:explainSubmit", workspace, sessionId, text, images, sourceMessageIds, videos),
  explainCancel: () => ipcRenderer.invoke("agent:explainCancel"),
  explainReadImage: (workspace: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:explainReadImage", workspace, sessionId, relativePath),
  explainReadVideo: (workspace: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:explainReadVideo", workspace, sessionId, relativePath),
  onExplainEvent: (cb: (e: RuntimeEvent) => void) => {
    const listener = (_: unknown, e: RuntimeEvent) => cb(e);
    ipcRenderer.on("agent:explain-event", listener);
    return () => ipcRenderer.removeListener("agent:explain-event", listener);
  },
  respondPermission: (requestId: string, decision: "allow" | "deny") =>
    ipcRenderer.invoke("agent:permissionRespond", requestId, decision),
  answerAsk: (requestId: string, text: string) =>
    ipcRenderer.invoke("agent:answerAsk", requestId, text),
  getHomeInfo: () => ipcRenderer.invoke("agent:getHomeInfo"),
  setHomeLabel: (label: string) => ipcRenderer.invoke("agent:setHomeLabel", label),
  openHomeDir: () => ipcRenderer.invoke("agent:openHomeDir"),
  getConfig: () => ipcRenderer.invoke("agent:getConfig"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("agent:saveConfig", cfg),
  localTargetsExist: (targets: string[]) => ipcRenderer.invoke("agent:localTargetsExist", targets),
  openExternal: (target: string) => ipcRenderer.invoke("agent:openExternal", target),
  browserShow: (box: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("agent:browserShow", box),
  browserMove: (box: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("agent:browserBounds", box),
  browserHide: () => ipcRenderer.send("agent:browserHide"),
  browserSelect: (id: string) => ipcRenderer.send("agent:browserSelect", id),
  browserNewTab: () => ipcRenderer.send("agent:browserNew"),
  browserOpenDeepseek: () => ipcRenderer.send("agent:browserDeepseek"),
  browserCloseTab: (id: string) => ipcRenderer.send("agent:browserClose", id),
  browserBack: () => ipcRenderer.send("agent:browserBack"),
  browserForward: () => ipcRenderer.send("agent:browserForward"),
  browserReload: () => ipcRenderer.send("agent:browserReload"),
  browserGo: (text: string) => ipcRenderer.invoke("agent:browserGo", text),
  onBrowserExplain: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: unknown) => {
      if (typeof text === "string") cb(text);
    };
    ipcRenderer.on("agent:browserExplain", listener);
    return () => ipcRenderer.removeListener("agent:browserExplain", listener);
  },
  onBrowserState: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on("agent:browserState", listener);
    return () => ipcRenderer.removeListener("agent:browserState", listener);
  },
  addFavoriteFolder: () => ipcRenderer.invoke("agent:addFavoriteFolder"),
  removeFavoriteFolder: (path: string) => ipcRenderer.invoke("agent:removeFavoriteFolder", path),
  reorderFavoriteFolders: (paths: string[]) => ipcRenderer.invoke("agent:reorderFavoriteFolders", paths),
  memoryLoad: (workspace: string | null) => ipcRenderer.invoke("agent:memoryLoad", workspace),
  memorySave: (workspace: string | null, scope: string, name: string, change: { description: string; body: string }) =>
    ipcRenderer.invoke("agent:memorySave", workspace, scope, name, change),
  memoryDelete: (workspace: string | null, scope: string, name: string) =>
    ipcRenderer.invoke("agent:memoryDelete", workspace, scope, name),
  memoryUndo: (workspace: string | null, scope: string, journalId: string) =>
    ipcRenderer.invoke("agent:memoryUndo", workspace, scope, journalId),
  memoryOpenDir: (workspace: string | null, scope: string) =>
    ipcRenderer.invoke("agent:memoryOpenDir", workspace, scope),
  memoryRevealInstructions: (workspace: string | null, scope: string) =>
    ipcRenderer.invoke("agent:memoryRevealInstructions", workspace, scope),
  setAutoMemory: (on: boolean) => ipcRenderer.invoke("agent:setAutoMemory", on),
  popupAppMenu: (index: number, x: number, y: number) =>
    ipcRenderer.invoke("agent:popupAppMenu", index, x, y),
  setTaskbarPrompt: (open: boolean, inView: boolean) =>
    ipcRenderer.invoke("agent:setTaskbarPrompt", open, inView),
  onEvent: (cb: (e: RuntimeEvent) => void) => {
    const listener = (_: unknown, e: RuntimeEvent) => cb(e);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onSkillsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("agent:skillsChanged", listener);
    return () => ipcRenderer.removeListener("agent:skillsChanged", listener);
  },
  onMemoryEvent: (cb: (e: RuntimeEvent) => void) => {
    const listener = (_: unknown, e: RuntimeEvent) => cb(e);
    ipcRenderer.on("agent:memory-event", listener);
    return () => ipcRenderer.removeListener("agent:memory-event", listener);
  },
});
