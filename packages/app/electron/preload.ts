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
  createSession: (title?: string) => ipcRenderer.invoke("agent:createSession", title),
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
    workspace?: string,
  ) => ipcRenderer.invoke("agent:submit", sessionId, text, images, workspace),
  replay: (
    sessionId: string,
    text: string,
    images: Array<{ id: string; mime: string; path: string }>,
    workspace?: string,
  ) => ipcRenderer.invoke("agent:replay", sessionId, text, images, workspace),
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
  ) => ipcRenderer.invoke("agent:explainSubmit", workspace, sessionId, text, images, sourceMessageIds),
  explainCancel: () => ipcRenderer.invoke("agent:explainCancel"),
  explainReadImage: (workspace: string, sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:explainReadImage", workspace, sessionId, relativePath),
  onExplainEvent: (cb: (e: RuntimeEvent) => void) => {
    const listener = (_: unknown, e: RuntimeEvent) => cb(e);
    ipcRenderer.on("agent:explain-event", listener);
    return () => ipcRenderer.removeListener("agent:explain-event", listener);
  },
  respondPermission: (requestId: string, decision: "allow" | "deny") =>
    ipcRenderer.invoke("agent:permissionRespond", requestId, decision),
  answerAsk: (requestId: string, text: string) =>
    ipcRenderer.invoke("agent:answerAsk", requestId, text),
  getConfig: () => ipcRenderer.invoke("agent:getConfig"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("agent:saveConfig", cfg),
  localTargetsExist: (targets: string[]) => ipcRenderer.invoke("agent:localTargetsExist", targets),
  openExternal: (target: string) => ipcRenderer.invoke("agent:openExternal", target),
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
