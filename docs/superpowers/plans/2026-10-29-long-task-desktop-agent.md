# 长任务桌面 Agent（第一阶段）实现计划

> **状态：已过时（历史文档）。** 本文记录的是第一阶段的实现标准，路径、命令和范围说明都停留在当时的设计，不再更新。仓库现状已超出本文范围（例如记忆、subagents、模型页等）。**请不要按本文逐步执行。** 当前结构以仓库代码和各自的 `README.md` 为准。

> **致 agentic worker：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现本计划。各步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标（Goal）：** 构建第一阶段的 Electron 桌面 Agent：运行单 session、可中断、上限 50 步的 ReAct 循环，提供 bash/Read/search 工具，支持 OpenAI-compatible 流式输出，并为本地代码仓库 workspace 提供可恢复的 `.agent/` jsonl+trace 存储。

**架构（Architecture）：** Monorepo，包含 `packages/core`（纯 TypeScript 库：session store、上下文组装/压缩、Tool Host、AgentRuntime、OpenAI-compatible provider、事件发射器）和 `packages/app`（轻量 Electron 外壳：左侧 session 列表 + 中间对话区；IPC 仅负责提交/取消以及订阅 core 事件）。一个 session 绑定一个 workspace 目录；工具被沙箱限制在该路径内；所有持久化状态都位于 `{workspace}/.agent/sessions/{sessionId}/` 下。

**技术栈（Tech Stack）：** TypeScript（NodeNext ESM，`"type":"module"`）、npm workspaces、vitest（文件系统测试使用临时目录）、Electron（main + preload + renderer）、用于 OpenAI-compatible 流式输出的 Node `fetch`、用于 bash 的 `child_process`。

## 全局约束

- 语言：仅使用 TypeScript；NodeNext 模块解析；各 package 使用 `"type":"module"`。
- 布局：代码位于 `/workspace/long-task-desktop-agent/` 下，workspaces 为 `packages/core` 和 `packages/app`。
- 一个 session ↔ 一个 `workspacePath`（创建时设定；第一阶段不支持在 session 中途重新绑定）。
- 工具的 cwd / 文件根目录 = session 的 `workspacePath`；阻止路径逃逸到 workspace 之外。
- 存储根目录：`{workspace}/.agent/sessions/{sessionId}/`，包含 `meta.json`、`messages.jsonl`、`trace.jsonl`。
- ReAct：每个用户 turn 最多 **50** 步工具循环；达到上限时停止，并给出明确的"继续/换个说法"提示。
- Bash 默认超时 **60s**（可配置）；截断 stdout/stderr；失败以工具结果的形式返回。
- 中断：保留已流式输出的 assistant 文本并标记为 `interrupted`；终止正在执行的 bash；不执行待处理的 tool_calls；将取消事件写入 trace。
- 上下文组装顺序（固定）：system → 工具描述 → 压缩后的历史 → 当前用户消息。
- turn 的定义：一次用户提交开启一个 turn；该 turn 的 assistant/tool 消息都归属于它，直到 `done` 或被中断。
- 压缩：当历史中的用户 turn 数 **> 10** 时，完整保留最早的 **3** 个 turn 和最近的 **10** 个 turn；中间的 turn 合并为一条摘要消息；如果最早 3 个与最近 10 个有重叠，则全部保留（不做摘要）。
- 同时对组装后的上下文强制执行可配置的字符预算（测试使用较小的限制）。
- API key 仅存放在本地配置中；绝不将明文 key 写入 messages 或 trace。
- 范围之外：记忆提取、自定义工具、网页搜索、右侧产物面板、subagents、多 session 并发长时运行、任意步骤回滚、非 OpenAI 的第二种协议。
- core 中采用 TDD：先写失败的测试 → 实现 → 通过 → 提交。App：仅做最小冒烟测试。

---

## 文件结构

项目根目录：`/workspace/long-task-desktop-agent/`

```
long-task-desktop-agent/
  package.json
  tsconfig.base.json
  .gitignore
  README.md
  packages/
    core/
      package.json
      tsconfig.json
      vitest.config.ts
      src/
        index.ts
        types.ts
        ids.ts
        pathSandbox.ts
        store/
          sessionStore.ts
          traceStore.ts
        tools/
          types.ts
          bash.ts
          readFile.ts
          search.ts
          host.ts
          dangerous.ts
        context/
          assemble.ts
          compress.ts
        provider/
          types.ts
          openaiCompatible.ts
        runtime/
          agentRuntime.ts
          errors.ts
        config/
          types.ts
          loadConfig.ts
      tests/
        types.smoke.test.ts
        pathSandbox.test.ts
        sessionStore.test.ts
        traceStore.test.ts
        tools.test.ts
        compress.test.ts
        assemble.test.ts
        agentRuntime.test.ts
        cancel.test.ts
        openaiCompatible.test.ts
        loadConfig.test.ts
        recovery.test.ts
    app/
      package.json
      tsconfig.json
      scripts/
        copy-static.mjs
        smoke-main.mjs
      electron/
        main.ts
        preload.ts
      src/
        renderer/
          index.html
          main.ts
          ui.ts
          styles.css
      README.md
```

---

### 任务 1：搭建 monorepo 脚手架和领域类型

**文件：**
- 新建：`/workspace/long-task-desktop-agent/package.json`
- 新建：`/workspace/long-task-desktop-agent/tsconfig.base.json`
- 新建：`/workspace/long-task-desktop-agent/.gitignore`
- 新建：`/workspace/long-task-desktop-agent/README.md`
- 新建：`/workspace/long-task-desktop-agent/packages/core/package.json`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tsconfig.json`
- 新建：`/workspace/long-task-desktop-agent/packages/core/vitest.config.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/types.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/ids.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/types.smoke.test.ts`

**接口：**
- 消费（Consumes）：（无 — 全新项目）
- 产出（Produces）：
  - `export type Role = "system" | "user" | "assistant" | "tool"`
  - `export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }`
  - `export interface Message { id: string; session_id: string; turn_id: string; role: Role; content: string; name?: string; tool_call_id?: string; tool_calls?: ToolCall[]; interrupted?: boolean; created_at: string }`
  - `export interface SessionMeta { session_id: string; workspace_path: string; created_at: string; updated_at: string; title?: string }`
  - `export type RuntimeEvent = { type: "text"; turn_id: string; delta: string } | { type: "tool_call"; turn_id: string; tool_call: ToolCall } | { type: "tool_result"; turn_id: string; tool_call_id: string; content: string; is_error: boolean } | { type: "error"; turn_id?: string; message: string; code: string } | { type: "done"; turn_id: string; reason: "completed" | "max_steps" | "cancelled" | "error" } | { type: "status"; turn_id: string; phase: "assembling" | "llm" | "tool" }`
  - `export interface TraceEvent { id: string; session_id: string; turn_id?: string; type: string; timestamp: string; message_id?: string; token_usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: string; detail?: Record<string, unknown> }`
  - `export interface AgentConfig { baseUrl: string; model: string; apiKey: string; bashTimeoutMs: number; maxSteps: number; contextCharLimit: number; maxToolOutputChars: number; maxReadChars: number; maxSearchResults: number }`
  - `export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "baseUrl" | "model" | "apiKey">`
  - `export function newId(prefix: string): string`
  - `export function nowIso(): string`

- [ ] **第 1 步：创建目录和清单文件**

```bash
mkdir -p /workspace/long-task-desktop-agent/packages/core/src \
  /workspace/long-task-desktop-agent/packages/core/tests
```

写入 `/workspace/long-task-desktop-agent/package.json`：

```json
{
  "name": "long-task-desktop-agent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm run test -w @agent/core",
    "build": "npm run build -w @agent/core && npm run build -w @agent/app",
    "start": "npm run start -w @agent/app"
  }
}
```

写入 `/workspace/long-task-desktop-agent/tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

写入 `/workspace/long-task-desktop-agent/.gitignore`：

```
node_modules/
dist/
*.log
.DS_Store
.env
*.tsbuildinfo
```

写入 `/workspace/long-task-desktop-agent/packages/core/package.json`：

```json
{
  "name": "@agent/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **第 2 步：编写失败的冒烟测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/types.smoke.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { newId, nowIso } from "../src/ids.js";
import type { Message, SessionMeta, RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";

describe("ids", () => {
  it("newId returns prefix_ plus unique suffix", () => {
    const a = newId("msg");
    const b = newId("msg");
    expect(a.startsWith("msg_")).toBe(true);
    expect(b.startsWith("msg_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("nowIso returns ISO-8601 string", () => {
    const s = nowIso();
    expect(new Date(s).toISOString()).toBe(s);
  });
});

describe("types compile shape", () => {
  it("Message and SessionMeta accept required fields", () => {
    const meta: SessionMeta = {
      session_id: "sess_1",
      workspace_path: "/tmp/ws",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const msg: Message = {
      id: "msg_1",
      session_id: meta.session_id,
      turn_id: "turn_1",
      role: "user",
      content: "hi",
      created_at: nowIso(),
    };
    const ev: RuntimeEvent = { type: "done", turn_id: "turn_1", reason: "completed" };
    const cfg: AgentConfig = {
      baseUrl: "https://api.example.com/v1",
      model: "gpt-test",
      apiKey: "sk-test",
      ...DEFAULT_AGENT_CONFIG,
    };
    expect(msg.role).toBe("user");
    expect(ev.type).toBe("done");
    expect(cfg.maxSteps).toBe(50);
  });
});
```

- [ ] **第 3 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm install && npm run test -w @agent/core`

预期：失败（无法解析 `../src/ids.js`）。

- [ ] **第 4 步：实现 ids 和 types**

写入 `/workspace/long-task-desktop-agent/packages/core/src/ids.ts`：

```ts
import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/types.ts`：

```ts
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  id: string;
  session_id: string;
  turn_id: string;
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  interrupted?: boolean;
  created_at: string;
}

export interface SessionMeta {
  session_id: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
  title?: string;
}

export type RuntimeEvent =
  | { type: "text"; turn_id: string; delta: string }
  | { type: "tool_call"; turn_id: string; tool_call: ToolCall }
  | {
      type: "tool_result";
      turn_id: string;
      tool_call_id: string;
      content: string;
      is_error: boolean;
    }
  | { type: "error"; turn_id?: string; message: string; code: string }
  | {
      type: "done";
      turn_id: string;
      reason: "completed" | "max_steps" | "cancelled" | "error";
    }
  | {
      type: "status";
      turn_id: string;
      phase: "assembling" | "llm" | "tool";
    };

export interface TraceEvent {
  id: string;
  session_id: string;
  turn_id?: string;
  type: string;
  timestamp: string;
  message_id?: string;
  token_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
  detail?: Record<string, unknown>;
}

export interface AgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  bashTimeoutMs: number;
  maxSteps: number;
  contextCharLimit: number;
  maxToolOutputChars: number;
  maxReadChars: number;
  maxSearchResults: number;
}

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "baseUrl" | "model" | "apiKey"> = {
  bashTimeoutMs: 60_000,
  maxSteps: 50,
  contextCharLimit: 100_000,
  maxToolOutputChars: 20_000,
  maxReadChars: 50_000,
  maxSearchResults: 50,
};
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/index.ts`：

```ts
export * from "./types.js";
export * from "./ids.js";
```

写入 `/workspace/long-task-desktop-agent/README.md`：

````md
# 长任务桌面 Agent（第一阶段）

单仓库：`@agent/core`（运行时库）+ `@agent/app`（Electron 外壳）。

```bash
cd /workspace/long-task-desktop-agent
npm install
npm test
npm start
```
````

- [ ] **第 5 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core`

预期：通过。

- [ ] **第 6 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git init
git add package.json tsconfig.base.json .gitignore README.md packages/core
git commit -m "chore: scaffold monorepo and core domain types"
```

---


### 任务 2：Session store（meta.json + messages.jsonl）

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/store/sessionStore.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/sessionStore.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：来自任务 1 的 `Message`、`SessionMeta`、`newId`、`nowIso`
- 产出（Produces）：
  - `export function sessionDir(workspacePath: string, sessionId: string): string`
  - `export class SessionStore { constructor(workspacePath: string); createSession(title?: string): Promise<SessionMeta>; listSessions(): Promise<SessionMeta[]>; getMeta(sessionId: string): Promise<SessionMeta>; appendMessage(msg: Message): Promise<void>; readMessages(sessionId: string): Promise<Message[]>; updateMeta(meta: SessionMeta): Promise<void> }`

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/sessionStore.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store/sessionStore.js";
import { newId, nowIso } from "../src/ids.js";
import type { Message } from "../src/types.js";

describe("SessionStore", () => {
  let workspace: string;
  let store: SessionStore;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    store = new SessionStore(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("createSession writes meta under .agent/sessions/{id}/meta.json", async () => {
    const meta = await store.createSession("demo");
    expect(meta.session_id).toMatch(/^sess_/);
    expect(meta.workspace_path).toBe(workspace);
    expect(meta.title).toBe("demo");
    const raw = await readFile(
      join(workspace, ".agent", "sessions", meta.session_id, "meta.json"),
      "utf8",
    );
    expect(JSON.parse(raw).session_id).toBe(meta.session_id);
  });

  it("appendMessage and readMessages round-trip jsonl", async () => {
    const meta = await store.createSession();
    const msg: Message = {
      id: newId("msg"),
      session_id: meta.session_id,
      turn_id: newId("turn"),
      role: "user",
      content: "hello",
      created_at: nowIso(),
    };
    await store.appendMessage(msg);
    const msgs = await store.readMessages(meta.session_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(msg);
  });

  it("listSessions returns created sessions", async () => {
    const a = await store.createSession("a");
    const b = await store.createSession("b");
    const list = await store.listSessions();
    const ids = list.map((m) => m.session_id).sort();
    expect(ids).toEqual([a.session_id, b.session_id].sort());
  });

  it("appendMessage throws when session missing", async () => {
    await expect(
      store.appendMessage({
        id: newId("msg"),
        session_id: "sess_missing",
        turn_id: newId("turn"),
        role: "user",
        content: "x",
        created_at: nowIso(),
      }),
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/sessionStore.test.ts`

预期：失败，提示找不到模块 `sessionStore`。

- [ ] **第 3 步：实现 SessionStore**

写入 `/workspace/long-task-desktop-agent/packages/core/src/store/sessionStore.ts`：

```ts
import { mkdir, readFile, writeFile, readdir, appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { Message, SessionMeta } from "../types.js";

export function sessionDir(workspacePath: string, sessionId: string): string {
  return join(workspacePath, ".agent", "sessions", sessionId);
}

export class SessionStore {
  constructor(private readonly workspacePath: string) {}

  private sessionsRoot(): string {
    return join(this.workspacePath, ".agent", "sessions");
  }

  async createSession(title?: string): Promise<SessionMeta> {
    const session_id = newId("sess");
    const dir = sessionDir(this.workspacePath, session_id);
    await mkdir(dir, { recursive: true });
    const now = nowIso();
    const meta: SessionMeta = {
      session_id,
      workspace_path: this.workspacePath,
      created_at: now,
      updated_at: now,
      title,
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeFile(join(dir, "messages.jsonl"), "", "utf8");
    await writeFile(join(dir, "trace.jsonl"), "", "utf8");
    return meta;
  }

  async getMeta(sessionId: string): Promise<SessionMeta> {
    const path = join(sessionDir(this.workspacePath, sessionId), "meta.json");
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  async updateMeta(meta: SessionMeta): Promise<void> {
    meta.updated_at = nowIso();
    const path = join(sessionDir(this.workspacePath, meta.session_id), "meta.json");
    await writeFile(path, JSON.stringify(meta, null, 2), "utf8");
  }

  async listSessions(): Promise<SessionMeta[]> {
    const root = this.sessionsRoot();
    try {
      await access(root);
    } catch {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        metas.push(await this.getMeta(e.name));
      } catch {
        // 跳过损坏的 session 目录
      }
    }
    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async appendMessage(msg: Message): Promise<void> {
    await this.getMeta(msg.session_id);
    const path = join(sessionDir(this.workspacePath, msg.session_id), "messages.jsonl");
    await appendFile(path, JSON.stringify(msg) + "\n", "utf8");
    const meta = await this.getMeta(msg.session_id);
    await this.updateMeta(meta);
  }

  async readMessages(sessionId: string): Promise<Message[]> {
    await this.getMeta(sessionId);
    const path = join(sessionDir(this.workspacePath, sessionId), "messages.jsonl");
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Message);
  }
}
```

更新 `/workspace/long-task-desktop-agent/packages/core/src/index.ts`：

```ts
export * from "./types.js";
export * from "./ids.js";
export * from "./store/sessionStore.js";
```

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/sessionStore.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/store/sessionStore.ts packages/core/tests/sessionStore.test.ts packages/core/src/index.ts
git commit -m "feat(core): session store with meta.json and messages.jsonl"
```

---

### 任务 3：Trace store

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/store/traceStore.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/traceStore.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：`sessionDir`、`TraceEvent`、`newId`、`nowIso`
- 产出（Produces）：
  - `export class TraceStore { constructor(workspacePath: string); append(event: Omit<TraceEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }): Promise<TraceEvent>; read(sessionId: string): Promise<TraceEvent[]> }`

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/traceStore.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store/sessionStore.js";
import { TraceStore } from "../src/store/traceStore.js";

describe("TraceStore", () => {
  let workspace: string;
  let sessions: SessionStore;
  let traces: TraceStore;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    sessions = new SessionStore(workspace);
    traces = new TraceStore(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("appends trace events linked by session_id and turn_id", async () => {
    const meta = await sessions.createSession();
    const turn_id = "turn_abc";
    const ev = await traces.append({
      session_id: meta.session_id,
      turn_id,
      type: "llm_request",
      token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(ev.id.startsWith("trace_")).toBe(true);
    expect(ev.timestamp).toBeTruthy();
    const all = await traces.read(meta.session_id);
    expect(all).toHaveLength(1);
    expect(all[0].turn_id).toBe(turn_id);
    expect(all[0].token_usage?.total_tokens).toBe(15);
  });

  it("records cancel events", async () => {
    const meta = await sessions.createSession();
    await traces.append({
      session_id: meta.session_id,
      turn_id: "turn_1",
      type: "cancel",
      detail: { reason: "user" },
    });
    const all = await traces.read(meta.session_id);
    expect(all[0].type).toBe("cancel");
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/traceStore.test.ts`

预期：失败（找不到模块）。

- [ ] **第 3 步：实现 TraceStore**

写入 `/workspace/long-task-desktop-agent/packages/core/src/store/traceStore.ts`：

```ts
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, nowIso } from "../ids.js";
import type { TraceEvent } from "../types.js";
import { sessionDir } from "./sessionStore.js";

export class TraceStore {
  constructor(private readonly workspacePath: string) {}

  async append(
    event: Omit<TraceEvent, "id" | "timestamp"> & {
      id?: string;
      timestamp?: string;
    },
  ): Promise<TraceEvent> {
    const full: TraceEvent = {
      ...event,
      id: event.id ?? newId("trace"),
      timestamp: event.timestamp ?? nowIso(),
    };
    const path = join(sessionDir(this.workspacePath, full.session_id), "trace.jsonl");
    await appendFile(path, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async read(sessionId: string): Promise<TraceEvent[]> {
    const path = join(sessionDir(this.workspacePath, sessionId), "trace.jsonl");
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEvent);
  }
}
```

追加到 `index.ts`：`export * from "./store/traceStore.js";`

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/traceStore.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/store/traceStore.ts packages/core/tests/traceStore.test.ts packages/core/src/index.ts
git commit -m "feat(core): trace.jsonl writer with session/turn linkage"
```

---

### 任务 4：路径沙箱辅助函数

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/pathSandbox.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/pathSandbox.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：Node `path`
- 产出（Produces）：
  - `export function resolveWithinWorkspace(workspacePath: string, relativeOrAbsolute: string): string`
  - `export function isPathInside(workspacePath: string, candidate: string): boolean`

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/pathSandbox.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveWithinWorkspace, isPathInside } from "../src/pathSandbox.js";
import { join } from "node:path";

describe("pathSandbox", () => {
  const ws = "/tmp/my-workspace";

  it("resolves relative paths inside workspace", () => {
    expect(resolveWithinWorkspace(ws, "src/a.ts")).toBe(join(ws, "src/a.ts"));
  });

  it("allows absolute paths that stay inside workspace", () => {
    expect(resolveWithinWorkspace(ws, join(ws, "readme.md"))).toBe(join(ws, "readme.md"));
  });

  it("rejects parent-directory escape", () => {
    expect(() => resolveWithinWorkspace(ws, "../outside.txt")).toThrow(/outside/i);
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => resolveWithinWorkspace(ws, "/etc/passwd")).toThrow(/outside/i);
  });

  it("isPathInside is false for sibling prefix paths", () => {
    expect(isPathInside(ws, "/tmp/my-workspace-evil/x")).toBe(false);
    expect(isPathInside(ws, join(ws, "ok"))).toBe(true);
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/pathSandbox.test.ts`

预期：失败。

- [ ] **第 3 步：实现 pathSandbox**

写入 `/workspace/long-task-desktop-agent/packages/core/src/pathSandbox.ts`：

```ts
import { isAbsolute, normalize, resolve, sep } from "node:path";

export function isPathInside(workspacePath: string, candidate: string): boolean {
  const root = resolve(workspacePath) + sep;
  const target = resolve(candidate);
  if (target === resolve(workspacePath)) return true;
  return target.startsWith(root);
}

export function resolveWithinWorkspace(
  workspacePath: string,
  relativeOrAbsolute: string,
): string {
  const root = resolve(workspacePath);
  const candidate = isAbsolute(relativeOrAbsolute)
    ? resolve(relativeOrAbsolute)
    : resolve(root, normalize(relativeOrAbsolute));
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path is outside workspace: ${relativeOrAbsolute}`);
  }
  return candidate;
}
```

追加到 `index.ts`：`export * from "./pathSandbox.js";`

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/pathSandbox.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/pathSandbox.ts packages/core/tests/pathSandbox.test.ts packages/core/src/index.ts
git commit -m "feat(core): path sandbox resolveWithinWorkspace"
```

---


### 任务 5：内置工具（bash、Read、关键词搜索）+ ToolHost

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/types.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/dangerous.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/bash.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/readFile.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/search.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/tools/host.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/tools.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：`resolveWithinWorkspace`、`AgentConfig` 中的超时/大小字段
- 产出（Produces）：
  - `export interface ToolResult { content: string; is_error: boolean }`
  - `export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }`
  - `export interface ToolContext { workspacePath: string; signal?: AbortSignal; bashTimeoutMs: number; maxToolOutputChars: number; maxReadChars: number; maxSearchResults: number }`
  - `export interface Tool { definition: ToolDefinition; execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> }`
  - `export class ToolHost { constructor(tools?: Tool[]); listDefinitions(): ToolDefinition[]; execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> }`
  - `export function createBuiltinTools(): Tool[]`
  - `export function isDangerousBash(command: string): boolean`
  - `export function truncateOutput(text: string, maxChars: number): string`

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/tools.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBuiltinTools,
  ToolHost,
  isDangerousBash,
  truncateOutput,
} from "../src/tools/host.js";
import type { ToolContext } from "../src/tools/types.js";

describe("tools", () => {
  let workspace: string;
  let ctx: ToolContext;
  let host: ToolHost;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
    await writeFile(join(workspace, "hello.txt"), "hello world\nline2\n", "utf8");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "a.ts"), " const foo = 1;\n", "utf8");
    ctx = {
      workspacePath: workspace,
      bashTimeoutMs: 5_000,
      maxToolOutputChars: 100,
      maxReadChars: 50,
      maxSearchResults: 10,
    };
    host = new ToolHost(createBuiltinTools());
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists three builtin tool definitions", () => {
    const names = host.listDefinitions().map((d) => d.name).sort();
    expect(names).toEqual(["bash", "keyword_search", "read_file"]);
  });

  it("read_file returns content and truncates", async () => {
    const r = await host.execute(
      "read_file",
      JSON.stringify({ path: "hello.txt" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    expect(r.content.includes("truncated") || r.content.length <= 50).toBe(true);
  });

  it("read_file rejects path outside workspace", async () => {
    const r = await host.execute(
      "read_file",
      JSON.stringify({ path: "../outside.txt" }),
      ctx,
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/outside/i);
  });

  it("bash runs in workspace cwd", async () => {
    const r = await host.execute("bash", JSON.stringify({ command: "pwd" }), ctx);
    expect(r.is_error).toBe(false);
    expect(r.content.trim()).toContain(workspace);
  });

  it("bash timeout returns error tool result", async () => {
    const r = await host.execute(
      "bash",
      JSON.stringify({ command: "sleep 5" }),
      { ...ctx, bashTimeoutMs: 200 },
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/timeout/i);
  });

  it("bash rejects destructive root delete patterns", async () => {
    const blocked = ["rm", "-rf", "/"].join(" ");
    expect(isDangerousBash(blocked)).toBe(true);
    const r = await host.execute("bash", JSON.stringify({ command: blocked }), ctx);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/blocked|dangerous/i);
  });

  it("keyword_search finds matches with limits", async () => {
    const r = await host.execute(
      "keyword_search",
      JSON.stringify({ query: "foo" }),
      ctx,
    );
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/a\.ts/);
  });

  it("unknown tool returns error result not throw", async () => {
    const r = await host.execute("nope", "{}", ctx);
    expect(r.is_error).toBe(true);
  });

  it("truncateOutput caps length", () => {
    expect(truncateOutput("abcdefghij", 5)).toContain("truncated");
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/tools.test.ts`

预期：失败。

- [ ] **第 3 步：实现工具**

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/types.ts`：

```ts
export interface ToolResult {
  content: string;
  is_error: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  workspacePath: string;
  signal?: AbortSignal;
  bashTimeoutMs: number;
  maxToolOutputChars: number;
  maxReadChars: number;
  maxSearchResults: number;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/dangerous.ts`：

```ts
const PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/\b/,
  /\brm\s+-rf\s+\/\s*$/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
];

export function isDangerousBash(command: string): boolean {
  return PATTERNS.some((p) => p.test(command.trim()));
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/bash.ts`：

```ts
import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isDangerousBash } from "./dangerous.js";

export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description: "Run a shell command in the workspace directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command) return { content: "Missing command", is_error: true };
    if (isDangerousBash(command)) {
      return { content: "Blocked dangerous command", is_error: true };
    }
    return runBash(command, ctx);
  },
};

function runBash(command: string, ctx: ToolContext): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.workspacePath,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        content: truncateOutput(result.content, ctx.maxToolOutputChars),
        is_error: result.is_error,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        content: `Command timeout after ${ctx.bashTimeoutMs}ms`,
        is_error: true,
      });
    }, ctx.bashTimeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ content: "Command cancelled", is_error: true });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      finish({ content: String(err), is_error: true });
    });
    child.on("close", (code) => {
      const content = [stdout, stderr].filter(Boolean).join("\n");
      finish({
        content: content || `(exit ${code ?? "?"})`,
        is_error: code !== 0,
      });
    });
  });
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/readFile.ts`：

```ts
import { readFile } from "node:fs/promises";
import { resolveWithinWorkspace } from "../pathSandbox.js";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace or absolute inside it",
        },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const abs = resolveWithinWorkspace(ctx.workspacePath, String(args.path ?? ""));
      const raw = await readFile(abs, "utf8");
      return { content: truncateOutput(raw, ctx.maxReadChars), is_error: false };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/search.ts`：

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { truncateOutput } from "./bash.js";

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".agent") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, files);
    else files.push(p);
  }
}

export const searchTool: Tool = {
  definition: {
    name: "keyword_search",
    description: "Search workspace text files for a keyword; returns matching lines.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (!query) return { content: "Missing query", is_error: true };
    try {
      const files: string[] = [];
      await walk(ctx.workspacePath, files);
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= ctx.maxSearchResults) break;
        const st = await stat(file);
        if (st.size > 1_000_000) continue;
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            hits.push(`${relative(ctx.workspacePath, file)}:${i + 1}:${lines[i]}`);
            if (hits.length >= ctx.maxSearchResults) break;
          }
        }
      }
      const content = hits.length ? hits.join("\n") : "No matches";
      return {
        content: truncateOutput(content, ctx.maxToolOutputChars),
        is_error: false,
      };
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  },
};
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/tools/host.ts`：

```ts
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { bashTool, truncateOutput } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { searchTool } from "./search.js";
import { isDangerousBash } from "./dangerous.js";

export { truncateOutput, isDangerousBash };
export type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export function createBuiltinTools(): Tool[] {
  return [bashTool, readFileTool, searchTool];
}

export class ToolHost {
  private readonly byName: Map<string, Tool>;

  constructor(tools: Tool[] = createBuiltinTools()) {
    this.byName = new Map(tools.map((t) => [t.definition.name, t]));
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.byName.values()].map((t) => t.definition);
  }

  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, is_error: true };
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch (err) {
      return { content: `Invalid JSON arguments: ${String(err)}`, is_error: true };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return { content: String(err), is_error: true };
    }
  }
}
```

追加到 `index.ts`：`export * from "./tools/host.js";`

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/tools.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/tools packages/core/tests/tools.test.ts packages/core/src/index.ts
git commit -m "feat(core): bash, read_file, keyword_search tools and ToolHost"
```

---


### 任务 6：上下文组装 + 压缩

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/context/compress.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/context/assemble.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/compress.test.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/assemble.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：`Message`、`ToolDefinition`
- 产出（Produces）：
  - `export function groupTurns(messages: Message[]): Message[][]`
  - `export function countUserTurns(messages: Message[]): number`
  - `export function compressMessages(messages: Message[], opts?: { contextCharLimit?: number }): Message[]`
  - `export interface AssembledMessage { role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: ToolCall[] }`
  - `export interface AssembledContext { messages: AssembledMessage[] }`
  - `export function assembleContext(opts: { systemPrompt: string; toolDefinitions: ToolDefinition[]; history: Message[]; currentUser: Message; contextCharLimit: number }): AssembledContext`

压缩算法（精确）：
1. 按 `turn_id` 对消息分组，保持首次出现的顺序。
2. 令 `userTurnIndexes` = 包含 `role === "user"` 消息的分组的下标。
3. 如果 `userTurnIndexes.length <= 10`，保留所有分组。
4. 否则 `keep = set(first 3 of userTurnIndexes ∪ last 10 of userTurnIndexes)`。如果每个用户 turn 的下标都在 `keep` 中（重叠情形），则原样保留所有分组（不做摘要）。
5. 否则，将每一段连续的未保留分组替换为一条摘要 `Message`（`role: "user"`，content 以 `[summary of omitted turns]` 开头）。
6. 如果设置了 `contextCharLimit` 且内容总字符数超出该限制，则先缩减摘要内容，再截断最旧的剩余消息内容，直到不超过限制。

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/compress.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { compressMessages, countUserTurns } from "../src/context/compress.js";
import type { Message } from "../src/types.js";

function msg(turn: string, role: Message["role"], content: string, id = `${turn}_${role}`): Message {
  return {
    id,
    session_id: "sess",
    turn_id: turn,
    role,
    content,
    created_at: "2026-10-29T00:00:00.000Z",
  };
}

function makeTurns(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg(`turn_${i}`, "user", `u${i}`));
    out.push(msg(`turn_${i}`, "assistant", `a${i}`, `turn_${i}_assistant`));
  }
  return out;
}

describe("compressMessages", () => {
  it("countUserTurns counts distinct turns with user messages", () => {
    expect(countUserTurns(makeTurns(3))).toBe(3);
  });

  it("does not compress when user turns <= 10", () => {
    expect(compressMessages(makeTurns(10))).toHaveLength(20);
  });

  it("keeps first 3 and last 10 turns when user turns > 10", () => {
    const out = compressMessages(makeTurns(15));
    expect(out.some((m) => m.content.startsWith("[summary"))).toBe(true);
    const userContents = out
      .filter((m) => m.role === "user" && !m.content.startsWith("[summary"))
      .map((m) => m.content);
    expect(userContents).toContain("u1");
    expect(userContents).toContain("u3");
    expect(userContents).toContain("u6");
    expect(userContents).toContain("u15");
    expect(userContents).not.toContain("u4");
    expect(userContents).not.toContain("u5");
  });

  it("when first3 and last10 overlap, keeps all without summary", () => {
    const out = compressMessages(makeTurns(12));
    expect(out.some((m) => m.content.startsWith("[summary"))).toBe(false);
    expect(out).toHaveLength(24);
  });

  it("applies character limit", () => {
    const input = makeTurns(15).map((m) => ({ ...m, content: m.content + "x".repeat(200) }));
    const out = compressMessages(input, { contextCharLimit: 2500 });
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(2500);
  });
});
```

写入 `/workspace/long-task-desktop-agent/packages/core/tests/assemble.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { assembleContext } from "../src/context/assemble.js";
import type { Message } from "../src/types.js";
import type { ToolDefinition } from "../src/tools/types.js";

const tools: ToolDefinition[] = [
  { name: "bash", description: "run", parameters: { type: "object", properties: {} } },
];

describe("assembleContext", () => {
  it("orders system (with tools), history, current user", () => {
    const history: Message[] = [
      {
        id: "1",
        session_id: "s",
        turn_id: "t0",
        role: "user",
        content: "old",
        created_at: "2026-10-29T00:00:00.000Z",
      },
      {
        id: "2",
        session_id: "s",
        turn_id: "t0",
        role: "assistant",
        content: "reply",
        created_at: "2026-10-29T00:00:01.000Z",
      },
    ];
    const current: Message = {
      id: "3",
      session_id: "s",
      turn_id: "t1",
      role: "user",
      content: "now",
      created_at: "2026-10-29T00:00:02.000Z",
    };
    const assembled = assembleContext({
      systemPrompt: "You are a coding agent.",
      toolDefinitions: tools,
      history,
      currentUser: current,
      contextCharLimit: 100_000,
    });
    expect(assembled.messages[0].role).toBe("system");
    expect(assembled.messages[0].content).toContain("You are a coding agent.");
    expect(assembled.messages[0].content).toContain("bash");
    expect(assembled.messages.at(-1)?.content).toBe("now");
    expect(assembled.messages.some((m) => m.content === "old")).toBe(true);
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/compress.test.ts tests/assemble.test.ts`

预期：失败。

- [ ] **第 3 步：实现 compress 和 assemble**

写入 `/workspace/long-task-desktop-agent/packages/core/src/context/compress.ts`：

```ts
import { newId, nowIso } from "../ids.js";
import type { Message } from "../types.js";

export function groupTurns(messages: Message[]): Message[][] {
  const order: string[] = [];
  const map = new Map<string, Message[]>();
  for (const m of messages) {
    if (!map.has(m.turn_id)) {
      map.set(m.turn_id, []);
      order.push(m.turn_id);
    }
    map.get(m.turn_id)!.push(m);
  }
  return order.map((id) => map.get(id)!);
}

export function countUserTurns(messages: Message[]): number {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "user") ids.add(m.turn_id);
  }
  return ids.size;
}

function makeSummary(sessionId: string, parts: string[]): Message {
  return {
    id: newId("msg"),
    session_id: sessionId,
    turn_id: newId("turn"),
    role: "user",
    content: `[summary of omitted turns]\n${parts.join("\n")}`.slice(0, 4000),
    created_at: nowIso(),
  };
}

function enforceCharLimit(messages: Message[], limit: number): Message[] {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= limit) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (const preferSummary of [true, false]) {
    for (const m of out) {
      if (total <= limit) break;
      const isSummary = m.content.startsWith("[summary");
      if (preferSummary && !isSummary) continue;
      if (!preferSummary && isSummary) continue;
      if (m.content.length <= 32) continue;
      const overflow = total - limit;
      const newLen = Math.max(32, m.content.length - overflow);
      total -= m.content.length - newLen;
      m.content = m.content.slice(0, newLen) + "…";
    }
  }
  return out;
}

export function compressMessages(
  messages: Message[],
  opts: { contextCharLimit?: number } = {},
): Message[] {
  const turns = groupTurns(messages);
  const userTurnIndexes = turns
    .map((t, i) => (t.some((m) => m.role === "user") ? i : -1))
    .filter((i) => i >= 0);

  let flat: Message[];

  if (userTurnIndexes.length <= 10) {
    flat = messages.slice();
  } else {
    const keep = new Set<number>([
      ...userTurnIndexes.slice(0, 3),
      ...userTurnIndexes.slice(-10),
    ]);
    const middle = userTurnIndexes.filter((i) => !keep.has(i));
    if (middle.length === 0) {
      flat = messages.slice();
    } else {
      const sessionId = messages[0]?.session_id ?? "sess";
      const minMid = Math.min(...middle);
      const maxMid = Math.max(...middle);
      const result: Message[] = [];
      let bucket: string[] = [];
      const flush = () => {
        if (bucket.length) {
          result.push(makeSummary(sessionId, bucket));
          bucket = [];
        }
      };
      for (let i = 0; i < turns.length; i++) {
        if (i >= minMid && i <= maxMid && !keep.has(i)) {
          for (const m of turns[i]) {
            bucket.push(`${m.role}: ${m.content.slice(0, 200)}`);
          }
        } else {
          flush();
          result.push(...turns[i]);
        }
      }
      flush();
      flat = result;
    }
  }

  if (opts.contextCharLimit != null) {
    flat = enforceCharLimit(flat, opts.contextCharLimit);
  }
  return flat;
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/context/assemble.ts`：

```ts
import type { Message, ToolCall } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import { compressMessages } from "./compress.js";

export interface AssembledMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface AssembledContext {
  messages: AssembledMessage[];
}

export function assembleContext(opts: {
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  history: Message[];
  currentUser: Message;
  contextCharLimit: number;
}): AssembledContext {
  const toolsBlock = opts.toolDefinitions
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`,
    )
    .join("\n");
  const systemContent = `${opts.systemPrompt}\n\n# Tools\n${toolsBlock}`;
  const budget = Math.max(
    1000,
    opts.contextCharLimit - systemContent.length - opts.currentUser.content.length - 100,
  );
  const compressed = compressMessages(opts.history, { contextCharLimit: budget });
  const messages: AssembledMessage[] = [
    { role: "system", content: systemContent },
    ...compressed.map(toAssembled),
    toAssembled(opts.currentUser),
  ];
  return { messages };
}

function toAssembled(m: Message): AssembledMessage {
  return {
    role: m.role,
    content: m.content,
    name: m.name,
    tool_call_id: m.tool_call_id,
    tool_calls: m.tool_calls,
  };
}
```

将导出追加到 `index.ts`。

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/compress.test.ts tests/assemble.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/context packages/core/tests/compress.test.ts packages/core/tests/assemble.test.ts packages/core/src/index.ts
git commit -m "feat(core): context assemble order and turn/char compression"
```

---


### 任务 7：LlmProvider 接口 + AgentRuntime ReAct 循环（最大步数）

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/provider/types.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/runtime/errors.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/runtime/agentRuntime.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/agentRuntime.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：`SessionStore`、`TraceStore`、`ToolHost`、`assembleContext`、`AgentConfig`、`RuntimeEvent`、`Message`、`ToolCall`
- 产出（Produces）：
  - `export interface LlmStreamChunk { type: "text" | "tool_call_delta" | "usage" | "error"; text?: string; tool_call?: ToolCall; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: string }`
  - `export interface LlmChatRequest { messages: AssembledMessage[]; tools: ToolDefinition[]; model: string; signal?: AbortSignal }`
  - `export interface LlmProvider { chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> }`
  - `export type EventListener = (event: RuntimeEvent) => void`
  - `export class AgentRuntime { constructor(opts: { workspacePath: string; config: AgentConfig; provider: LlmProvider; systemPrompt?: string; store?: SessionStore; traces?: TraceStore; tools?: ToolHost }); createSession(title?: string): Promise<SessionMeta>; listSessions(): Promise<SessionMeta[]>; loadMessages(sessionId: string): Promise<Message[]>; submit(sessionId: string, text: string): Promise<void>; cancel(): void; onEvent(listener: EventListener): () => void }`

循环规则：
- 每次 `submit` 开启一个 `turn_id`，追加用户消息，然后循环：组装 → LLM 流式输出 → 持久化 assistant → 如果存在 tool_calls 且 `steps >= maxSteps`，则发出提示并以 `done/max_steps` 结束，不执行工具；否则执行工具，`steps += 1`，继续；如果没有 tool_calls → `done/completed`。
- 循环内组装：`history = allMessages.slice(0, -1)`，`currentUser = allMessages.at(-1)`。

- [ ] **第 1 步：编写失败的 AgentRuntime 测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/agentRuntime.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk, LlmChatRequest } from "../src/provider/types.js";
import type { RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    baseUrl: "http://localhost",
    model: "test",
    apiKey: "sk-test",
    ...DEFAULT_AGENT_CONFIG,
    ...over,
  };
}

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
  yield { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

async function* oneTool(step: number): AsyncIterable<LlmStreamChunk> {
  yield {
    type: "tool_call_delta",
    tool_call: {
      id: `call_${step}`,
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
    },
  };
}

describe("AgentRuntime", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("submit streams text, persists messages, emits done", async () => {
    const provider: LlmProvider = { chatStream: () => textOnly("hello") };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession("t");
    await rt.submit(meta.session_id, "hi");
    expect(events.some((e) => e.type === "text" && e.delta === "hello")).toBe(true);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "hello")).toBe(true);
  });

  it("stops at maxSteps and emits done reason max_steps", async () => {
    const provider: LlmProvider = {
      chatStream(_req: LlmChatRequest) {
        return oneTool(Date.now());
      },
    };
    const rt = new AgentRuntime({
      workspacePath: workspace,
      config: config({ maxSteps: 3 }),
      provider,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "loop");
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done", reason: "max_steps" });
    const notice = events
      .filter((e) => e.type === "text")
      .map((e) => (e.type === "text" ? e.delta : ""))
      .join("");
    expect(notice).toMatch(/max tool steps \(3\)/i);
  });

  it("tool results are persisted and fed back", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      chatStream(req) {
        calls += 1;
        if (calls === 1) return oneTool(1);
        return textOnly(`tools:${req.messages.filter((m) => m.role === "tool").length}`);
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: config(), provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    await rt.submit(meta.session_id, "run");
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "done" && e.reason === "completed")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/agentRuntime.test.ts`

预期：失败。

- [ ] **第 3 步：实现 provider 类型和 AgentRuntime**

写入 `/workspace/long-task-desktop-agent/packages/core/src/provider/types.ts`：

```ts
import type { ToolCall } from "../types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AssembledMessage } from "../context/assemble.js";

export interface LlmStreamChunk {
  type: "text" | "tool_call_delta" | "usage" | "error";
  text?: string;
  tool_call?: ToolCall;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
}

export interface LlmChatRequest {
  messages: AssembledMessage[];
  tools: ToolDefinition[];
  model: string;
  signal?: AbortSignal;
}

export interface LlmProvider {
  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/runtime/errors.ts`：

```ts
export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/runtime/agentRuntime.ts`：

```ts
import { newId, nowIso } from "../ids.js";
import type {
  AgentConfig,
  Message,
  RuntimeEvent,
  SessionMeta,
  ToolCall,
} from "../types.js";
import { SessionStore } from "../store/sessionStore.js";
import { TraceStore } from "../store/traceStore.js";
import { ToolHost } from "../tools/host.js";
import { assembleContext } from "../context/assemble.js";
import type { LlmProvider } from "../provider/types.js";
import { AgentError } from "./errors.js";

export type EventListener = (event: RuntimeEvent) => void;

const DEFAULT_SYSTEM = `You are a coding agent working inside a local repository workspace.
Use tools when needed. Prefer concise, correct changes.`;

export class AgentRuntime {
  private readonly store: SessionStore;
  private readonly traces: TraceStore;
  private readonly tools: ToolHost;
  private readonly provider: LlmProvider;
  private readonly config: AgentConfig;
  private readonly systemPrompt: string;
  private readonly workspacePath: string;
  private listeners = new Set<EventListener>();
  private abort: AbortController | null = null;
  private running = false;

  constructor(opts: {
    workspacePath: string;
    config: AgentConfig;
    provider: LlmProvider;
    systemPrompt?: string;
    store?: SessionStore;
    traces?: TraceStore;
    tools?: ToolHost;
  }) {
    this.workspacePath = opts.workspacePath;
    this.config = opts.config;
    this.provider = opts.provider;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.store = opts.store ?? new SessionStore(opts.workspacePath);
    this.traces = opts.traces ?? new TraceStore(opts.workspacePath);
    this.tools = opts.tools ?? new ToolHost();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const l of this.listeners) l(event);
  }

  createSession(title?: string): Promise<SessionMeta> {
    return this.store.createSession(title);
  }

  listSessions(): Promise<SessionMeta[]> {
    return this.store.listSessions();
  }

  loadMessages(sessionId: string): Promise<Message[]> {
    return this.store.readMessages(sessionId);
  }

  cancel(): void {
    this.abort?.abort();
  }

  async submit(sessionId: string, text: string): Promise<void> {
    if (this.running) throw new AgentError("A turn is already running", "busy");
    this.running = true;
    this.abort = new AbortController();
    const turn_id = newId("turn");
    try {
      await this.traces.append({ session_id: sessionId, turn_id, type: "turn_start" });
      const userMsg: Message = {
        id: newId("msg"),
        session_id: sessionId,
        turn_id,
        role: "user",
        content: text,
        created_at: nowIso(),
      };
      try {
        await this.store.appendMessage(userMsg);
      } catch (err) {
        this.emit({
          type: "error",
          turn_id,
          message: String(err),
          code: "storage_write_failed",
        });
        this.emit({ type: "done", turn_id, reason: "error" });
        return;
      }

      let steps = 0;

      while (true) {
        if (this.abort.signal.aborted) {
          await this.handleCancel(sessionId, turn_id, "");
          return;
        }

        this.emit({ type: "status", turn_id, phase: "assembling" });
        const loopHistory = await this.store.readMessages(sessionId);
        const ctx = assembleContext({
          systemPrompt: this.systemPrompt,
          toolDefinitions: this.tools.listDefinitions(),
          history: loopHistory.slice(0, -1),
          currentUser: loopHistory[loopHistory.length - 1]!,
          contextCharLimit: this.config.contextCharLimit,
        });

        this.emit({ type: "status", turn_id, phase: "llm" });
        await this.traces.append({ session_id: sessionId, turn_id, type: "llm_request" });

        let assistantText = "";
        const toolCalls: ToolCall[] = [];
        let usage:
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        let llmError: string | undefined;

        try {
          for await (const chunk of this.provider.chatStream({
            messages: ctx.messages,
            tools: this.tools.listDefinitions(),
            model: this.config.model,
            signal: this.abort.signal,
          })) {
            if (this.abort.signal.aborted) break;
            if (chunk.type === "text" && chunk.text) {
              assistantText += chunk.text;
              this.emit({ type: "text", turn_id, delta: chunk.text });
            } else if (chunk.type === "tool_call_delta" && chunk.tool_call) {
              toolCalls.push(chunk.tool_call);
              this.emit({ type: "tool_call", turn_id, tool_call: chunk.tool_call });
            } else if (chunk.type === "usage") {
              usage = chunk.usage;
            } else if (chunk.type === "error") {
              llmError = chunk.error ?? "llm error";
            }
          }
        } catch (err) {
          if (!this.abort.signal.aborted) llmError = String(err);
        }

        if (this.abort.signal.aborted) {
          await this.handleCancel(sessionId, turn_id, assistantText);
          return;
        }

        if (llmError) {
          await this.traces.append({
            session_id: sessionId,
            turn_id,
            type: "llm_error",
            error: llmError,
            token_usage: usage,
          });
          this.emit({ type: "error", turn_id, message: llmError, code: "llm_error" });
          this.emit({ type: "done", turn_id, reason: "error" });
          return;
        }

        const assistantMsg: Message = {
          id: newId("msg"),
          session_id: sessionId,
          turn_id,
          role: "assistant",
          content: assistantText,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          created_at: nowIso(),
        };
        try {
          await this.store.appendMessage(assistantMsg);
        } catch (err) {
          this.emit({
            type: "error",
            turn_id,
            message: String(err),
            code: "storage_write_failed",
          });
          this.emit({ type: "done", turn_id, reason: "error" });
          return;
        }
        await this.traces.append({
          session_id: sessionId,
          turn_id,
          type: "llm_response",
          message_id: assistantMsg.id,
          token_usage: usage,
        });

        if (toolCalls.length === 0) {
          this.emit({ type: "done", turn_id, reason: "completed" });
          return;
        }

        if (steps >= this.config.maxSteps) {
          const notice = `Reached max tool steps (${this.config.maxSteps}). Stopped. Continue or change your instruction.`;
          this.emit({ type: "text", turn_id, delta: notice });
          await this.store.appendMessage({
            id: newId("msg"),
            session_id: sessionId,
            turn_id,
            role: "assistant",
            content: notice,
            created_at: nowIso(),
          });
          await this.traces.append({
            session_id: sessionId,
            turn_id,
            type: "max_steps",
            detail: { maxSteps: this.config.maxSteps },
          });
          this.emit({ type: "done", turn_id, reason: "max_steps" });
          return;
        }

        steps += 1;
        for (const tc of toolCalls) {
          if (this.abort.signal.aborted) {
            await this.traces.append({
              session_id: sessionId,
              turn_id,
              type: "cancel",
              detail: { reason: "user", pending_tool_call: tc.id },
            });
            this.emit({ type: "done", turn_id, reason: "cancelled" });
            return;
          }
          this.emit({ type: "status", turn_id, phase: "tool" });
          const result = await this.tools.execute(tc.function.name, tc.function.arguments, {
            workspacePath: this.workspacePath,
            signal: this.abort.signal,
            bashTimeoutMs: this.config.bashTimeoutMs,
            maxToolOutputChars: this.config.maxToolOutputChars,
            maxReadChars: this.config.maxReadChars,
            maxSearchResults: this.config.maxSearchResults,
          });
          const toolMsg: Message = {
            id: newId("msg"),
            session_id: sessionId,
            turn_id,
            role: "tool",
            name: tc.function.name,
            tool_call_id: tc.id,
            content: result.content,
            created_at: nowIso(),
          };
          await this.store.appendMessage(toolMsg);
          await this.traces.append({
            session_id: sessionId,
            turn_id,
            type: "tool_result",
            message_id: toolMsg.id,
            detail: { tool: tc.function.name, is_error: result.is_error },
          });
          this.emit({
            type: "tool_result",
            turn_id,
            tool_call_id: tc.id,
            content: result.content,
            is_error: result.is_error,
          });
        }
      }
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  private async handleCancel(
    sessionId: string,
    turn_id: string,
    assistantText: string,
  ): Promise<void> {
    if (assistantText.length > 0) {
      await this.store.appendMessage({
        id: newId("msg"),
        session_id: sessionId,
        turn_id,
        role: "assistant",
        content: assistantText,
        interrupted: true,
        created_at: nowIso(),
      });
    }
    await this.traces.append({
      session_id: sessionId,
      turn_id,
      type: "cancel",
      detail: { reason: "user" },
    });
    this.emit({ type: "done", turn_id, reason: "cancelled" });
  }
}
```

将导出追加到 `index.ts`。

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/agentRuntime.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/provider packages/core/src/runtime packages/core/tests/agentRuntime.test.ts packages/core/src/index.ts
git commit -m "feat(core): AgentRuntime ReAct loop with injectable provider and max steps"
```

---


### 任务 8：取消 / 中断行为

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/cancel.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/runtime/agentRuntime.ts`（仅当相比任务 7 仍有缺口时）

**接口：**
- 消费（Consumes）：`AgentRuntime.cancel()`、工具/provider 中的 abort signal
- 产出（Produces）：`done.reason === "cancelled"`；assistant `interrupted: true`；trace `type: "cancel"`；待处理的 tool_calls 不被执行

- [ ] **第 1 步：编写失败的取消测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/cancel.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import type { RuntimeEvent, AgentConfig } from "../src/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { TraceStore } from "../src/store/traceStore.js";

const cfg: AgentConfig = {
  baseUrl: "http://localhost",
  model: "test",
  apiKey: "sk",
  ...DEFAULT_AGENT_CONFIG,
};

describe("cancel", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("keeps partial assistant text as interrupted and writes cancel trace", async () => {
    const provider: LlmProvider = {
      async *chatStream(req) {
        yield { type: "text", text: "partial " };
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(() => resolve(), 2000);
        });
        if (!req.signal?.aborted) yield { type: "text", text: "more" };
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    const meta = await rt.createSession();
    const submitPromise = rt.submit(meta.session_id, "go");
    await new Promise((r) => setTimeout(r, 50));
    rt.cancel();
    await submitPromise;
    expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true);
    const msgs = await rt.loadMessages(meta.session_id);
    const asst = msgs.find((m) => m.role === "assistant");
    expect(asst?.interrupted).toBe(true);
    expect(asst?.content).toContain("partial");
    const traces = await new TraceStore(workspace).read(meta.session_id);
    expect(traces.some((t) => t.type === "cancel")).toBe(true);
  });

  it("does not execute tool_calls after cancel before tools run", async () => {
    const provider: LlmProvider = {
      async *chatStream(req): AsyncIterable<LlmStreamChunk> {
        yield {
          type: "tool_call_delta",
          tool_call: {
            id: "call_x",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "echo should_not_run" }),
            },
          },
        };
        await new Promise<void>((resolve) => {
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 2000);
        });
      },
    };
    const rt = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const meta = await rt.createSession();
    const p = rt.submit(meta.session_id, "go");
    await new Promise((r) => setTimeout(r, 30));
    rt.cancel();
    await p;
    const msgs = await rt.loadMessages(meta.session_id);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
  });
});
```

- [ ] **第 2 步：运行测试**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/cancel.test.ts`

预期：如果取消路径不完整则失败；否则通过。

- [ ] **第 3 步：如有需要，修补 AgentRuntime**

确保在流式输出期间收到 abort 时，以已累积的文本调用 `handleCancel`，并在执行工具之前返回。确保 bash 接收到 `signal`（任务 5）。不新增公共 API。

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/cancel.test.ts tests/agentRuntime.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/tests/cancel.test.ts packages/core/src/runtime/agentRuntime.ts
git commit -m "test(core): cancel keeps interrupted text and skips pending tools"
```

---

### 任务 9：OpenAI-compatible 流式 provider + 本地配置

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/provider/openaiCompatible.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/config/types.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/src/config/loadConfig.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/openaiCompatible.test.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/loadConfig.test.ts`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`

**接口：**
- 消费（Consumes）：`LlmProvider`、`AgentConfig`、`DEFAULT_AGENT_CONFIG`
- 产出（Produces）：
  - `export class OpenAICompatibleProvider implements LlmProvider { constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }); chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> }`
  - `export interface StoredConfig { baseUrl: string; model: string; apiKey: string; bashTimeoutMs?: number; maxSteps?: number; contextCharLimit?: number; maxToolOutputChars?: number; maxReadChars?: number; maxSearchResults?: number }`
  - `export function getDefaultConfigPath(): string` → `join(homedir(), ".long-task-agent", "config.json")`
  - `export async function loadStoredConfig(path?: string): Promise<StoredConfig | null>`
  - `export async function saveStoredConfig(cfg: StoredConfig, path?: string): Promise<void>`
  - `export function toAgentConfig(stored: StoredConfig): AgentConfig`

配置**不得**存放在 `{workspace}/.agent/` 下。

- [ ] **第 1 步：编写失败的测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/openaiCompatible.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../src/provider/openaiCompatible.js";

describe("OpenAICompatibleProvider", () => {
  it("parses SSE text deltas", async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"!"}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      fetchImpl,
    });
    const texts: string[] = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      if (c.type === "text" && c.text) texts.push(c.text);
    }
    expect(texts.join("")).toBe("Hi!");
  });

  it("surfaces HTTP auth errors as error chunk", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
      });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "bad",
      fetchImpl,
    });
    const chunks = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === "error")).toBe(true);
  });

  it("maps tool_calls deltas into tool_call_delta chunks", async () => {
    const args = JSON.stringify({ command: "pwd" }).replace(/"/g, '\\"');
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"${args}"}}]}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200 });
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.com/v1",
      apiKey: "sk",
      fetchImpl,
    });
    const tools = [];
    for await (const c of p.chatStream({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      model: "m",
    })) {
      if (c.type === "tool_call_delta") tools.push(c.tool_call);
    }
    expect(tools[0]?.function.name).toBe("bash");
  });
});
```

写入 `/workspace/long-task-desktop-agent/packages/core/tests/loadConfig.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStoredConfig, saveStoredConfig, toAgentConfig } from "../src/config/loadConfig.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips config outside workspace .agent", async () => {
    const path = join(dir, "config.json");
    await saveStoredConfig(
      {
        baseUrl: "https://api.example.com/v1",
        model: "gpt-x",
        apiKey: "sk-secret",
        maxSteps: 50,
      },
      path,
    );
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("sk-secret");
    const loaded = await loadStoredConfig(path);
    expect(loaded?.model).toBe("gpt-x");
    const agent = toAgentConfig(loaded!);
    expect(agent.maxSteps).toBe(50);
    expect(agent.bashTimeoutMs).toBe(60_000);
  });
});
```

- [ ] **第 2 步：运行测试，确认其失败**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/openaiCompatible.test.ts tests/loadConfig.test.ts`

预期：失败。

- [ ] **第 3 步：实现 provider 和配置**

写入 `/workspace/long-task-desktop-agent/packages/core/src/config/types.ts`：

```ts
export interface StoredConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  bashTimeoutMs?: number;
  maxSteps?: number;
  contextCharLimit?: number;
  maxToolOutputChars?: number;
  maxReadChars?: number;
  maxSearchResults?: number;
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/config/loadConfig.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { StoredConfig } from "./types.js";
import type { AgentConfig } from "../types.js";
import { DEFAULT_AGENT_CONFIG } from "../types.js";

export function getDefaultConfigPath(): string {
  return join(homedir(), ".long-task-agent", "config.json");
}

export async function loadStoredConfig(
  path = getDefaultConfigPath(),
): Promise<StoredConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StoredConfig;
  } catch {
    return null;
  }
}

export async function saveStoredConfig(
  cfg: StoredConfig,
  path = getDefaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
}

export function toAgentConfig(stored: StoredConfig): AgentConfig {
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey,
    bashTimeoutMs: stored.bashTimeoutMs ?? DEFAULT_AGENT_CONFIG.bashTimeoutMs,
    maxSteps: stored.maxSteps ?? DEFAULT_AGENT_CONFIG.maxSteps,
    contextCharLimit: stored.contextCharLimit ?? DEFAULT_AGENT_CONFIG.contextCharLimit,
    maxToolOutputChars:
      stored.maxToolOutputChars ?? DEFAULT_AGENT_CONFIG.maxToolOutputChars,
    maxReadChars: stored.maxReadChars ?? DEFAULT_AGENT_CONFIG.maxReadChars,
    maxSearchResults: stored.maxSearchResults ?? DEFAULT_AGENT_CONFIG.maxSearchResults,
  };
}
```

写入 `/workspace/long-task-desktop-agent/packages/core/src/provider/openaiCompatible.ts`：

```ts
import type { ToolCall } from "../types.js";
import type { LlmChatRequest, LlmProvider, LlmStreamChunk } from "./types.js";

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const url = `${this.baseUrl}/chat/completions`;
    const tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: tools.length ? tools : undefined,
          stream: true,
        }),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", error: String(err) };
      return;
    }
    if (!res.ok) {
      yield { type: "error", error: `HTTP ${res.status}: ${await res.text()}` };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: "Empty response body" };
      return;
    }

    const pending = new Map<number, ToolCall>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          for (const tc of pending.values()) {
            yield { type: "tool_call_delta", tool_call: tc };
          }
          return;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) yield { type: "usage", usage: json.usage };
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content.length) {
          yield { type: "text", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur =
              pending.get(idx) ??
              ({
                id: tc.id ?? `call_${idx}`,
                type: "function",
                function: { name: "", arguments: "" },
              } as ToolCall);
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) {
              cur.function.arguments += tc.function.arguments;
            }
            pending.set(idx, cur);
          }
        }
      }
    }
    for (const tc of pending.values()) {
      yield { type: "tool_call_delta", tool_call: tc };
    }
  }
}
```

更新 `index.ts`，导出 provider + config 模块。

- [ ] **第 4 步：运行测试，确认其通过**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core -- tests/openaiCompatible.test.ts tests/loadConfig.test.ts`

预期：通过。

- [ ] **第 5 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/core/src/provider/openaiCompatible.ts packages/core/src/config packages/core/tests/openaiCompatible.test.ts packages/core/tests/loadConfig.test.ts packages/core/src/index.ts
git commit -m "feat(core): OpenAI-compatible SSE provider and local config file"
```

---


### 任务 10：Electron 轻量外壳（session 列表 + 对话 + IPC）

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/app/package.json`
- 新建：`/workspace/long-task-desktop-agent/packages/app/tsconfig.json`
- 新建：`/workspace/long-task-desktop-agent/packages/app/scripts/copy-static.mjs`
- 新建：`/workspace/long-task-desktop-agent/packages/app/scripts/smoke-main.mjs`
- 新建：`/workspace/long-task-desktop-agent/packages/app/electron/main.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/app/electron/preload.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/app/src/renderer/index.html`
- 新建：`/workspace/long-task-desktop-agent/packages/app/src/renderer/main.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/app/src/renderer/ui.ts`
- 新建：`/workspace/long-task-desktop-agent/packages/app/src/renderer/styles.css`
- 新建：`/workspace/long-task-desktop-agent/packages/app/README.md`
- 修改：`/workspace/long-task-desktop-agent/packages/core/src/index.ts`（确保所有导出齐全）

**接口：**
- 消费（Consumes）：`AgentRuntime`、`OpenAICompatibleProvider`、`loadStoredConfig`、`saveStoredConfig`、`toAgentConfig`、`RuntimeEvent`、`StoredConfig`
- 产出（Produces）`window.agent` IPC：
  - `selectWorkspace(): Promise<string | null>`
  - `createSession(title?: string): Promise<SessionMeta>`
  - `listSessions(): Promise<SessionMeta[]>`
  - `loadMessages(sessionId: string): Promise<Message[]>`
  - `submit(sessionId: string, text: string): Promise<void>`
  - `cancel(): Promise<void>`
  - `getConfig(): Promise<StoredConfig | null>`
  - `saveConfig(cfg: StoredConfig): Promise<void>`
  - `onEvent(cb: (e: RuntimeEvent) => void): () => void`

UI：左侧为 session 列表 + workspace/配置按钮；中间为消息 + 输入框 + 发送/停止。没有右侧面板。

- [ ] **第 1 步：搭建 app package 脚手架**

```bash
mkdir -p /workspace/long-task-desktop-agent/packages/app/electron \
  /workspace/long-task-desktop-agent/packages/app/src/renderer \
  /workspace/long-task-desktop-agent/packages/app/scripts
```

写入 `/workspace/long-task-desktop-agent/packages/app/package.json`：

```json
{
  "name": "@agent/app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/electron/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json && node ./scripts/copy-static.mjs",
    "start": "npm run build && electron .",
    "smoke": "npm run build && node ./scripts/smoke-main.mjs"
  },
  "dependencies": {
    "@agent/core": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "electron": "^33.0.0",
    "typescript": "^5.7.0"
  }
}
```

写入 `/workspace/long-task-desktop-agent/packages/app/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["electron/**/*", "src/**/*"]
}
```

写入 `/workspace/long-task-desktop-agent/packages/app/scripts/copy-static.mjs`：

```js
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "dist/src/renderer");
await mkdir(destDir, { recursive: true });
await copyFile(join(root, "src/renderer/index.html"), join(destDir, "index.html"));
await copyFile(join(root, "src/renderer/styles.css"), join(destDir, "styles.css"));
```

写入 `/workspace/long-task-desktop-agent/packages/app/scripts/smoke-main.mjs`：

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("electron");
console.log("electron module resolvable");
console.log("app smoke ok");
```

- [ ] **第 2 步：实现 main、preload、renderer**

写入 `/workspace/long-task-desktop-agent/packages/app/electron/main.ts`：

```ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  OpenAICompatibleProvider,
  loadStoredConfig,
  saveStoredConfig,
  toAgentConfig,
} from "@agent/core";
import type { RuntimeEvent, StoredConfig } from "@agent/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let runtime: AgentRuntime | null = null;
let workspacePath: string | null = null;

function sendEvent(e: RuntimeEvent) {
  win?.webContents.send("agent:event", e);
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
  runtime = new AgentRuntime({ workspacePath, config, provider });
  runtime.onEvent(sendEvent);
  return runtime;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, "../src/renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("agent:selectWorkspace", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    workspacePath = res.filePaths[0];
    runtime = null;
    return workspacePath;
  });

  ipcMain.handle("agent:createSession", async (_e, title?: string) => {
    return (await ensureRuntime()).createSession(title);
  });
  ipcMain.handle("agent:listSessions", async () => (await ensureRuntime()).listSessions());
  ipcMain.handle("agent:loadMessages", async (_e, sessionId: string) =>
    (await ensureRuntime()).loadMessages(sessionId),
  );
  ipcMain.handle("agent:submit", async (_e, sessionId: string, text: string) => {
    await (await ensureRuntime()).submit(sessionId, text);
  });
  ipcMain.handle("agent:cancel", async () => {
    runtime?.cancel();
  });
  ipcMain.handle("agent:getConfig", async () => loadStoredConfig());
  ipcMain.handle("agent:saveConfig", async (_e, cfg: StoredConfig) => {
    await saveStoredConfig(cfg);
    runtime = null;
  });
});
```

写入 `/workspace/long-task-desktop-agent/packages/app/electron/preload.ts`：

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeEvent } from "@agent/core";

contextBridge.exposeInMainWorld("agent", {
  selectWorkspace: () => ipcRenderer.invoke("agent:selectWorkspace"),
  createSession: (title?: string) => ipcRenderer.invoke("agent:createSession", title),
  listSessions: () => ipcRenderer.invoke("agent:listSessions"),
  loadMessages: (sessionId: string) => ipcRenderer.invoke("agent:loadMessages", sessionId),
  submit: (sessionId: string, text: string) =>
    ipcRenderer.invoke("agent:submit", sessionId, text),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  getConfig: () => ipcRenderer.invoke("agent:getConfig"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("agent:saveConfig", cfg),
  onEvent: (cb: (e: RuntimeEvent) => void) => {
    const listener = (_: unknown, e: RuntimeEvent) => cb(e);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
```

写入 `/workspace/long-task-desktop-agent/packages/app/src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Long-Task Agent</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app">
      <aside id="sidebar">
        <button id="btn-workspace">选择工作区</button>
        <button id="btn-new">新建会话</button>
        <button id="btn-config">配置模型</button>
        <ul id="session-list"></ul>
        <div id="workspace-label"></div>
      </aside>
      <main id="main">
        <div id="messages"></div>
        <div id="composer">
          <textarea id="input" rows="3" placeholder="输入消息…"></textarea>
          <button id="btn-send">发送</button>
          <button id="btn-stop">停止</button>
        </div>
        <div id="status"></div>
      </main>
    </div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

写入 `/workspace/long-task-desktop-agent/packages/app/src/renderer/styles.css`：

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; }
#app { display: flex; height: 100vh; }
#sidebar { width: 240px; border-right: 1px solid #ddd; padding: 12px; overflow: auto; }
#main { flex: 1; display: flex; flex-direction: column; }
#messages { flex: 1; overflow: auto; padding: 16px; }
#composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #ddd; }
#input { flex: 1; }
.msg { margin-bottom: 12px; white-space: pre-wrap; }
.msg.user { color: #111; }
.msg.assistant { color: #033; }
.msg.tool { color: #666; font-size: 12px; }
.msg.error { color: #a00; }
#session-list { list-style: none; padding: 0; }
#session-list li { padding: 6px; cursor: pointer; }
#session-list li.active { background: #eef; }
```

写入 `/workspace/long-task-desktop-agent/packages/app/src/renderer/ui.ts`：

```ts
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

export function appendMessage(container: HTMLElement, role: string, content: string) {
  const div = el("div", { class: `msg ${role}` }, `${role}: ${content}`);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}
```

写入 `/workspace/long-task-desktop-agent/packages/app/src/renderer/main.ts`：

```ts
import { appendMessage } from "./ui.js";

declare global {
  interface Window {
    agent: {
      selectWorkspace(): Promise<string | null>;
      createSession(title?: string): Promise<{ session_id: string; title?: string }>;
      listSessions(): Promise<Array<{ session_id: string; title?: string }>>;
      loadMessages(sessionId: string): Promise<Array<{ role: string; content: string }>>;
      submit(sessionId: string, text: string): Promise<void>;
      cancel(): Promise<void>;
      getConfig(): Promise<any>;
      saveConfig(cfg: any): Promise<void>;
      onEvent(cb: (e: any) => void): () => void;
    };
  }
}

const messagesEl = document.getElementById("messages")!;
const listEl = document.getElementById("session-list")!;
const statusEl = document.getElementById("status")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const workspaceLabel = document.getElementById("workspace-label")!;

let currentSessionId: string | null = null;
let streamingEl: HTMLElement | null = null;

async function refreshSessions() {
  const sessions = await window.agent.listSessions();
  listEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.textContent = s.title || s.session_id;
    if (s.session_id === currentSessionId) li.classList.add("active");
    li.onclick = async () => {
      currentSessionId = s.session_id;
      await loadCurrent();
      await refreshSessions();
    };
    listEl.appendChild(li);
  }
}

async function loadCurrent() {
  messagesEl.innerHTML = "";
  streamingEl = null;
  if (!currentSessionId) return;
  const msgs = await window.agent.loadMessages(currentSessionId);
  for (const m of msgs) appendMessage(messagesEl, m.role, m.content);
}

document.getElementById("btn-workspace")!.onclick = async () => {
  const path = await window.agent.selectWorkspace();
  if (path) {
    workspaceLabel.textContent = path;
    currentSessionId = null;
    await refreshSessions();
    messagesEl.innerHTML = "";
  }
};

document.getElementById("btn-new")!.onclick = async () => {
  const meta = await window.agent.createSession("会话");
  currentSessionId = meta.session_id;
  await refreshSessions();
  await loadCurrent();
};

document.getElementById("btn-config")!.onclick = async () => {
  const cur = (await window.agent.getConfig()) ?? {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
  };
  const baseUrl = prompt("base URL", cur.baseUrl) ?? cur.baseUrl;
  const model = prompt("model", cur.model) ?? cur.model;
  const apiKey = prompt("API key", cur.apiKey) ?? cur.apiKey;
  await window.agent.saveConfig({ ...cur, baseUrl, model, apiKey });
  statusEl.textContent = "配置已保存";
};

document.getElementById("btn-send")!.onclick = async () => {
  if (!currentSessionId) {
    statusEl.textContent = "请先新建会话";
    return;
  }
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  appendMessage(messagesEl, "user", text);
  streamingEl = appendMessage(messagesEl, "assistant", "");
  statusEl.textContent = "运行中…";
  try {
    await window.agent.submit(currentSessionId, text);
  } catch (err) {
    appendMessage(messagesEl, "error", String(err));
  }
};

document.getElementById("btn-stop")!.onclick = async () => {
  await window.agent.cancel();
  statusEl.textContent = "已请求停止";
};

window.agent.onEvent((e) => {
  if (e.type === "text") {
    if (!streamingEl) streamingEl = appendMessage(messagesEl, "assistant", "");
    streamingEl.textContent = (streamingEl.textContent || "") + e.delta;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else if (e.type === "tool_call") {
    appendMessage(messagesEl, "tool", `call ${e.tool_call.function.name}`);
    streamingEl = null;
  } else if (e.type === "tool_result") {
    appendMessage(messagesEl, "tool", e.content.slice(0, 500));
  } else if (e.type === "error") {
    appendMessage(messagesEl, "error", e.message);
  } else if (e.type === "done") {
    statusEl.textContent =
      e.reason === "max_steps"
        ? "已达步数上限，可继续或改指令"
        : e.reason === "cancelled"
          ? "已停止"
          : "完成";
    streamingEl = null;
  } else if (e.type === "status") {
    statusEl.textContent = e.phase;
  }
});
```

确保最终的 `/workspace/long-task-desktop-agent/packages/core/src/index.ts` 如下：

```ts
export * from "./types.js";
export * from "./ids.js";
export * from "./pathSandbox.js";
export * from "./store/sessionStore.js";
export * from "./store/traceStore.js";
export * from "./tools/host.js";
export * from "./context/compress.js";
export * from "./context/assemble.js";
export * from "./provider/types.js";
export * from "./provider/openaiCompatible.js";
export * from "./runtime/agentRuntime.js";
export * from "./runtime/errors.js";
export * from "./config/types.js";
export * from "./config/loadConfig.js";
```

写入 `/workspace/long-task-desktop-agent/packages/app/README.md`：

````md
# @agent/app

Electron 外壳。选择 workspace，配置 OpenAI-compatible 接口，进行对话。

```bash
cd /workspace/long-task-desktop-agent
npm install
npm run build -w @agent/core
npm start -w @agent/app
```
````

- [ ] **第 3 步：安装、构建、冒烟测试**

```bash
cd /workspace/long-task-desktop-agent
npm install
npm run build -w @agent/core
npm run build -w @agent/app
npm run smoke -w @agent/app
```

预期：构建成功；冒烟测试输出 `app smoke ok`。

- [ ] **第 4 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add packages/app packages/core/src/index.ts
git commit -m "feat(app): Electron thin shell with session list and chat IPC"
```

---

### 任务 11：恢复回归测试 + README 验收映射

**文件：**
- 新建：`/workspace/long-task-desktop-agent/packages/core/tests/recovery.test.ts`
- 修改：`/workspace/long-task-desktop-agent/README.md`

**接口：**
- 消费（Consumes）：`AgentRuntime`、`TraceStore`、假的 `LlmProvider`
- 产出（Produces）：恢复证明——新的 runtime 可按 `turn_id` 重新加载 messages/traces

- [ ] **第 1 步：编写恢复测试**

写入 `/workspace/long-task-desktop-agent/packages/core/tests/recovery.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import type { LlmProvider, LlmStreamChunk } from "../src/provider/types.js";
import { DEFAULT_AGENT_CONFIG } from "../src/types.js";
import { TraceStore } from "../src/store/traceStore.js";

async function* textOnly(text: string): AsyncIterable<LlmStreamChunk> {
  yield { type: "text", text };
}

describe("recovery", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-ws-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("new runtime instance reloads messages and traces by turn_id", async () => {
    const provider: LlmProvider = { chatStream: () => textOnly("pong") };
    const cfg = { baseUrl: "x", model: "m", apiKey: "k", ...DEFAULT_AGENT_CONFIG };
    const rt1 = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const meta = await rt1.createSession("recover");
    await rt1.submit(meta.session_id, "ping");

    const rt2 = new AgentRuntime({ workspacePath: workspace, config: cfg, provider });
    const sessions = await rt2.listSessions();
    expect(sessions.map((s) => s.session_id)).toContain(meta.session_id);
    const msgs = await rt2.loadMessages(meta.session_id);
    expect(msgs.find((m) => m.role === "user")?.content).toBe("ping");
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("pong");
    const turn = msgs[0]!.turn_id;
    const traces = await new TraceStore(workspace).read(meta.session_id);
    expect(traces.some((t) => t.turn_id === turn)).toBe(true);
  });
});
```

- [ ] **第 2 步：运行完整的 core 测试套件**

运行：`cd /workspace/long-task-desktop-agent && npm run test -w @agent/core`

预期：全部通过。

- [ ] **第 3 步：更新 README**

将 `/workspace/long-task-desktop-agent/README.md` 替换为：

````md
# 长任务桌面 Agent（第一阶段）

用于验证以下能力的单仓库：单 session、可中断的 ReAct（最多 50 步）、bash / read_file / keyword_search、OpenAI-compatible 流式输出、可从 `{workspace}/.agent/` 的 jsonl + trace 恢复。

## 包结构

- `/workspace/long-task-desktop-agent/packages/core` — `@agent/core` 运行时库（vitest，TDD）
- `/workspace/long-task-desktop-agent/packages/app` — `@agent/app` Electron 界面（左侧 session 列表，中间对话区）

## 开发

```bash
cd /workspace/long-task-desktop-agent
npm install
npm run test -w @agent/core
npm run build -w @agent/core
npm start -w @agent/app
```

配置（API key、base URL、model）：`~/.long-task-agent/config.json`，绝不写入 messages / trace。

Session 数据：`{workspace}/.agent/sessions/{sessionId}/meta.json|messages.jsonl|trace.jsonl`

## 验收（第一阶段）

1. 启动 Electron 应用
2. 配置 OpenAI-compatible 的 base URL / model / API key
3. 选择代码仓库 workspace 并创建 session
4. 界面中可见流式输出的 assistant 文本和工具事件
5. 点击停止会取消正在进行的工作；已输出的部分文本保留并标记为 interrupted
6. 重启应用后，历史记录从 `.agent/` 重新加载
7. messages 与 trace 通过 `turn_id` 关联
8. 达到最大步数时显示"继续 / 换个说法"的提示
````

- [ ] **第 4 步：提交**

```bash
cd /workspace/long-task-desktop-agent
git add README.md packages/core/tests/recovery.test.ts
git commit -m "test(core): session recovery and document phase-1 acceptance"
```

---

## 规格覆盖清单（自查）

| 规格要求 | 任务 |
| --- | --- |
| Monorepo core + app、TypeScript、Electron | 1, 10 |
| OpenAI-compatible provider | 9 |
| 一个 session ↔ 一个 workspace | 2, 7, 10 |
| `.agent/sessions/{id}/` 下的 meta + messages + trace | 2, 3 |
| 组装顺序 system → tools → history → user | 6 |
| 压缩：用户 turn >10 → 最早 3 个 + 最近 10 个 + 摘要；重叠时全部保留；字符限制 | 6 |
| 工具 bash（60s、截断、危险命令）、Read、关键词搜索；错误作为工具结果返回 | 5 |
| 路径沙箱 / 不得逃逸到 workspace 之外 | 4 |
| ReAct 循环、最多 50 步、提示 | 7 |
| 取消：interrupted 文本、终止 bash、跳过待处理工具、取消 trace | 5, 8 |
| 向 UI 流式推送事件 | 7, 10 |
| 本地配置；messages/trace 中不含 API key | 9 |
| 重启后恢复 | 11 |
| LLM/存储错误可见 | 7 |
| 无记忆 / 自定义工具 / 网页搜索 / 右侧面板 / subagents | 全局约束（无对应任务） |

## 实现者须知

- 所有产品代码的项目根目录：`/workspace/long-task-desktop-agent/`。
- Max-steps：当 tool_calls 到达且 `steps >= maxSteps` 时，**不要**运行工具；发出提示 + `done/max_steps`。
- `truncateOutput` 位于 `bash.ts` 中，并由 `host.ts` 重新导出。
- App 冒烟测试不需要显示器；完整的 GUI 检查在有显示器时手动进行。
- 每个任务完成后提交；保持 TDD 顺序：失败的测试 → 实现 → 通过 → 提交。
