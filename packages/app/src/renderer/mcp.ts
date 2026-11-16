type McpToolView = { name: string; description?: string };

type McpServerView = {
  name: string;
  label: string;
  enabled: boolean;
  autoAllow: boolean;
  transport: "stdio" | "http";
  summary: string;
  state: "disabled" | "connecting" | "connected" | "error";
  tools: McpToolView[];
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
  const labelInput = page.querySelector("#mcp-label") as HTMLInputElement;
  const slugLine = page.querySelector("#mcp-slug") as HTMLElement;
  const derived = page.querySelector("#mcp-id-derived") as HTMLElement;
  const idBlock = page.querySelector("#mcp-id-block") as HTMLElement;
  const idHint = page.querySelector("#mcp-id-hint") as HTMLElement;
  const nameField = page.querySelector("#mcp-name-field") as HTMLElement;
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
  let listed: string[] = [];

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = plainError(err);
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
    nameField.hidden = true;
    nameInput.disabled = false;
  };

  const refreshSlug = () => {
    if (editing) {
      showDerivedId(editing, `用来生成工具名 mcp__${editing}__工具名，保存后不能改。`);
      return;
    }
    if (!sourceReady()) {
      idBlock.hidden = true;
      derived.hidden = true;
      nameField.hidden = true;
      nameInput.value = "";
      return;
    }
    const http = transport.value === "http";
    const base = http
      ? serverNameFromUrl(urlInput.value)
      : serverNameFromCommand(commandInput.value, lines(argsInput.value));
    if (!base) {
      idBlock.hidden = false;
      derived.hidden = true;
      nameField.hidden = false;
      nameInput.value = "";
      idHint.textContent = "这里生成不了标识。用小写字母、数字和单个连字符，保存后不能改。";
      return;
    }
    const name = unusedName(base, listed);
    const clash = name !== base ? `${base} 已被占用，改用 ${name}。` : "";
    const from = http ? "从地址生成。" : "从命令生成。";
    showDerivedId(name, `${clash || from}用来生成工具名 mcp__${name}__工具名，保存后不能改。`);
  };

  const showDerivedId = (name: string, hint: string) => {
    idBlock.hidden = false;
    derived.hidden = false;
    nameField.hidden = true;
    slugLine.textContent = name;
    nameInput.value = name;
    idHint.textContent = hint;
  };

  const sourceReady = (): boolean => {
    if (transport.value === "http") {
      try {
        return Boolean(new URL(urlInput.value.trim()).hostname);
      } catch {
        return false;
      }
    }
    const command = commandInput.value.trim().toLowerCase().replace(/\.(cmd|exe)$/i, "");
    if (!command) return false;
    const positional = lines(argsInput.value).filter((arg) => !arg.startsWith("-"));
    if (["npx", "npm", "pnpm", "yarn", "node"].includes(command)) return positional.length > 0;
    return true;
  };

  const openForm = (server?: McpServerView) => {
    formOpen = true;
    editing = server?.name ?? null;
    form.hidden = false;
    labelInput.value = server && server.label !== server.name ? server.label : "";
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
      : "查询参数里的 key、token、secret、password 会在列表和报错里打码，配置文件仍保留原文。";
    enabledInput.checked = server ? server.enabled : true;
    autoInput.checked = server?.autoAllow ?? false;
    paintTransport();
    refreshSlug();
    labelInput.focus();
  };

  async function reload(): Promise<void> {
    const snapshot = await window.agent.listMcpServers();
    paint(snapshot);
  }

  function paint(snapshot: McpSnapshot): void {
    count.textContent = `已配置(${snapshot.servers.length})`;
    listed = snapshot.servers.map((server) => server.name);
    if (snapshot.fileError) showNote(snapshot.fileError);
    else note.hidden = true;
    list.replaceChildren();
    if (!snapshot.servers.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty mcp-empty";
      empty.textContent =
        "还没有 MCP server。本机命令会拉起子进程；远程地址填一条 Streamable HTTP URL。";
      list.append(empty);
      return;
    }
    for (const server of snapshot.servers) list.append(serverRow(server));
  }

  function serverRow(server: McpServerView): HTMLElement {
    const row = document.createElement("article");
    row.className = "mcp-row" + (server.enabled ? "" : " is-off");
    const main = document.createElement("div");
    main.className = "mcp-row-main";

    const title = document.createElement("div");
    title.className = "mcp-row-title";
    const heading = document.createElement("span");
    heading.className = "mcp-label";
    heading.textContent = server.label || server.name;
    const id = document.createElement("span");
    id.className = "mcp-id";
    id.textContent = server.label && server.label !== server.name ? server.name : "";
    const state = document.createElement("span");
    state.className = "mcp-state" + (server.state === "error" ? " is-error" : server.state === "connected" ? " is-ok" : "");
    state.textContent = STATE_LABEL[server.state];
    title.append(heading, id, state);

    const summary = document.createElement("p");
    summary.className = "mcp-summary";
    summary.textContent = server.summary;

    const actions = document.createElement("div");
    actions.className = "mcp-actions";
    actions.append(
      switchButton(server.enabled, `${server.enabled ? "停用" : "启用"} ${server.label || server.name}`, () => {
        void run(() => window.agent.setMcpEnabled(server.name, !server.enabled));
      }),
      textButton(server.autoAllow ? "关闭自动放行" : "打开自动放行", () => {
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
    main.append(title, summary, actions);
    row.append(main);
    if (server.tools.length) row.append(toolList(server.tools));
    if (server.note) row.append(line(server.note, "mcp-note-line"));
    if (server.error) row.append(line(server.error, "mcp-error"));
    return row;
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

  transport.addEventListener("change", () => {
    paintTransport();
    refreshSlug();
  });
  urlInput.addEventListener("input", refreshSlug);
  commandInput.addEventListener("input", refreshSlug);
  argsInput.addEventListener("input", refreshSlug);
  addBtn.onclick = () => openForm();
  cancelBtn.onclick = () => closeForm();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    void run(async () => {
      const name = nameInput.value.trim();
      if (!editing && !isServerName(name)) {
        throw new Error("地址或命令还没写完整，连接标识会跟着生成");
      }
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
    const label = labelInput.value.trim();
    const enabled = enabledInput.checked;
    const autoAllow = autoInput.checked;
    if (transport.value === "http") {
      return { name, label, enabled, autoAllow, transport: "http", url: urlInput.value.trim() };
    }
    return {
      name,
      label,
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

function isServerName(name: string): boolean {
  return name.length >= 1 && name.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** Electron wraps a thrown Error as `Error invoking remote method 'channel': Error: …`. */
function plainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
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

function toolList(tools: McpToolView[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "mcp-tools";
  for (const tool of tools) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "mcp-tool-name";
    name.textContent = tool.name;
    item.append(name);
    if (tool.description) {
      const desc = document.createElement("span");
      desc.className = "mcp-tool-desc";
      desc.textContent = tool.description;
      item.append(desc);
    }
    list.append(item);
  }
  return list;
}

const SLUG_SKIP = new Set(["index", "main", "dist", "src", "bin", "cmd", "npx", "npm", "pnpm", "yarn", "node"]);

function serverNameFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return slugify(host);
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.startsWith("mcp.")) host = host.slice(4);
  return slugify(host.split(".")[0] ?? "");
}

function serverNameFromCommand(command: string, args: readonly string[]): string | null {
  const parts: string[] = [];
  for (const arg of [command, ...args]) {
    if (!arg || arg.startsWith("-")) continue;
    for (const piece of arg.replace(/^@/, "").split(/[/\\]/)) {
      parts.push(piece.replace(/\.(cmd|exe|js|mjs|cjs)$/i, ""));
    }
  }
  const picked = [...parts].reverse().find((part) => part && !SLUG_SKIP.has(part.toLowerCase()));
  return slugify(picked ?? "");
}

function slugify(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return isServerName(slug) ? slug : null;
}

function unusedName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const stem = base.slice(0, 32 - suffix.length).replace(/-+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (isServerName(candidate) && !taken.includes(candidate)) return candidate;
  }
  return "";
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
  button.className = danger ? "mcp-btn mcp-btn-danger" : "mcp-btn";
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
