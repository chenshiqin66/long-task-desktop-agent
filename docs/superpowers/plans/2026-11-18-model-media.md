# 模型类型、生图与媒体实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按当前选中模型的类型分流：生文继续走带工具的对话接口并可附带图片和视频，生图走图片生成接口并把图展示在对话里；模型页支持类型、复制和悬停显示操作按钮。

**Architecture:** 每条 `StoredModel` 增加 `kind`。runtime 在 `submit` 时按 `AgentConfig.kind` 分流，不另做意图识别。生图走 provider 的 `generateImage`（`POST ${baseUrl}/images/generations`），生成图存进会话 `images/`。视频作为新的消息附件，存进会话 `videos/`，仅在生文请求的最新用户消息里以 `video_url` 内容块发出。界面沿用现有会话媒体展示，补上视频按钮、视频播放，以及助手气泡里的生成图。

**Tech Stack:** TypeScript（strict、NodeNext）、vitest、Electron IPC、原生 DOM。

**Spec:** `docs/superpowers/specs/2026-11-18-model-media-design.md`。

---

## Global Constraints

- 只在 `D:\myAIrepo\fromGrokBot\long-task-desktop-agent` 里工作，分支就是本地 `main`。不要另开功能分支，不要改记忆模块的规格或计划。命令都在这个目录下用 PowerShell 跑。
- 代码、注释、文档、提交信息里不提其他产品的名字。指令文件只认 `AGENTS.md`。
- `@agent/core` 不依赖 Electron。core 的测试放 `packages/core/tests/*.test.ts`，从 `../src/...js` 导入；临时目录用 `mkdtemp`，清理用 `./rmWorkspace.js` 的 `rmWorkspace`。
- 单个测试文件：`npm run test -w @agent/core -- tests/<file>.test.ts`。全量：`npm test`。构建：`npm run build`。app 的纯逻辑脚本：`npm run smoke -w @agent/app`（先 `npm run build`）。
- `docs.test.ts` 要求 `StoredConfig` 的每个字段出现在 README 的配置表；README 和 `docs/*.md` 里的相对链接和锚点都要存在。`kind` 写在模型列表的说明里。不要在文档或计划的代码块里写 `](` 这种会破坏链接扫描的字符序列。
- 每个任务结束时 `npm test` 全绿；动到 app 的任务还要 `npm run build` 通过。
- 提交信息：一句英文主题，句号结尾，再空一行写正文。PowerShell 下写成 `git commit -m "Subject." -m "Body."`。每个任务结束只提交到本地 `main`，不自动 `git push`，除非用户当场要求。
- 注释只写代码表达不了的约束，不写来历，也不写「为什么这样改」。
- 时间一律 `nowIso()`，id 一律 `newId(prefix)`，都来自 `packages/core/src/ids.ts`。复制出的模型 id 用 `newId("model")`，视频 id 用 `newId("vid")`，生成图仍用 `newId("img")`。
- 用户上传图片的大小上限仍是 `MAX_IMAGE_BYTES`（1_500_000）。接口返回的生成图可能更大，另用 `MAX_GENERATED_IMAGE_BYTES = 15_000_000`，不要用上传上限把生成图拒掉。
- 应用仍把用户填写的 Base URL 去掉末尾斜杠后当作前缀，不自动改写。生文请求 `${baseUrl}/chat/completions`，生图请求 `${baseUrl}/images/generations`。

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `packages/core/src/config/modelKind.ts` | `ModelKind`、文案、`modelKindOf`、`parseModelKind`、`modelKindLabel` |
| `packages/core/src/provider/imageGeneration.ts` | 解析生图响应、组请求体（供 provider 使用的纯函数） |
| `packages/core/tests/modelKind.test.ts` | 类型缺省、非法值、复制模型 |
| `packages/core/tests/imageGeneration.test.ts` | 生图请求体和响应解析 |
| `packages/core/tests/generateRuntime.test.ts` | runtime 按类型分流、生图成功/失败、不支持的类型 |
| `packages/core/tests/videoStore.test.ts` | 视频存盘、校验、读取 |
| `packages/app/scripts/test-model-kind-label.mjs` | 模型页用到的类型文案与复制名称 |

修改：`packages/core/src/config/types.ts`、`packages/core/src/config/loadConfig.ts`、`packages/core/src/types.ts`、`packages/core/src/index.ts`、`packages/core/src/store/sessionStore.ts`、`packages/core/src/context/assemble.ts`、`packages/core/src/context/images.ts`、`packages/core/src/provider/types.ts`、`packages/core/src/provider/openaiCompatible.ts`、`packages/core/src/runtime/agentRuntime.ts`、`packages/core/src/runtime/explainRuntime.ts`、`packages/core/tests/loadConfig.test.ts`、`packages/core/tests/images.test.ts`、`packages/core/tests/openaiCompatible.test.ts`、`packages/core/tests/sessionStore.test.ts`；app 的 `packages/app/electron/main.ts`、`packages/app/electron/preload.ts`、`packages/app/src/renderer/index.html`、`packages/app/src/renderer/models.ts`、`packages/app/src/renderer/main.ts`、`packages/app/src/renderer/ui.ts`、`packages/app/src/renderer/styles.css`、`packages/app/src/renderer/explainPane.ts`；`README.md`、`docs/ui-behavior.md`、`docs/data-model.md`、`docs/architecture.md`。

---

### Task 1: 模型类型字段

**Files:**
- Create: `packages/core/src/config/modelKind.ts`
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/src/config/loadConfig.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/tests/loadConfig.test.ts`
- Test: `packages/core/tests/modelKind.test.ts`

**Interfaces:**
- Consumes: 现有 `StoredModel`、`toAgentConfig`、`cleanModel`、`readModelEntry`、`legacyModel`
- Produces: `export type ModelKind = "text" | "image" | "video" | "audio"`；`export const MODEL_KINDS: readonly ModelKind[]`；`export const MODEL_KIND_LABELS: Record<ModelKind, string>`（`text`→`生文`，`image`→`生图`，`video`→`生视频`，`audio`→`生音`）；`parseModelKind(raw: unknown): ModelKind`；`modelKindOf(entry: { kind?: unknown } | null | undefined): ModelKind`；`modelKindLabel(kind: ModelKind): string`；`StoredModel.kind: ModelKind`（写入时始终带上）；`AgentConfig.kind: ModelKind`

- [ ] **Step 1: Write the failing test**

在 `packages/core/tests/modelKind.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  MODEL_KIND_LABELS,
  modelKindLabel,
  modelKindOf,
  parseModelKind,
} from "../src/config/modelKind.js";

describe("modelKind", () => {
  it("treats a missing or unknown kind as text", () => {
    expect(parseModelKind(undefined)).toBe("text");
    expect(parseModelKind("")).toBe("text");
    expect(parseModelKind("chat")).toBe("text");
    expect(modelKindOf(null)).toBe("text");
    expect(modelKindOf({})).toBe("text");
    expect(modelKindOf({ kind: "image" })).toBe("image");
    expect(modelKindOf({ kind: "video" })).toBe("video");
    expect(modelKindOf({ kind: "audio" })).toBe("audio");
    expect(modelKindOf({ kind: "text" })).toBe("text");
  });

  it("labels the four kinds in Chinese", () => {
    expect(MODEL_KIND_LABELS).toEqual({
      text: "生文",
      image: "生图",
      video: "生视频",
      audio: "生音",
    });
    expect(modelKindLabel("image")).toBe("生图");
  });
});
```

在 `packages/core/tests/loadConfig.test.ts` 现有模型用例附近增加：

```ts
it("defaults a model kind to text and keeps a valid kind", () => {
  const stored = {
    baseUrl: "https://api.example.com/v1",
    model: "chat",
    apiKey: "sk",
    models: [
      { id: "a", name: "对话", baseUrl: "https://api.example.com/v1", model: "chat", apiKey: "sk" },
      { id: "b", name: "画图", baseUrl: "https://api.example.com/v1", model: "draw", apiKey: "sk", kind: "image" as const },
    ],
    currentModelId: "b",
  };
  const models = modelsOf(stored);
  expect(models[0]?.kind).toBe("text");
  expect(models[1]?.kind).toBe("image");
  expect(toAgentConfig(stored).kind).toBe("image");
  expect(toAgentConfig({ ...stored, currentModelId: "a" }).kind).toBe("text");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/modelKind.test.ts tests/loadConfig.test.ts`

Expected: FAIL，因为还没有 `modelKind.ts`，且 `toAgentConfig` 没有 `kind`。

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/config/modelKind.ts`：

```ts
export const MODEL_KINDS = ["text", "image", "video", "audio"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const MODEL_KIND_LABELS: Record<ModelKind, string> = {
  text: "生文",
  image: "生图",
  video: "生视频",
  audio: "生音",
};

export function parseModelKind(raw: unknown): ModelKind {
  return typeof raw === "string" && (MODEL_KINDS as readonly string[]).includes(raw)
    ? (raw as ModelKind)
    : "text";
}

export function modelKindOf(entry: { kind?: unknown } | null | undefined): ModelKind {
  return parseModelKind(entry?.kind);
}

export function modelKindLabel(kind: ModelKind): string {
  return MODEL_KIND_LABELS[kind];
}
```

`StoredModel` 增加 `kind: ModelKind`（从 `./modelKind.js` 引入类型）。`AgentConfig` 增加 `kind: ModelKind`。`DEFAULT_AGENT_CONFIG` 不需要带 `kind`（它本来就省略了 `baseUrl` / `model` / `apiKey`）；测试和 runtime 里手写 config 时补 `kind: "text"`，或把 `DEFAULT_AGENT_CONFIG` 改成也带 `kind: "text"`，选后者，少改测试：把 `DEFAULT_AGENT_CONFIG` 的类型改成 `Omit<AgentConfig, "baseUrl" | "model" | "apiKey">` 并加上 `kind: "text"`。

`cleanModel` / `readModelEntry` / `legacyModel` 都写入 `kind: modelKindOf(entry)`（旧记录和非法值变成 `text`）。`toAgentConfig` 增加 `kind: modelKindOf(current)`。从 `packages/core/src/index.ts` 导出这些符号。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/modelKind.test.ts tests/loadConfig.test.ts`

Expected: PASS。若其他测试因 `AgentConfig` 缺少 `kind` 失败，给 `DEFAULT_AGENT_CONFIG` 加上 `kind: "text"` 后再跑 `npm test`，把缺字段的手写 config 补上。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/config/modelKind.ts packages/core/src/config/types.ts packages/core/src/config/loadConfig.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/tests/modelKind.test.ts packages/core/tests/loadConfig.test.ts
git commit -m "Add a kind field to each stored model." -m "Missing or unknown values count as text, and the current model kind is copied into AgentConfig."
```

---

### Task 2: 复制模型

**Files:**
- Modify: `packages/core/src/config/loadConfig.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/tests/modelKind.test.ts` 或 `packages/core/tests/loadConfig.test.ts`
- Test: `packages/core/tests/loadConfig.test.ts`

**Interfaces:**
- Consumes: `modelsOf`、`normalizeStoredConfig`、`newId("model")`、`modelKindOf`
- Produces: `duplicateModel(stored: StoredConfig, modelId: string): StoredConfig`。新记录：新 id、`name` 为原名称加 `（副本）`、其余字段（含 `kind`、密钥、地址、模型名）与原来相同。不改变 `currentModelId`。找不到 id 时抛出 `Error("找不到这个模型")`。

- [ ] **Step 1: Write the failing test**

```ts
import { duplicateModel } from "../src/config/loadConfig.js";

it("duplicates a model with a new id and a copy suffix, without changing the current model", () => {
  const stored = {
    baseUrl: "https://api.example.com/v1",
    model: "draw",
    apiKey: "sk",
    currentModelId: "b",
    models: [
      { id: "a", name: "对话", baseUrl: "https://a.example/v1", model: "chat", apiKey: "sk-a", kind: "text" as const },
      { id: "b", name: "画图", baseUrl: "https://b.example/v1", model: "draw", apiKey: "sk-b", kind: "image" as const },
    ],
  };
  const next = duplicateModel(stored, "b");
  expect(next.currentModelId).toBe("b");
  expect(next.models).toHaveLength(3);
  const copied = next.models?.find((row) => row.id !== "a" && row.id !== "b");
  expect(copied?.id).toMatch(/^model_[a-f0-9]+$/);
  expect(copied?.name).toBe("画图（副本）");
  expect(copied?.baseUrl).toBe("https://b.example/v1");
  expect(copied?.model).toBe("draw");
  expect(copied?.apiKey).toBe("sk-b");
  expect(copied?.kind).toBe("image");
  expect(next.models?.find((row) => row.id === "b")?.name).toBe("画图");
});

it("throws when the model to duplicate is missing", () => {
  expect(() =>
    duplicateModel(
      { baseUrl: "", model: "", apiKey: "", models: [], currentModelId: undefined },
      "missing",
    ),
  ).toThrow("找不到这个模型");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/loadConfig.test.ts`

Expected: FAIL，`duplicateModel` 未导出。

- [ ] **Step 3: Write minimal implementation**

```ts
import { newId } from "../ids.js";

export function duplicateModel(stored: StoredConfig, modelId: string): StoredConfig {
  const models = modelsOf(stored);
  const source = models.find((entry) => entry.id === modelId);
  if (!source) throw new Error("找不到这个模型");
  const copy: StoredModel = {
    ...source,
    id: newId("model"),
    name: `${source.name}（副本）`,
    kind: modelKindOf(source),
  };
  return normalizeStoredConfig({
    ...stored,
    models: [...models, copy],
    currentModelId: stored.currentModelId ?? currentModelOf(stored)?.id,
  });
}
```

从 `index.ts` 导出。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/loadConfig.test.ts`

Expected: PASS。然后 `npm test`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/config/loadConfig.ts packages/core/src/index.ts packages/core/tests/loadConfig.test.ts
git commit -m "Duplicate a stored model without changing the current selection." -m "The copy gets a new id and a name suffix, and keeps the original kind and credentials."
```

---

### Task 3: 模型页的类型、复制和按钮显隐

**Files:**
- Modify: `packages/app/src/renderer/index.html`
- Modify: `packages/app/src/renderer/models.ts`
- Modify: `packages/app/src/renderer/styles.css`
- Create: `packages/app/scripts/test-model-kind-label.mjs`（若 renderer 不能直接跑 core 测试，则只测文案拼接；类型文案直接使用从 `@agent/core` 导入的 `MODEL_KIND_LABELS` / `modelKindLabel`）
- Modify: `README.md` 和 `docs/ui-behavior.md` 里模型页那一节（本任务就把用户看得见的按钮和类型写进去，避免 `docs.test.ts` 漏字段）

**Interfaces:**
- Consumes: `duplicateModel`、`modelKindOf`、`modelKindLabel`、`MODEL_KINDS`、`upsertModel`
- Produces: 表单增加类型下拉；列表和输入框旁的选择器能看出类型；「复制」新建后打开新记录的编辑表单；「复制」「修改」「移除」仅在行悬停或 `:focus-within` 时显示；「使用」在最右侧且一直可见；当前条不显示「使用」，仍显示「当前」

- [ ] **Step 1: Add the type field and copy action**

在 `#models-form` 的「显示名」后面加：

```html
<label class="field">类型
  <select id="model-kind">
    <option value="text">生文</option>
    <option value="image">生图</option>
    <option value="video">生视频</option>
    <option value="audio">生音</option>
  </select>
</label>
```

`models.ts` 的本地 `StoredModel` 增加 `kind?: ModelKind`。打开表单时写入 `kind` 下拉（缺省 `text`）。保存时带上 `kind: parseModelKind(kindSelect.value)`。

列表标题旁边显示类型文案，例如 `画图 · 生图`。输入框旁的 `<select id="composer-model">` 选项文本为 `名称（类型文案）`，当前选中生图时显示「画图（生图）」。

在 `modelRow` 里，「使用」单独放在行右侧，不属于隐藏组。另建 `div.mcp-actions-hover`，放入「复制」「修改」「移除」。复制：

```ts
textButton("复制", () => {
  void run(async () => {
    const cur = (await loadConfig()) ?? emptyConfig();
    const next = duplicateModel(cur, entry.id);
    await persist(next);
    const copied = next.models?.find((row) => row.id !== entry.id && !cur.models?.some((old) => old.id === row.id));
    if (copied) openForm(copied);
  });
}),
```

更稳妥的写法：复制前后对 id 做差集，打开新 id 那一条。不要把当前模型改成副本。

- [ ] **Step 2: Hide hover actions in CSS**

```css
.mcp-row .mcp-actions-hover {
  display: flex;
  gap: inherit;
  opacity: 0;
  pointer-events: none;
}
.mcp-row:hover .mcp-actions-hover,
.mcp-row:focus-within .mcp-actions-hover {
  opacity: 1;
  pointer-events: auto;
}
```

行布局保证「使用」在最右侧。不要用 `visibility` 藏「使用」。键盘 Tab 进到该行隐藏按钮时，靠 `:focus-within` 显示。

- [ ] **Step 3: Document the visible behavior**

README「能做什么」和配置说明里补：每条模型有类型（生文 / 生图 / 生视频 / 生音），缺省为生文；模型页可以复制一条；复制、修改、移除在鼠标移到该条时才出现，「使用」始终在最右侧。`docs/ui-behavior.md` 的模型页一节写同样规则。

- [ ] **Step 4: Build and test**

Run: `npm test` 然后 `npm run build` 然后 `npm run smoke -w @agent/app`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add packages/app/src/renderer/index.html packages/app/src/renderer/models.ts packages/app/src/renderer/styles.css README.md docs/ui-behavior.md
git commit -m "Let a model be copied and show its kind on the models page." -m "Copy, edit, and remove stay hidden until the row is hovered or focused. Use stays visible on the right."
```

---

### Task 4: 视频附件的存储

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/store/sessionStore.ts`
- Test: `packages/core/tests/videoStore.test.ts`

**Interfaces:**
- Consumes: `newId("vid")`、现有 `sessionDir`、路径校验方式
- Produces:

```ts
export type VideoMime = "video/mp4" | "video/webm" | "video/quicktime";
export interface VideoAttachment {
  id: string;
  mime: VideoMime;
  path: string; // videos/vid_<hex>.mp4 | .webm | .mov
}
export interface SubmittedVideo {
  mime: VideoMime;
  base64: string;
}
```

`Message` 增加可选 `videos?: VideoAttachment[]`。

`export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;`
`export const MAX_VIDEOS_PER_MESSAGE = 1;`
`saveVideo(sessionId, mime, base64): Promise<VideoAttachment>`
`readVideoForSend(sessionId, relativePath): Promise<{ dataUrl: string; bytes: number }>`
`readVideoDataUrl(sessionId, relativePath): Promise<string>`
`extForVideoMime(mime: string): "mp4" | "webm" | "mov" | null`（`video/quicktime` → `mov`）
路径正则：`/^videos\/vid_[a-f0-9]+\.(mp4|webm|mov)$/`，读取时必须落在会话目录的 `videos/` 下。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, MAX_VIDEO_BYTES, sessionDir } from "../src/store/sessionStore.js";
import { rmWorkspace } from "./rmWorkspace.js";

describe("video attachments", () => {
  let workspace: string;
  let store: SessionStore;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-vid-"));
    store = new SessionStore(workspace);
  });
  afterEach(async () => {
    await rmWorkspace(workspace);
  });

  it("stores a small mp4 under videos/ and reads it back as a data URL", async () => {
    const meta = await store.createSession();
    const bytes = Buffer.from("fake-mp4");
    const saved = await store.saveVideo(meta.session_id, "video/mp4", bytes.toString("base64"));
    expect(saved.id).toMatch(/^vid_[a-f0-9]+$/);
    expect(saved.mime).toBe("video/mp4");
    expect(saved.path).toBe(`videos/${saved.id}.mp4`);
    const onDisk = await readFile(join(sessionDir(workspace, meta.session_id), saved.path));
    expect(onDisk.equals(bytes)).toBe(true);
    const { dataUrl } = await store.readVideoForSend(meta.session_id, saved.path);
    expect(dataUrl).toBe(`data:video/mp4;base64,${bytes.toString("base64")}`);
  });

  it("rejects an empty or oversized video and an unknown type", async () => {
    const meta = await store.createSession();
    await expect(store.saveVideo(meta.session_id, "video/mp4", "")).rejects.toThrow(/empty or larger/i);
    const big = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1).toString("base64");
    await expect(store.saveVideo(meta.session_id, "video/mp4", big)).rejects.toThrow(/empty or larger/i);
    await expect(store.saveVideo(meta.session_id, "video/avi" as "video/mp4", "YQ==")).rejects.toThrow(/Unsupported video type/i);
  });

  it("rejects a path outside videos/", async () => {
    const meta = await store.createSession();
    await expect(store.readVideoForSend(meta.session_id, "images/img_ab.mp4")).rejects.toThrow(/Invalid video path/);
    await expect(store.readVideoForSend(meta.session_id, "videos/../meta.json")).rejects.toThrow(/Invalid video path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/videoStore.test.ts`

Expected: FAIL，没有 `saveVideo`。

- [ ] **Step 3: Write minimal implementation**

按 `saveImage` / `readImageForSend` 的结构实现 `saveVideo` / `readVideoForSend` / `readVideoDataUrl`，目录改为 `videos/`，上限改为 `MAX_VIDEO_BYTES`。从 `index.ts` 导出新类型和常量。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/videoStore.test.ts`

Expected: PASS。然后 `npm test`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/types.ts packages/core/src/store/sessionStore.ts packages/core/src/index.ts packages/core/tests/videoStore.test.ts
git commit -m "Store session videos next to the existing image files." -m "A message may reference one video of up to 20 MiB as mp4, webm, or quicktime."
```

---

### Task 5: 出站消息附带视频

**Files:**
- Modify: `packages/core/src/context/assemble.ts`
- Modify: `packages/core/src/context/images.ts`（或把媒体出站逻辑留在此文件，增加视频分支；不要为了改名而大搬文件）
- Modify: `packages/core/tests/images.test.ts` 或新建 `packages/core/tests/outboundMedia.test.ts`
- Test: `packages/core/tests/outboundMedia.test.ts`

**Interfaces:**
- Consumes: `AssembledMessage` 上的可选 `videos?: VideoAttachment[]`，以及 `readVideo` 回调
- Produces: `prepareOutbound` 同时处理图片和视频。只把最新一条用户消息里的媒体变成内容块；更早的图片仍用 `imageOmissionNote(count)`，更早的视频用 `videoOmissionNote(count)`，返回 `（此轮附有 ${count} 个视频，未再次发送。）`。视频块形状：`{ type: "video_url"; video_url: { url: string } }`。出站消息删除 `images` / `videos` 字段。`liveMediaMessageIndex` 可复用现有 `liveImageMessageIndex` 的规则：从后往前找最后一条用户消息，若该条既无图也无视频则返回 -1，否则返回该下标（有图或有视频都算「本轮有媒体」）。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { prepareOutbound, videoOmissionNote } from "../src/context/images.js";
import type { AssembledMessage } from "../src/context/assemble.js";

const video = { id: "vid_1", mime: "video/mp4" as const, path: "videos/vid_1.mp4" };

it("inlines only the latest user video as a video_url part", async () => {
  const messages: AssembledMessage[] = [
    { role: "user", content: "先看这个", videos: [video] },
    { role: "assistant", content: "好" },
    { role: "user", content: "再看这个", videos: [{ ...video, id: "vid_2", path: "videos/vid_2.mp4" }] },
  ];
  const prepared = await prepareOutbound(
    messages,
    async () => null,
    async (relativePath) =>
      relativePath === "videos/vid_2.mp4"
        ? { dataUrl: "data:video/mp4;base64,AAA", bytes: 3 }
        : null,
  );
  expect(prepared.messages[0]?.content).toBe(`先看这个\n${videoOmissionNote(1)}`);
  const last = prepared.messages[2];
  expect(Array.isArray(last?.content)).toBe(true);
  if (!Array.isArray(last?.content)) return;
  expect(last.content[0]).toEqual({ type: "text", text: "再看这个" });
  expect(last.content[1]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } });
  expect(last).not.toHaveProperty("videos");
});
```

现有 `prepareOutbound(messages, readImage)` 要增加第三个参数 `readVideo?`。没有视频的旧测试仍只传两个参数，行为不变。

`AssembledMessage` / `OutboundContent` 增加 `video_url` 这个 part 类型，以及可选 `videos`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/outboundMedia.test.ts tests/images.test.ts`

Expected: FAIL，`videoOmissionNote` 或第三参数不存在。

- [ ] **Step 3: Write minimal implementation**

扩展 `prepareOutbound`：对最新用户消息，先放文本，再放成功读到的图片块，再放成功读到的视频块；若只有媒体没有文本，文本底稿仍用「请看图片。」——若只有视频没有图也没有文本，改用「请看视频。」；若图和视频都有且没有文本，用「请看附件。」。旧的「只有图、没有文本」行为保持「请看图片。」

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/outboundMedia.test.ts tests/images.test.ts`

Expected: PASS。然后 `npm test`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/context/assemble.ts packages/core/src/context/images.ts packages/core/tests/outboundMedia.test.ts packages/core/tests/images.test.ts
git commit -m "Send the latest user video as a chat content part." -m "Older videos become a one-line note, matching the existing image omission rule."
```

---

### Task 6: 生图接口

**Files:**
- Create: `packages/core/src/provider/imageGeneration.ts`
- Modify: `packages/core/src/provider/types.ts`
- Modify: `packages/core/src/provider/openaiCompatible.ts`
- Test: `packages/core/tests/imageGeneration.test.ts`
- Modify: `packages/core/tests/openaiCompatible.test.ts`

**Interfaces:**
- Consumes: 现有 `OpenAICompatibleProvider` 的 `baseUrl`、`apiKey`、`fetchImpl`
- Produces:

```ts
export interface ImageGenRequest {
  model: string;
  prompt: string;
  images?: { dataUrl: string }[];
  signal?: AbortSignal;
}
export interface ImageGenResult {
  mime: ImageMime;
  base64: string;
}
export interface LlmProvider {
  chatStream(req: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
  generateImage?(req: ImageGenRequest): Promise<ImageGenResult>;
}
```

`OpenAICompatibleProvider.generateImage` 必须实现。请求：`POST ${baseUrl}/images/generations`，头与对话请求相同（`Content-Type: application/json`，`Authorization: Bearer …`），body 只含 `model`、`prompt`，若 `images` 非空再加 `image`：一张时值为该 data URL，多张时值为 data URL 数组。不发 size 等可选项，不发 tools，不设 stream。

解析用纯函数 `parseImageGenerationResponse(body: unknown, contentType?: string): ImageGenResult`：优先 `data[0].b64_json`（缺 mime 时当 `image/png`）；否则 `data[0].url` 由 `generateImage` 再 GET 下载，按响应 `content-type` 或 URL 后缀判断 `png` / `jpeg` / `webp` / `gif`，转 base64。解析不到或非 2xx 时抛出包含 `HTTP ${status}: ${text}` 或简短说明的 `Error`。`signal` 中止时把中止错误原样抛出，不要包装成普通失败。

- [ ] **Step 1: Write the failing test**

`packages/core/tests/imageGeneration.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { buildImageGenerationBody, parseImageGenerationResponse } from "../src/provider/imageGeneration.js";

it("builds a body with model, prompt, and optional reference images", () => {
  expect(buildImageGenerationBody({ model: "draw", prompt: "一只猫" })).toEqual({
    model: "draw",
    prompt: "一只猫",
  });
  expect(
    buildImageGenerationBody({
      model: "draw",
      prompt: "一只猫",
      images: [{ dataUrl: "data:image/png;base64,AAA" }],
    }),
  ).toEqual({
    model: "draw",
    prompt: "一只猫",
    image: "data:image/png;base64,AAA",
  });
  expect(
    buildImageGenerationBody({
      model: "draw",
      prompt: "一只猫",
      images: [
        { dataUrl: "data:image/png;base64,AAA" },
        { dataUrl: "data:image/png;base64,BBB" },
      ],
    }),
  ).toEqual({
    model: "draw",
    prompt: "一只猫",
    image: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
  });
});

it("reads b64_json from the first data item", () => {
  const result = parseImageGenerationResponse({
    data: [{ b64_json: "AAA", url: "https://example.com/x.png" }],
  });
  expect(result).toEqual({ mime: "image/png", base64: "AAA" });
});
```

`packages/core/tests/openaiCompatible.test.ts` 增加：

```ts
it("posts generateImage to images/generations without tools and returns b64_json", async () => {
  const seen: { url?: string; body?: unknown } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.url = String(input);
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), { status: 200 });
  };
  const p = new OpenAICompatibleProvider({
    baseUrl: "https://example.com/v1/",
    apiKey: "sk-test",
    fetchImpl,
  });
  const result = await p.generateImage({ model: "draw", prompt: "一只猫" });
  expect(seen.url).toBe("https://example.com/v1/images/generations");
  expect(seen.body).toEqual({ model: "draw", prompt: "一只猫" });
  expect(result).toEqual({ mime: "image/png", base64: "QUJD" });
});

it("downloads a url result and surfaces HTTP errors", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.png" }] }), { status: 200 });
    }
    return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
  };
  const p = new OpenAICompatibleProvider({
    baseUrl: "https://example.com/v1",
    apiKey: "sk",
    fetchImpl,
  });
  const result = await p.generateImage({ model: "draw", prompt: "x" });
  expect(result.mime).toBe("image/png");
  expect(Buffer.from(result.base64, "base64").equals(png)).toBe(true);

  const failing = new OpenAICompatibleProvider({
    baseUrl: "https://example.com/v1",
    apiKey: "sk",
    fetchImpl: async () => new Response("nope", { status: 400 }),
  });
  await expect(failing.generateImage({ model: "draw", prompt: "x" })).rejects.toThrow(/HTTP 400: nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/imageGeneration.test.ts tests/openaiCompatible.test.ts`

Expected: FAIL，没有这些函数或方法。

- [ ] **Step 3: Write minimal implementation**

实现 `buildImageGenerationBody`、`parseImageGenerationResponse`，以及 `OpenAICompatibleProvider.generateImage`。URL 下载失败（非 2xx 或空正文）当作生图失败。不要把 apiKey 写进错误字符串。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/imageGeneration.test.ts tests/openaiCompatible.test.ts`

Expected: PASS。然后 `npm test`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/provider/imageGeneration.ts packages/core/src/provider/types.ts packages/core/src/provider/openaiCompatible.ts packages/core/tests/imageGeneration.test.ts packages/core/tests/openaiCompatible.test.ts
git commit -m "Call the images endpoint to generate a picture." -m "The request sends only model, prompt, and optional reference images, and accepts either base64 or a download URL."
```

---

### Task 7: runtime 按类型分流

**Files:**
- Modify: `packages/core/src/store/sessionStore.ts`（生成图放宽上限）
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/types.ts`（如需新的 RuntimeEvent）
- Test: `packages/core/tests/generateRuntime.test.ts`

**Interfaces:**
- Consumes: `AgentConfig.kind`、`generateImage`、`saveImage`、`saveVideo`、`prepareOutbound`、现有 `submit`
- Produces:

`submit(sessionId, text, images?: SubmittedImage[], videos?: SubmittedVideo[])`。`heldSubmit` 同样带上 `videos`。

`MAX_VIDEOS_PER_MESSAGE`：超过则抛 `AgentError(..., "bad_image")` 或新建 `"bad_video"`，选 `"bad_video"`，文案 `At most ${MAX_VIDEOS_PER_MESSAGE} video`。

`saveImage` 增加可选 `opts.maxBytes`，生成图传入 `MAX_GENERATED_IMAGE_BYTES`。用户上传路径不改。

RuntimeEvent 增加：

```ts
| { type: "generated_images"; turn_id: string; message_id: string; images: ImageAttachment[] }
```

并把 `status.phase` 增加 `"generating_image"`。

分流（在用户消息已经入盘之后、调用 `chatStream` 之前）：

1. `kind` 为 `video` 或 `audio`：追加一条助手消息，正文为 `这个类型第一版还不能用，请改选生文或生图`，发出 `text`（或只靠 loadMessages）和 `done(completed)`，不调用任何 provider 方法。
2. `kind` 为 `image`：若修剪后的提示词为空，发出 `error`（code 可用 `bad_request`），message 为 `生图请先输入提示词`，不调用接口。若本轮用户消息带了视频，发出 `error`，message 为 `生图不发送视频，请先去掉视频，或改用生文模型`，不调用接口。否则 `status: generating_image`，调用 `provider.generateImage`。成功则把图存盘、追加带 `images` 的助手消息（正文可为空字符串）、发出 `generated_images`，再 `done(completed)`。失败则不写空气泡，发出 `error`（把 `HTTP …` 原文带上），`done(error)`。用户停止则中止 `signal`，`done(cancelled)`，不留占位消息。
3. `kind` 为 `text` 或缺省：现有对话循环。`prepareOutbound` 传入 `readVideo`。没有 `generateImage` 也没有关系。

不要因为用户文本像「画一张图」就改走生图。不要在失败后改走另一类型。

- [ ] **Step 1: Write the failing test**

用与 `images.test.ts` 相同的 `AgentRuntime` 装配方式。手写 provider：`chatStream` 若被调用就 `throw` 或记录下来；`generateImage` 返回 `{ mime: "image/png", base64: PNG }` 或拒绝。

至少覆盖：

- 选生图、提示词「一只猫」：`chatStream` 不被调用，`generateImage` 收到 `{ model, prompt: "一只猫" }`，会话里助手消息有 `images[0].path` 匹配 `^images/img_[a-f0-9]+\.png$`，监听方收到 `generated_images`。若本轮同时带了用户图片，`generateImage` 的 `images` 里应有这些参考图的 data URL。
- 选生图、空提示词：不调用 provider，错误文案为 `生图请先输入提示词`。
- 选生图且带视频：不调用 provider，错误文案为 `生图不发送视频，请先去掉视频，或改用生文模型`。
- 选生视频或生音：不调用 provider，助手正文为 `这个类型第一版还不能用，请改选生文或生图`。
- 选生文且带视频：`chatStream` 被调用，最新用户消息的 content 里有 `video_url`。
- 生图 HTTP 失败：没有助手图片消息，错误里带 `HTTP 400`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/generateRuntime.test.ts`

Expected: FAIL，`submit` 还不会按 kind 分流。

- [ ] **Step 3: Write minimal implementation**

在 `AgentRuntime.submit`（以及 held / replay 的同等入口）接入上述分支。`replay` 必须把原用户消息上已存的 `videos` 一并重发，不要丢掉。解释 runtime 留到任务 9。生图成功并 `done(completed)` 时，走现有的正常结束路径（包括记忆提取），不要单独跳过。

把用户消息的 `videos` 写入 jsonl，与 `images` 相同，不把 base64 写进消息记录。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/generateRuntime.test.ts tests/images.test.ts`

Expected: PASS。然后 `npm test`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/store/sessionStore.ts packages/core/src/runtime/agentRuntime.ts packages/core/src/types.ts packages/core/tests/generateRuntime.test.ts
git commit -m "Route a turn by the current model kind." -m "Image models call generateImage, text models still use the tool loop, and video or audio kinds explain they are not available yet."
```

---

### Task 8: 对话里上传视频并展示生成图

**Files:**
- Modify: `packages/app/electron/main.ts`
- Modify: `packages/app/electron/preload.ts`
- Modify: `packages/app/src/renderer/index.html`
- Modify: `packages/app/src/renderer/main.ts`
- Modify: `packages/app/src/renderer/ui.ts`
- Modify: `packages/app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `submit(..., images, videos)`、`readVideoDataUrl`、`generated_images`、`status.phase === "generating_image"`
- Produces: 输入框旁「添加视频」与「添加图片」并排；预览待发送视频；气泡里可播放已存视频；助手只有图没有文字时气泡仍显示；生成过程显示「正在生成图片」，成功后换成图片，失败不留空气泡。

- [ ] **Step 1: Extend IPC and submit**

`normalizeSubmittedVideos` 与现有 `normalizeSubmittedImages` 并列，校验 mime 为三种视频类型。`agent:submit` / preload 的 `submit` 增加可选 `videos` 参数。增加读取视频 data URL 的 IPC（路径校验走 `SessionStore.readVideoDataUrl`）。把 `generated_images` 和扩展后的 `status` 转到渲染进程。

- [ ] **Step 2: Composer and bubbles**

在 `#btn-image` 旁加 `#btn-video`（`aria-label="添加视频"`）和隐藏的 `<input id="video-input" type="file" accept="video/mp4,video/webm,video/quicktime" hidden />`。一次只能待发送 1 个视频；超过或超 20 MiB 或类型不对时，用现有状态栏提示，不发出。

`ui.ts` 的 `stampVisibleBubble`：用户或助手，只要有文字、图片或视频，就视为可见。

```ts
const visible = Boolean(content.trim() || images?.length || videos?.length);
```

`addMessage` / 刷新气泡时，视频用 `<video controls src="...">` 放在 `.msg-images` 旁的 `.msg-videos` 里。重新打开会话时，用新 IPC 把路径转成 data URL 再播放，不要假设文件 URL 能直接访问。

收到 `status.phase === "generating_image"` 时，助手气泡显示「正在生成图片」。收到 `generated_images` 或 `done` 后，用已保存的图片替换占位；`done(error)` 或 `error` 时去掉占位气泡。

- [ ] **Step 3: Build and test**

Run: `npm test` 然后 `npm run build` 然后 `npm run smoke -w @agent/app`

Expected: PASS。

- [ ] **Step 4: Commit**

```powershell
git add packages/app/electron/main.ts packages/app/electron/preload.ts packages/app/src/renderer/index.html packages/app/src/renderer/main.ts packages/app/src/renderer/ui.ts packages/app/src/renderer/styles.css
git commit -m "Show generated images and let a turn attach a video." -m "The composer gains a video button, and assistant bubbles can display pictures without text."
```

---

### Task 9: 解释面板只用于生文

**Files:**
- Modify: `packages/core/src/runtime/explainRuntime.ts`
- Modify: `packages/core/tests/explain.test.ts`
- Modify: `packages/app/src/renderer/index.html`
- Modify: `packages/app/src/renderer/explainPane.ts`
- Modify: `packages/app/electron/main.ts`（若解释提交也要带视频，仅在生文时发送）

**Interfaces:**
- Consumes: 当前 `AgentConfig.kind`
- Produces: 当前类型不是 `text` 时，解释入口不可用，界面说明「解释请改选生文模型」。解释面板已有添加图片，则同样加上添加视频，提交生文解释请求时按与主对话相同的内容块规则发出。选生图 / 生视频 / 生音时不要调用解释接口。

- [ ] **Step 1: Write the failing test**

在 `explain.test.ts` 增加：当 config.kind 为 `image` / `video` / `audio` 时，`explainSubmit`（或对应方法）抛错或返回明确错误 `解释请改选生文模型`，且不调用 `chatStream`。kind 为 `text` 且带视频时，请求里包含 `video_url`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/explain.test.ts`

Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

runtime 先检查 `kind`。界面在打开解释面板或当前模型变化时，按类型禁用输入和发送，并显示上述说明。为解释面板加上与主输入框相同的视频按钮和限制。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/explain.test.ts`

Expected: PASS。然后 `npm test`、`npm run build`、`npm run smoke -w @agent/app`。

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/runtime/explainRuntime.ts packages/core/tests/explain.test.ts packages/app/src/renderer/index.html packages/app/src/renderer/explainPane.ts packages/app/electron/main.ts
git commit -m "Keep the explain pane on text models only." -m "It can attach a video for a text model, and tells the user to switch when the current model generates media."
```

---

### Task 10: 补文档

**Files:**
- Modify: `README.md`
- Modify: `docs/ui-behavior.md`
- Modify: `docs/data-model.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: 已实现行为
- Produces: 四份文档与规格一致，且 `npm test` 里的 `docs.test.ts` 全绿。

- [ ] **Step 1: Update the docs**

写明：

- 模型类型四种、缺省生文、按当前所选类型分流，没有意图识别
- 生图请求 `${baseUrl}/images/generations`，只发 model、prompt 和可选参考图；助手气泡展示生成图
- 生视频 / 生音第一版只提示暂不可用
- 输入框可上传最多 4 张图和 1 个视频（20 MiB，mp4 / webm / quicktime）；视频存 `videos/`
- 解释面板只用于生文
- 模型页复制与按钮显隐（若任务 3 已写过，这里只补遗漏，不重复改口径）
- `docs/data-model.md` 补 `kind`、`videos`、生成图仍走 `images/`、密钥仍不写日志

不要写具体第三方模型名。不要在代码块里写 `](`。

- [ ] **Step 2: Run docs and full tests**

Run: `npm test` 然后 `npm run build`

Expected: PASS。

- [ ] **Step 3: Commit**

```powershell
git add README.md docs/ui-behavior.md docs/data-model.md docs/architecture.md
git commit -m "Document model kinds, image generation, and video attachments." -m "The docs match the routing rules, the composer media limits, and the models page actions."
```

---

## 实现时的注意点

- 先写失败测试，再写最少实现，不要先改代码再补测试。
- 某一任务里若发现必须改规格（例如某服务生图必填 size），停下来写进规格再继续，不要悄悄改行为。
- 生成图和用户上传图共用 `ImageAttachment` 和展示组件，不要再做一套并行类型。
- 不要把 Base URL 从用户填写的值改写成另一条路径。
