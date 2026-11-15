type McpServerView = {
  name: string;
  enabled: boolean;
  autoAllow: boolean;
  transport: "stdio" | "http";
  summary: string;
  state: "disabled" | "connecting" | "connected" | "error";
  tools: string[];
  error?: string;
  note?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  cwd?: string;
};

type McpSnapshot = { servers: McpServerView[]; fileError?: string };

const STATE_LABEL: Record<McpServerView["state"], string> = {
  disabled: "已停用",
  connecting: "连接中",
  connected: "已连接",
  error: "失败",
};

export function attachMcpLibrary(
  button: HTMLButtonElement,
  page: HTMLElement,
  host: { onOpen: () => void; onClose: () => void },
): void {
  const list = page.querySelector("#mcp-list") as HTMLElement;
  const note = page.querySelector("#mcp-note") as HTMLElement;
  const count = page.querySelector("#mcp-count") as HTMLElement;
  const addBtn = page.querySelector("#mcp-add") as HTMLButtonElement;
  const form = page.querySelector("#mcp-form") as HTMLFormElement;
  const nameInput = page.querySelector("#mcp-name") as HTMLInputElement;
  const transport = page.querySelector("#mcp-transport") as HTMLSelectElement;
  const stdioFields = page.querySelector("#mcp-stdio-fields") as HTMLElement;
  const httpFields = page.querySelector("#mcp-http-fields") as HTMLElement;
  const commandInput = page.querySelector("#mcp-command") as HTMLInputElement;
  const argsInput = page.querySelector("#mcp-args") as HTMLTextAreaElement;
  const envInput = page.querySelector("#mcp-env") as HTMLTextAreaElement;
  const cwdInput = page.querySelector("#mcp-cwd") as HTMLInputElement;
  const urlInput = page.querySelector("#mcp-url") as HTMLInputElement;
  const urlHint = page.querySelector("#mcp-url-hint") as HTMLElement;
  const enabledInput = page.querySelector("#mcp-enabled") as HTMLInputElement;
  const autoInput = page.querySelector("#mcp-auto") as HTMLInputElement;
  const cancelBtn = page.querySelector("#mcp-cancel") as HTMLButtonElement;
  let editing: string | null = null;
  let formOpen = false;

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = err instanceof Error ? err.message : String(err);
  };

  const paintTransport = () => {
    const http = transport.value === "http";
    stdioFields.hidden = http;
    httpFields.hidden = !http;
  };

  const closeForm = () => {
    formOpen = false;
    editing = null;
    form.hidden = true;
    nameInput.disabled = false;
  };

  const openForm = (server?: McpServerView) => {
    formOpen = true;
    editing = server?.name ?? null;
    form.hidden = false;
    nameInput.disabled = Boolean(server);
    nameInput.value = server?.name ?? "";
    transport.value = server?.transport ?? "http";
    commandInput.value = server?.command ?? "";
    argsInput.value = server?.args?.join("\n") ?? "";
    envInput.value = server?.envKeys?.map((key) => `${key}=***`).join("\n") ?? "";
    cwdInput.value = server?.cwd ?? "";
    urlInput.value = "";
    urlHint.textContent = server?.transport === "http"
      ? `当前：${server.summary}。留空不改。密钥打码只影响显示。`
      : "高德把密钥放在 key 参数里。列表和报错会打码，配置文件里仍保留原文。";
    enabledInput.checked = server ? server.enabled : true;
    autoInput.checked = server?.autoAllow ?? false;
    paintTransport();
    (server ? transport : nameInput).focus();
  };

  async function reload(): Promise<void> {
    const snapshot = await window.agent.listMcpServers();
    paint(snapshot);
  }

  function paint(snapshot: McpSnapshot): void {
    count.textContent = `已配置(${snapshot.servers.length})`;
    if (snapshot.fileError) showNote(snapshot.fileError);
    else note.hidden = true;
    list.replaceChildren();
    if (!snapshot.servers.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty mcp-empty";
      empty.textContent =
        "还没有 MCP server。本机命令会拉起子进程；远程地址用 Streamable HTTP，例如高德 https://mcp.amap.com/mcp?key=你的Key 。";
      list.append(empty);
      return;
    }
    for (const server of snapshot.servers) list.append(serverCard(server));
  }

  function serverCard(server: McpServerView): HTMLElement {
    const card = document.createElement("article");
    card.className = "mcp-card" + (server.enabled ? "" : " is-off");
    const head = document.createElement("div");
    head.className = "mcp-card-head";
    const name = document.createElement("span");
    name.className = "skill-card-name";
    name.textContent = server.name;
    const state = document.createElement("span");
    state.className = "mcp-state" + (server.state === "error" ? " is-error" : server.state === "connected" ? " is-ok" : "");
    state.textContent = STATE_LABEL[server.state];
    head.append(name, state);

    const summary = document.createElement("p");
    summary.className = "mcp-summary";
    summary.textContent = server.summary;

    card.append(head, summary);
    if (server.tools.length) {
      const tools = document.createElement("p");
      tools.className = "mcp-tools";
      const shown = server.tools.slice(0, 12).join("、");
      tools.textContent = server.tools.length > 12 ? `${shown} 等 ${server.tools.length} 个工具` : shown;
      card.append(tools);
    }
    if (server.note) card.append(line(server.note, "mcp-note-line"));
    if (server.error) card.append(line(server.error, "mcp-error"));

    const actions = document.createElement("div");
    actions.className = "mcp-actions";
    actions.append(
      switchButton(server.enabled, `${server.enabled ? "停用" : "启用"} ${server.name}`, () => {
        void run(() => window.agent.setMcpEnabled(server.name, !server.enabled));
      }),
      textButton(server.autoAllow ? "查询已自动放行" : "查询要确认", () => {
        void run(() => window.agent.setMcpAutoAllow(server.name, !server.autoAllow));
      }),
      textButton("重新连接", () => {
        void run(() => window.agent.reconnectMcpServer(server.name));
      }, server.state === "connecting" || !server.enabled),
      textButton("修改", () => openForm(server)),
      textButton("移除", () => {
        void run(async () => {
          if (editing === server.name) closeForm();
          await window.agent.removeMcpServer(server.name);
        });
      }, false, true),
    );
    card.append(actions);
    return card;
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      if (!page.querySelector("#mcp-note")?.textContent || note.textContent === "") note.hidden = true;
      await reload();
    } catch (err) {
      showNote(err);
    }
  }

  transport.addEventListener("change", paintTransport);
  addBtn.onclick = () => openForm();
  cancelBtn.onclick = () => closeForm();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    void run(async () => {
      const input = readForm();
      if (editing) await window.agent.updateMcpServer(editing, input);
      else await window.agent.addMcpServer(input);
      closeForm();
    });
  };

  button.onclick = () => {
    if (!page.hidden) {
      host.onClose();
      return;
    }
    note.hidden = true;
    host.onOpen();
    void reload().catch(showNote);
  };

  const reloadIfOpen = () => {
    if (page.hidden || formOpen) return;
    void reload().catch(showNote);
  };
  window.agent.onMcpStatus?.(() => {
    if (page.hidden) return;
    void reload().catch(showNote);
  });
  window.addEventListener("focus", reloadIfOpen);

  function readForm(): Record<string, unknown> {
    const name = (editing ?? nameInput.value).trim();
    const enabled = enabledInput.checked;
    const autoAllow = autoInput.checked;
    if (transport.value === "http") {
      return { name, enabled, autoAllow, transport: "http", url: urlInput.value.trim() };
    }
    return {
      name,
      enabled,
      autoAllow,
      transport: "stdio",
      command: commandInput.value.trim(),
      args: lines(argsInput.value),
      env: parseEnv(envInput.value),
      cwd: cwdInput.value.trim(),
    };
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`环境变量须是 KEY=VALUE：${line}`);
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

function line(text: string, className: string): HTMLElement {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

function textButton(label: string, onClick: () => void, disabled = false, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "skill-card-remove" : "mcp-text";
  button.textContent = label;
  button.disabled = disabled;
  button.onclick = onClick;
  return button;
}

function switchButton(on: boolean, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "skill-switch";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", on ? "true" : "false");
  button.setAttribute("aria-label", label);
  const knob = document.createElement("span");
  knob.className = "skill-switch-knob";
  knob.setAttribute("aria-hidden", "true");
  button.append(knob);
  button.onclick = onClick;
  return button;
}
