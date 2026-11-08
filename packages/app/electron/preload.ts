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
  loadWorkspaceArtifacts: (path: string, sessionId: string) =>
    ipcRenderer.invoke("agent:loadWorkspaceArtifacts", path, sessionId),
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
  loadSessionArtifacts: (sessionId: string) =>
    ipcRenderer.invoke("agent:loadSessionArtifacts", sessionId),
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
  ) => ipcRenderer.invoke("agent:submit", sessionId, text, images),
  watchSession: (sessionId: string | null) => ipcRenderer.invoke("agent:watchSession", sessionId),
  listSkills: () => ipcRenderer.invoke("agent:listSkills"),
  installSkill: () => ipcRenderer.invoke("agent:installSkill"),
  setSkillEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("agent:setSkillEnabled", name, enabled),
  uninstallSkill: (name: string) => ipcRenderer.invoke("agent:uninstallSkill", name),
  openSkillFolder: (name: string) => ipcRenderer.invoke("agent:openSkillFolder", name),
  readSessionImage: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke("agent:readSessionImage", sessionId, relativePath),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  respondPermission: (requestId: string, decision: "allow" | "deny") =>
    ipcRenderer.invoke("agent:permissionRespond", requestId, decision),
  answerAsk: (requestId: string, text: string) =>
    ipcRenderer.invoke("agent:answerAsk", requestId, text),
  getConfig: () => ipcRenderer.invoke("agent:getConfig"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("agent:saveConfig", cfg),
  localTargetsExist: (targets: string[]) => ipcRenderer.invoke("agent:localTargetsExist", targets),
  openExternal: (target: string) => ipcRenderer.invoke("agent:openExternal", target),
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
});
