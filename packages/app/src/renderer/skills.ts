type SkillSummary = { name: string; description: string; enabled: boolean };

const TOKEN_AT_CURSOR = /(^|\s)\/([a-z0-9-]*)$/;
export function skillTokensIn(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const token = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
  for (const match of text.matchAll(token)) {
    const name = match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

let inputEl: HTMLTextAreaElement | null = null;
let menuEl: HTMLElement | null = null;
let installed: SkillSummary[] = [];
let visible: SkillSummary[] = [];
let menuIndex = 0;
let menuOpen = false;

export function attachSkillMenu(input: HTMLTextAreaElement, menu: HTMLElement): void {
  inputEl = input;
  menuEl = menu;
  input.addEventListener("input", () => {
    void refreshSkillMenu();
  });
  input.addEventListener("click", () => {
    void refreshSkillMenu();
  });
  input.addEventListener("keyup", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
      void refreshSkillMenu();
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement === inputEl) return;
      closeSkillMenu();
    }, 120);
  });
}

export function onSkillMenuKey(ev: KeyboardEvent): boolean {
  if (!menuOpen || !menuEl || menuEl.hidden) return false;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    if (visible.length) {
      menuIndex = (menuIndex + 1) % visible.length;
      paintSkillMenu();
    }
    return true;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    if (visible.length) {
      menuIndex = (menuIndex - 1 + visible.length) % visible.length;
      paintSkillMenu();
    }
    return true;
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeSkillMenu();
    return true;
  }
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    const skill = visible[menuIndex];
    if (skill) insertSkill(skill.name);
    return true;
  }
  return false;
}

export function attachSkillLibrary(
  button: HTMLButtonElement,
  page: HTMLElement,
  host: { onOpen: () => void; onClose: () => void },
): void {
  const list = page.querySelector("#skills-list") as HTMLElement;
  const note = page.querySelector("#skills-note") as HTMLElement;
  const count = page.querySelector("#skills-count") as HTMLElement;
  const addBtn = page.querySelector("#skills-add") as HTMLButtonElement;

  const showNote = (err: unknown) => {
    note.hidden = false;
    note.textContent = err instanceof Error ? err.message : String(err);
  };

  async function reload(): Promise<void> {
    const skills = await window.agent.listSkills();
    count.textContent = `已安装(${skills.length})`;
    list.replaceChildren();
    if (!skills.length) {
      const empty = document.createElement("p");
      empty.className = "skill-empty";
      empty.textContent = "尚未安装技能。安装后，Skill的名字和frontmatter会进入之后的每次LLM请求。";
      list.append(empty);
      return;
    }
    for (const skill of skills) list.append(skillCard(skill, run));
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      const result = await action();
      if (result === null) return;
      note.hidden = true;
      await reload();
    } catch (err) {
      showNote(err);
    }
  }

  const reloadIfOpen = () => {
    if (page.hidden) return;
    void reload().catch(showNote);
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
  addBtn.onclick = () => {
    void run(() => window.agent.installSkill());
  };
  window.addEventListener("focus", reloadIfOpen);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reloadIfOpen();
  });
  window.agent.onSkillsChanged?.(reloadIfOpen);
}

function skillCard(skill: SkillSummary, run: (action: () => Promise<unknown>) => Promise<void>): HTMLElement {
  const card = document.createElement("article");
  card.className = "skill-card" + (skill.enabled ? "" : " is-off");

  const open = document.createElement("button");
  open.type = "button";
  open.className = "skill-card-open";
  open.setAttribute("aria-label", `打开技能目录 ${skill.name}`);

  const mark = document.createElement("span");
  mark.className = `skill-mark tile-${tileIndex(skill.name)}`;
  mark.textContent = monogram(skill.name);
  mark.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "skill-card-text";
  const name = document.createElement("span");
  name.className = "skill-card-name";
  name.textContent = skill.name;
  const desc = document.createElement("span");
  desc.className = "skill-card-desc";
  desc.textContent = skill.description.replace(/\s+/g, " ").trim();
  text.append(name, desc);
  open.append(mark, text);
  open.onclick = () => {
    void run(() => window.agent.openSkillFolder(skill.name));
  };

  const actions = document.createElement("div");
  actions.className = "skill-card-actions";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "skill-switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", skill.enabled ? "true" : "false");
  toggle.setAttribute("aria-label", `${skill.enabled ? "停用" : "启用"} ${skill.name}`);
  const knob = document.createElement("span");
  knob.className = "skill-switch-knob";
  knob.setAttribute("aria-hidden", "true");
  toggle.append(knob);
  toggle.onclick = () => {
    void run(() => window.agent.setSkillEnabled(skill.name, !skill.enabled));
  };
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "skill-card-remove";
  remove.textContent = "卸载";
  remove.onclick = () => {
    void run(() => window.agent.uninstallSkill(skill.name));
  };
  actions.append(toggle, remove);
  card.append(open, actions);
  return card;
}

function monogram(name: string): string {
  const parts = name.split("-").filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1]?.slice(0, 1) ?? first.slice(1, 2);
  return (first.slice(0, 1) + second).toUpperCase();
}

function tileIndex(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash + ch.charCodeAt(0)) % 4;
  return hash;
}

function partialAtCursor(): string | null {
  if (!inputEl) return null;
  const cursor = inputEl.selectionStart ?? inputEl.value.length;
  const match = TOKEN_AT_CURSOR.exec(inputEl.value.slice(0, cursor));
  if (!match) return null;
  const partial = match[2] ?? "";
  if (partial.startsWith("-") || partial.includes("--")) return null;
  return partial;
}

let refreshGen = 0;

async function refreshSkillMenu(): Promise<void> {
  const gen = ++refreshGen;
  const partial = partialAtCursor();
  if (partial == null || !inputEl || inputEl.disabled) {
    closeSkillMenu();
    return;
  }
  try {
    installed = await window.agent.listSkills();
  } catch {
    installed = [];
  }
  if (gen !== refreshGen) return;
  const needle = partial.toLowerCase();
  const usable = installed.filter((skill) => skill.enabled);
  visible = usable.filter(
    (skill) =>
      skill.name.includes(needle) || skill.description.toLowerCase().replace(/\s+/g, " ").includes(needle),
  );
  menuIndex = Math.min(menuIndex, Math.max(visible.length - 1, 0));
  menuOpen = true;
  paintSkillMenu();
}

function paintSkillMenu(): void {
  if (!menuEl) return;
  menuEl.hidden = false;
  menuEl.replaceChildren();
  if (!installed.length) {
    menuEl.append(menuMessage("尚未安装技能"));
    return;
  }
  if (!installed.some((skill) => skill.enabled)) {
    menuEl.append(menuMessage("技能都已停用"));
    return;
  }
  if (!visible.length) {
    menuEl.append(menuMessage("没有匹配的技能"));
    return;
  }
  visible.forEach((skill, itemIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skill-menu-item" + (itemIndex === menuIndex ? " is-active" : "");
    button.setAttribute("role", "option");
    if (itemIndex === menuIndex) button.setAttribute("aria-selected", "true");
    const name = document.createElement("span");
    name.className = "skill-menu-name";
    name.textContent = skill.name;
    const desc = document.createElement("span");
    desc.className = "skill-menu-desc";
    desc.textContent = skill.description.replace(/\s+/g, " ").trim();
    button.append(name, desc);
    button.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      insertSkill(skill.name);
    });
    menuEl?.append(button);
  });
}

function menuMessage(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "skill-menu-empty";
  node.textContent = text;
  return node;
}

function insertSkill(name: string): void {
  const input = inputEl;
  if (!input) return;
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const after = input.value.slice(cursor);
  const match = TOKEN_AT_CURSOR.exec(before);
  if (!match) return;
  const start = before.length - match[0].length;
  const inserted = `${before.slice(0, start)}${match[1]}/${name} `;
  const rest = after.startsWith(" ") ? after.slice(1) : after;
  input.value = inserted + rest;
  const caret = inserted.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeSkillMenu();
  input.focus();
}

function closeSkillMenu(): void {
  refreshGen += 1;
  menuOpen = false;
  visible = [];
  menuIndex = 0;
  if (menuEl) {
    menuEl.hidden = true;
    menuEl.replaceChildren();
  }
}
