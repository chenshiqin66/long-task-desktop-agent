# Seedream 生图参数实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型页按 Doubao-Seedream 三个型号保存各自的生图参数，让运行时把这些参数发进 `/images/generations`，并让 composer 生图标签出现和生视频同位置、同样式的本轮参数芯片。

**Architecture:** 新增 `imageOptions` 参数目录和归一化，挂到 `StoredModel.imagePreset/image/imageByModel` 与 `AgentConfig.image`。runtime 在生图分流时合并模型默认和本轮 `options.image`，解析成 `size`、`output_format`、`background`、`watermark`、`optimize_prompt_options` 交给 provider。renderer 因为不能 import core，另放一份 `imageModelForm.ts` 镜像同一套纯函数，模型页和 composer 都用它。

**Tech Stack:** TypeScript（strict、NodeNext）、vitest、Electron IPC、原生 DOM。

**Spec:** `docs/superpowers/specs/2026-11-24-seedream-image-options-design.md`。

---

## Global Constraints

- 只在 `D:\myAIrepo\fromGrokBot\long-task-desktop-agent` 里工作，分支就是本地 `main`。不要另开功能分支，不要改生视频的现有行为（除了把公共的复选框辅助函数加一个可选参数）。
- 代码、注释、文档、提交信息里不提其他产品的名字。指令文件只认 `AGENTS.md`。
- `@agent/core` 不依赖 Electron。core 的测试放 `packages/core/tests/*.test.ts`，从 `../src/...js` 导入；临时目录用 `mkdtemp`，清理用 `./rmWorkspace.js` 的 `rmWorkspace`。
- 单个测试文件：`npm run test -w @agent/core -- tests/<file>.test.ts`。全量：`npm test`。构建：`npm run build`。app 的纯逻辑脚本：`npm run smoke -w @agent/app`（先 `npm run build`）。
- 三个型号：`Doubao-Seedream-5.0-pro`、`Doubao-Seedream-5.5`、`Doubao-Seedream-5.0-flash`。官方 ID 分别是 `doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-5-261028`、`doubao-seedream-5-0-flash-260915`。
- 尺寸档位 `1K` / `1.5K` / `2K`，默认 `2K`；画幅 `auto` / `1:1` / `4:3` / `3:4` / `16:9` / `9:16`，默认 `auto`。`auto` 发档位字符串，具体画幅发 `宽x高`。
- 尺寸映射：`1K` 的 `1:1/4:3/3:4/16:9/9:16` 依次是 `1024x1024`、`1152x864`、`864x1152`、`1280x720`、`720x1280`；`1.5K` 依次是 `1536x1536`、`1728x1296`、`1296x1728`、`1920x1080`、`1080x1920`；`2K` 依次是 `2048x2048`、`2304x1728`、`1728x2304`、`2560x1440`、`1440x2560`。
- 默认格式：5.0-pro `jpeg`、5.5 `png`、5.0-flash `jpeg`。默认背景：5.0-pro / 5.0-flash `opaque`，5.5 `auto`。水印默认开。提示词优化默认 `standard`；只有 5.0-pro 支持 `fast`。
- 只要背景启用 `transparent`，格式就必须启用 `png`；默认背景是 `transparent` 时默认格式必须是 `png`。运行时合并后若 `background === "transparent"`，强制 `format = "png"`。
- 生图仍只保存一张图，不改 `ImageGenResult`；不发 `response_format`、`safety_identifier`、`layer_decomposition`、`sequential_image_generation`。
- 每个任务结束时 `npm test` 全绿；动到 app 的任务还要 `npm run build` 和 `npm run smoke -w @agent/app` 通过。
- 提交信息：一句英文主题，句号结尾，再空一行写正文。PowerShell 下写成 `git commit -m "Subject." -m "Body."`。每个任务结束只提交到本地 `main`，不自动 `git push`，除非用户当场要求。
- 注释只写代码表达不了的约束，不写来历，也不写「为什么这样改」。
- `docs.test.ts` 会检查 `StoredConfig` 的顶层字段出现在 README 配置表；`StoredModel` 新增字段不触发这条检查，但 README 的模型说明要写到。

## Review Focus

这些是规格暗示、但最容易在实现时漏掉的输入或失败方式；每个都在对应任务里有测试：

1. 旧生图模型没有 `image` / `imagePreset` 字段时，仍要能生成，且用户填的 Model 不能被改写。
2. Model 是 `ep-...` Endpoint ID 时，preset 不能从名字推断，必须靠 `imagePreset` 决定参数，Model 原样发送。
3. `background=transparent` 和 `format=jpeg` 的组合永远不能出现在请求里；模型页、composer、runtime 三处都要挡住或纠正。
4. 本轮覆盖里的非法值（旧配置、手改配置、过期 composer）要回退到模型默认，不能把非法 `size` / `ratio` 发给接口。
5. `output_format: "jpeg"` 的返回图要以 `image/jpeg` 存，不能当 PNG；5.5 / 5.0-flash 不能收到 `optimize_prompt_options`。

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `packages/core/src/config/imageOptions.ts` | 三个型号的目录、类型、默认值、归一化、摘要、本轮合并 |
| `packages/core/tests/imageOptions.test.ts` | 目录默认值、过滤、透明背景规则、摘要、型号推断 |
| `packages/app/src/renderer/imageModelForm.ts` | 渲染进程镜像：同样的目录、类型、归一化、摘要 |
| `packages/app/scripts/test-image-model-form.mjs` | 渲染进程纯函数 + HTML 控件存在性 |

修改：

| 文件 | 职责 |
| --- | --- |
| `packages/core/src/config/types.ts` | `StoredModel` 增加 `imagePreset` / `image` / `imageByModel` |
| `packages/core/src/types.ts` | `AgentConfig.image`、`TurnSubmitOptions.image` |
| `packages/core/src/index.ts` | 导出 `imageOptions` |
| `packages/core/src/config/loadConfig.ts` | 生图条目归一化、`toAgentConfig` 带 `image` |
| `packages/core/src/provider/types.ts` | `ImageGenRequest` 增加参数 |
| `packages/core/src/provider/imageGeneration.ts` | 尺寸映射、请求体字段、MIME 解析 |
| `packages/core/src/provider/openaiCompatible.ts` | URL 下载的 MIME 兜底 |
| `packages/core/src/runtime/agentRuntime.ts` | 生图参数合并和请求字段 |
| `packages/app/src/renderer/models.ts` | 模型页生图 Tab 和参数组 |
| `packages/app/src/renderer/main.ts` | composer 生图芯片、本轮覆盖、提交参数 |
| `packages/app/src/renderer/index.html` | 模型页生图块、composer 芯片 |
| `packages/app/src/renderer/styles.css` | 生图芯片复用生视频芯片样式 |
| `packages/app/scripts/smoke-main.mjs` | 加入新脚本 |
| `README.md` / `docs/ui-behavior.md` / `docs/architecture.md` / `docs/data-model.md` / `docs/roadmap.md` | 文档同步 |

---

### Task 1: 核心参数目录与类型

**Files:**
- Create: `packages/core/src/config/imageOptions.ts`
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/imageOptions.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `ImagePresetId`、`ImageSizeTier`、`ImageRatio`、`ImageOutputFormat`、`ImageBackground`、`ImagePromptMode`、`ImageModelOptions`、`ImageByModel`
  - `IMAGE_MODEL_PRESETS`、`IMAGE_SIZE_TIERS`、`IMAGE_RATIOS`、`IMAGE_OUTPUT_FORMATS`、`IMAGE_BACKGROUNDS`、`IMAGE_PROMPT_MODES`、`DEFAULT_IMAGE_PRESET`
  - `parseImagePresetId(raw: unknown): ImagePresetId | undefined`
  - `inferImagePresetFromModel(model: string): ImagePresetId | undefined`
  - `imagePresetOf(raw: string): (typeof IMAGE_MODEL_PRESETS)[number] | undefined`
  - `defaultImageModelOptions(preset: ImagePresetId): ImageModelOptions`
  - `defaultImageByModel(): ImageByModel`
  - `normalizeImageModelOptions(preset: ImagePresetId, raw: Partial<ImageModelOptions> | Record<string, unknown> | null): ImageModelOptions`
  - `normalizeImageByModel(activePreset: ImagePresetId, imageByModelRaw?: unknown, activeImage?: Partial<ImageModelOptions> | null): { preset: ImagePresetId; image: ImageModelOptions; imageByModel: ImageByModel }`
  - `readImageModelOptions(preset: ImagePresetId, raw: unknown): ImageModelOptions | undefined`
  - `mergeImageOptions(base: ImageModelOptions, override?: Partial<Pick<ImageModelOptions, "size" | "ratio" | "format" | "background" | "watermark" | "promptMode">> | null): ImageModelOptions`
  - `imageOptionsSummary(options: ImageModelOptions): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/imageOptions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  defaultImageByModel,
  defaultImageModelOptions,
  imageOptionsSummary,
  inferImagePresetFromModel,
  mergeImageOptions,
  normalizeImageModelOptions,
  type ImageSizeTier,
} from "../src/config/imageOptions.js";

describe("image model options", () => {
  it("lists per-model defaults", () => {
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-pro")).toMatchObject({
      size: "2K",
      ratio: "auto",
      format: "jpeg",
      background: "opaque",
      watermark: true,
      promptMode: "standard",
    });
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-pro").promptModes).toEqual([
      "standard",
      "fast",
    ]);
    expect(defaultImageModelOptions("Doubao-Seedream-5.5")).toMatchObject({
      format: "png",
      background: "auto",
      promptModes: ["standard"],
    });
    expect(defaultImageModelOptions("Doubao-Seedream-5.0-flash")).toMatchObject({
      format: "jpeg",
      background: "opaque",
    });
    expect(Object.keys(defaultImageByModel())).toEqual([
      "Doubao-Seedream-5.0-pro",
      "Doubao-Seedream-5.5",
      "Doubao-Seedream-5.0-flash",
    ]);
  });

  it("filters choices the model does not support", () => {
    const opts = normalizeImageModelOptions("Doubao-Seedream-5.5", {
      sizes: ["2K"],
      ratios: ["16:9"],
      formats: ["jpeg"],
      backgrounds: ["opaque"],
      watermark: false,
      promptModes: ["fast"],
      size: "2K",
      ratio: "16:9",
      format: "jpeg",
      background: "opaque",
      promptMode: "fast",
    });
    expect(opts.promptModes).toEqual(["standard"]);
    expect(opts.promptMode).toBe("standard");
    expect(opts.watermark).toBe(false);
  });

  it("requires at least one value in every enabled group", () => {
    expect(() =>
      normalizeImageModelOptions("Doubao-Seedream-5.0-pro", {
        sizes: [],
        ratios: ["auto"],
        formats: ["png"],
        backgrounds: ["opaque"],
        watermark: true,
        promptModes: ["standard"],
        size: "2K",
        ratio: "auto",
        format: "png",
        background: "opaque",
        promptMode: "standard",
      }),
    ).toThrow(/尺寸/);
  });

  it("adds png when transparent is enabled and forces png for a transparent default", () => {
    const opts = normalizeImageModelOptions("Doubao-Seedream-5.0-pro", {
      sizes: ["2K"],
      ratios: ["auto"],
      formats: ["jpeg"],
      backgrounds: ["opaque", "transparent"],
      watermark: true,
      promptModes: ["standard"],
      size: "2K",
      ratio: "auto",
      format: "jpeg",
      background: "transparent",
      promptMode: "standard",
    });
    expect(opts.formats).toContain("png");
    expect(opts.format).toBe("png");
  });

  it("merges this turn's values only when the model enables them", () => {
    const base = defaultImageModelOptions("Doubao-Seedream-5.0-pro");
    expect(
      mergeImageOptions(base, {
        size: "1.5K",
        ratio: "16:9",
        format: "png",
        background: "transparent",
        watermark: false,
      }),
    ).toMatchObject({
      size: "1.5K",
      ratio: "16:9",
      format: "png",
      background: "transparent",
      watermark: false,
    });
    expect(
      mergeImageOptions(base, {
        size: "4K" as unknown as ImageSizeTier,
      }),
    ).toMatchObject({ size: "2K" });
  });

  it("summarizes size, ratio, format, fast, transparency, and watermark", () => {
    const base = defaultImageModelOptions("Doubao-Seedream-5.0-pro");
    expect(imageOptionsSummary(base)).toBe("2K · 自动 · jpeg · 水印");
    expect(
      imageOptionsSummary({
        ...base,
        promptMode: "fast",
        background: "transparent",
        format: "png",
        watermark: false,
      }),
    ).toBe("2K · 自动 · png · fast · 透明背景 · 无水印");
  });

  it("infers the preset from a model name", () => {
    expect(inferImagePresetFromModel("doubao-seedream-5-0-pro-260628")).toBe(
      "Doubao-Seedream-5.0-pro",
    );
    expect(inferImagePresetFromModel("doubao-seedream-5-5-261028")).toBe("Doubao-Seedream-5.5");
    expect(inferImagePresetFromModel("doubao-seedream-5-0-flash-260915")).toBe(
      "Doubao-Seedream-5.0-flash",
    );
    expect(inferImagePresetFromModel("ep-20240101")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent/core -- tests/imageOptions.test.ts`
Expected: FAIL，`imageOptions.js` 不存在或导出缺失。

- [ ] **Step 3: Implement `packages/core/src/config/imageOptions.ts`**

按 Interfaces 实现。要点：

- 三个 preset 的目录项形状：
  ```ts
  {
    id: ImagePresetId;
    label: string;              // "5.0-pro" / "5.5" / "5.0-flash"
    defaultModel: string;       // 官方 ID
    blurb: string;
    sizes: readonly ImageSizeTier[];
    ratios: readonly ImageRatio[];
    formats: readonly ImageOutputFormat[];
    defaultFormat: ImageOutputFormat;
    backgrounds: readonly ImageBackground[];
    defaultBackground: ImageBackground;
    promptModes: readonly ImagePromptMode[];
    defaultPromptMode: ImagePromptMode;
  }
  ```
- `normalizeImageModelOptions` 按 preset 过滤每个启用组；空组抛错（`请至少勾选一种尺寸`、`请至少勾选一种画幅`、`请至少勾选一种输出格式`、`请至少勾选一种背景`、`请至少勾选一种提示词优化`）。单选值用「优先原值，否则默认，最后第一项」。
- 透明背景修正放在归一化最后：`backgrounds` 包含 `transparent` 但 `formats` 不含 `png` 时把 `png` 加进 `formats`；`background === "transparent"` 时把 `format` 设为 `png`。
- `normalizeImageByModel` 对每组 `try normalizeImageModelOptions`，失败用默认值；`activeImage` 再覆盖当前 preset。
- `readImageModelOptions` 捕获归一化错误并返回默认值。
- `mergeImageOptions` 只接受 base 启用集合里的值；`watermark` 只在布尔时采用；合并后透明背景强制 `png`。
- `imageOptionsSummary` 顺序：尺寸、画幅、格式、`fast`（仅当 `promptMode === "fast"`）、`透明背景`（仅当 `background === "transparent"`）、`水印` / `无水印`，用 ` · ` 连接。
- `inferImagePresetFromModel` 把名字转小写、`. _ 空白` 统一成 `-`，按 `5-0-pro`、`5-0-flash`、`5-5` 的顺序匹配；`ep-` 开头返回 `undefined`。

- [ ] **Step 4: Modify `packages/core/src/config/types.ts`**

在 `StoredModel` 里加：

```ts
import type { ImageByModel, ImageModelOptions, ImagePresetId } from "./imageOptions.js";

export interface StoredModel {
  // 现有字段不变
  imagePreset?: ImagePresetId;
  image?: ImageModelOptions;
  imageByModel?: ImageByModel;
}
```

- [ ] **Step 5: Modify `packages/core/src/types.ts`**

在 `AgentConfig` 加 `image?: ImageModelOptions`，在 `TurnSubmitOptions` 加：

```ts
image?: Partial<
  Pick<ImageModelOptions, "size" | "ratio" | "format" | "background" | "watermark" | "promptMode">
>;
```

从 `./config/imageOptions.js` 导入 `ImageModelOptions`。

- [ ] **Step 6: Modify `packages/core/src/index.ts`**

在 `export * from "./config/videoOptions.js";` 旁边加：

```ts
export * from "./config/imageOptions.js";
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test -w @agent/core -- tests/imageOptions.test.ts`
Expected: PASS。

- [ ] **Step 8: Run full core tests**

Run: `npm test`
Expected: PASS。

- [ ] **Step 9: Commit**

```powershell
git add packages/core/src/config/imageOptions.ts packages/core/src/config/types.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/tests/imageOptions.test.ts
git commit -m "Add image model option types and defaults." -m "The three Seedream presets carry their own sizes, formats, backgrounds, prompt modes, and a transparent-background PNG rule."
```

---

### Task 2: 配置归一化与 AgentConfig

**Files:**
- Modify: `packages/core/src/config/loadConfig.ts`
- Test: `packages/core/tests/loadConfig.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `defaultImageModelOptions`、`inferImagePresetFromModel`、`normalizeImageByModel`、`parseImagePresetId`、`readImageModelOptions`、`DEFAULT_IMAGE_PRESET`。
- Produces: `modelsOf` / `toAgentConfig` / `duplicateModel` 对生图条目的完整处理。

- [ ] **Step 1: Write the failing tests**

在 `packages/core/tests/loadConfig.test.ts` 末尾加（并补 import `defaultImageModelOptions`）：

```ts
it("normalizes image options and infers the preset from the model name", () => {
  const stored = {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-5-5-261028",
    apiKey: "sk",
    models: [
      {
        id: "img",
        name: "生图",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seedream-5-5-261028",
        apiKey: "sk",
        kind: "image" as const,
      },
    ],
    currentModelId: "img",
  };
  const model = modelsOf(stored)[0]!;
  expect(model.imagePreset).toBe("Doubao-Seedream-5.5");
  expect(model.image).toMatchObject({ size: "2K", ratio: "auto", format: "png", background: "auto" });
  expect(model.imageByModel?.["Doubao-Seedream-5.0-pro"]).toBeDefined();
  expect(toAgentConfig(stored).image).toEqual(model.image);
});

it("keeps an endpoint id and falls back to the first preset", () => {
  const stored = {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "ep-20240101",
    apiKey: "sk",
    models: [
      {
        id: "img",
        name: "生图",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "ep-20240101",
        apiKey: "sk",
        kind: "image" as const,
      },
    ],
    currentModelId: "img",
  };
  const model = modelsOf(stored)[0]!;
  expect(model.model).toBe("ep-20240101");
  expect(model.imagePreset).toBe("Doubao-Seedream-5.0-pro");
  expect(model.image?.format).toBe("jpeg");
});

it("copies image options when duplicating a model", () => {
  const image = defaultImageModelOptions("Doubao-Seedream-5.0-flash");
  const stored = {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-5-0-flash-260915",
    apiKey: "sk",
    models: [
      {
        id: "img",
        name: "生图",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seedream-5-0-flash-260915",
        apiKey: "sk",
        kind: "image" as const,
        imagePreset: "Doubao-Seedream-5.0-flash" as const,
        image,
      },
    ],
    currentModelId: "img",
  };
  const copied = duplicateModel(stored, "img").models?.find((row) => row.name.includes("副本"));
  expect(copied?.imagePreset).toBe("Doubao-Seedream-5.0-flash");
  expect(copied?.image).toEqual(image);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @agent/core -- tests/loadConfig.test.ts`
Expected: FAIL，`imagePreset` / `image` 是 `undefined`。

- [ ] **Step 3: Implement in `packages/core/src/config/loadConfig.ts`**

- 补 import。
- `readModelEntry`：先算
  ```ts
  const imagePreset =
    parseImagePresetId(row.imagePreset) ??
    inferImagePresetFromModel(modelName) ??
    DEFAULT_IMAGE_PRESET;
  ```
  再在返回对象里按 `kind === "image"` 加：
  ```ts
  imagePreset,
  image: row.image ? readImageModelOptions(imagePreset, row.image) : undefined,
  imageByModel:
    row.imageByModel && typeof row.imageByModel === "object"
      ? (row.imageByModel as StoredModel["imageByModel"])
      : undefined,
  ```
- `cleanModel`：`kind === "image"` 时
  ```ts
  const preset =
    parseImagePresetId(entry.imagePreset) ??
    inferImagePresetFromModel(model) ??
    DEFAULT_IMAGE_PRESET;
  const packed = normalizeImageByModel(preset, entry.imageByModel, entry.image);
  cleaned.imagePreset = packed.preset;
  cleaned.image = packed.image;
  cleaned.imageByModel = packed.imageByModel;
  ```
  `cleaned.model` 保持 `entry.model.trim()`，不要改成官方 ID。
- `toAgentConfig`：`kind === "image"` 时
  ```ts
  image:
    current?.image ??
    defaultImageModelOptions(inferImagePresetFromModel(model) ?? DEFAULT_IMAGE_PRESET),
  ```
- `duplicateModel` 已经是对象展开，不用改。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @agent/core -- tests/loadConfig.test.ts`
Expected: PASS。

- [ ] **Step 5: Run full core tests**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/config/loadConfig.ts packages/core/tests/loadConfig.test.ts
git commit -m "Normalize image options in stored config." -m "Image models get a preset, a per-model defaults map, and an AgentConfig image field; endpoint ids survive untouched."
```

---

### Task 3: Provider 请求体、尺寸映射与 MIME

**Files:**
- Modify: `packages/core/src/provider/types.ts`
- Modify: `packages/core/src/provider/imageGeneration.ts`
- Modify: `packages/core/src/provider/openaiCompatible.ts`
- Test: `packages/core/tests/imageGeneration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ImageSizeTier`、`ImageRatio`、`ImageOutputFormat`、`ImageBackground`、`ImagePromptMode`、`ImageModelOptions`。
- Produces:
  - `ImageGenRequest.size?: string`、`outputFormat?: ImageOutputFormat`、`background?: ImageBackground`、`watermark?: boolean`、`promptMode?: ImagePromptMode`
  - `resolveImageSize(options: Pick<ImageModelOptions, "size" | "ratio">): string`
  - `buildImageGenerationBody(...)` 输出 `size`、`output_format`、`background`、`watermark`、`optimize_prompt_options`
  - `parseImageGenerationResponse(body, contentType?, fallbackFormat?)` 认 `output_format`

- [ ] **Step 1: Write the failing tests**

在 `packages/core/tests/imageGeneration.test.ts` 补 import 和新测试：

```ts
import { buildImageGenerationBody, parseImageGenerationResponse, resolveImageSize } from "../src/provider/imageGeneration.js";

it("adds Seedream request options", () => {
  expect(
    buildImageGenerationBody({
      model: "draw",
      prompt: "一只猫",
      size: "2560x1440",
      outputFormat: "jpeg",
      background: "opaque",
      watermark: true,
      promptMode: "fast",
    }),
  ).toEqual({
    model: "draw",
    prompt: "一只猫",
    size: "2560x1440",
    output_format: "jpeg",
    background: "opaque",
    watermark: true,
    optimize_prompt_options: { mode: "fast" },
  });
});

it("maps size tiers and ratios to pixel sizes", () => {
  expect(resolveImageSize({ size: "2K", ratio: "auto" })).toBe("2K");
  expect(resolveImageSize({ size: "2K", ratio: "16:9" })).toBe("2560x1440");
  expect(resolveImageSize({ size: "2K", ratio: "1:1" })).toBe("2048x2048");
  expect(resolveImageSize({ size: "1.5K", ratio: "9:16" })).toBe("1080x1920");
  expect(resolveImageSize({ size: "1K", ratio: "4:3" })).toBe("1152x864");
});

it("reads output_format when the response has no mime", () => {
  expect(
    parseImageGenerationResponse({ data: [{ b64_json: "AAA", output_format: "jpeg" }] }),
  ).toEqual({ mime: "image/jpeg", base64: "AAA" });
  expect(
    parseImageGenerationResponse({ data: [{ b64_json: "AAA", output_format: "png" }] }),
  ).toEqual({ mime: "image/png", base64: "AAA" });
  expect(
    parseImageGenerationResponse({ data: [{ b64_json: "AAA" }] }, undefined, "jpeg"),
  ).toEqual({ mime: "image/jpeg", base64: "AAA" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @agent/core -- tests/imageGeneration.test.ts`
Expected: FAIL，`resolveImageSize` 不存在，请求体缺字段，`output_format` 没被读取。

- [ ] **Step 3: Implement `packages/core/src/provider/types.ts`**

给 `ImageGenRequest` 加：

```ts
size?: string;
outputFormat?: ImageOutputFormat;
background?: ImageBackground;
watermark?: boolean;
promptMode?: ImagePromptMode;
```

从 `../config/imageOptions.js` 导入这几个类型。

- [ ] **Step 4: Implement `packages/core/src/provider/imageGeneration.ts`**

- 加 `IMAGE_SIZE_MATRIX`，按 Global Constraints 的映射表。
- `resolveImageSize`：`ratio === "auto"` 返回 `options.size`，否则查表。
- `buildImageGenerationBody`：保留现有 `model` / `prompt` / `image`，按传入值追加 `size`、`output_format`、`background`、`watermark`、`optimize_prompt_options: { mode }`。没有传入的可选项不要写空字段。
- `parseImageGenerationResponse(body, contentType?, fallbackFormat?)`：MIME 顺序为 `mime` → `output_format` → `content-type` → `fallbackFormat` → `image/png`。`output_format` 用 `jpeg` → `image/jpeg`、`png` → `image/png`。

- [ ] **Step 5: Implement `packages/core/src/provider/openaiCompatible.ts`**

- `downloadGeneratedImage(imageUrl, signal?, preferredFormat?)`：MIME 顺序为 `content-type` → URL 扩展名 → `preferredFormat` → `image/png`。
- `generateImage` 调 `parseImageGenerationResponse(body, contentType, req.outputFormat)`，下载时把 `req.outputFormat` 传进去。

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -w @agent/core -- tests/imageGeneration.test.ts`
Expected: PASS。

- [ ] **Step 7: Run full core tests**

Run: `npm test`
Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add packages/core/src/provider/types.ts packages/core/src/provider/imageGeneration.ts packages/core/src/provider/openaiCompatible.ts packages/core/tests/imageGeneration.test.ts
git commit -m "Send Seedream image parameters and read their output format." -m "The request carries size, format, background, watermark, and prompt mode; JPEG responses keep the right MIME."
```

---

### Task 4: Runtime 合并与本轮覆盖

**Files:**
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Test: `packages/core/tests/generateRuntime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `defaultImageModelOptions`、`mergeImageOptions`、`inferImagePresetFromModel`、`DEFAULT_IMAGE_PRESET`；Task 3 的 `resolveImageSize`、`ImageGenRequest` 新字段。
- Produces: 生图轮请求带模型参数和本轮覆盖；`normalizeTurnOptions` 同时接受 `video` 和 `image`。

- [ ] **Step 1: Write the failing tests**

在 `packages/core/tests/generateRuntime.test.ts` 里：

1. 给 `makeRuntime` 增加第六个可选参数 `image?: ImageModelOptions`，并在 `kind === "image"` 时把 `image` 放进 config（没有就用 `defaultImageModelOptions("Doubao-Seedream-5.0-pro")`）。
2. 补 import `defaultImageModelOptions`、`type ImageModelOptions`。
3. 加测试：

```ts
it("sends the configured image options", async () => {
  const { provider, generateCalls } = imageProvider();
  const image = {
    ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
    size: "1.5K" as const,
    ratio: "16:9" as const,
    format: "png" as const,
    background: "transparent" as const,
    watermark: false,
    promptMode: "fast" as const,
  };
  const rt = makeRuntime(workspace, "image", provider, undefined, image);
  const meta = await rt.createSession();
  await rt.submit(meta.session_id, "一只猫");

  expect(generateCalls[0]).toMatchObject({
    size: "1920x1080",
    outputFormat: "png",
    background: "transparent",
    watermark: false,
    promptMode: "fast",
  });
});

it("applies this turn's image overrides", async () => {
  const { provider, generateCalls } = imageProvider();
  const rt = makeRuntime(workspace, "image", provider);
  const meta = await rt.createSession();
  await rt.submit(meta.session_id, "一只猫", undefined, undefined, undefined, {
    image: {
      size: "1.5K",
      ratio: "9:16",
      format: "png",
      background: "transparent",
      watermark: false,
      promptMode: "fast",
    },
  });

  expect(generateCalls[0]).toMatchObject({
    size: "1080x1920",
    outputFormat: "png",
    background: "transparent",
    watermark: false,
    promptMode: "fast",
  });
});

it("ignores image overrides the model does not enable", async () => {
  const { provider, generateCalls } = imageProvider();
  const rt = makeRuntime(workspace, "image", provider);
  const meta = await rt.createSession();
  await rt.submit(meta.session_id, "一只猫", undefined, undefined, undefined, {
    image: { size: "4K", ratio: "21:9", format: "gif" },
  });

  expect(generateCalls[0]).toMatchObject({ size: "2K", outputFormat: "jpeg" });
});

it("forces png when the configured background is transparent", async () => {
  const { provider, generateCalls } = imageProvider();
  const image = {
    ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"),
    background: "transparent" as const,
    format: "jpeg" as const,
  };
  const rt = makeRuntime(workspace, "image", provider, undefined, image);
  const meta = await rt.createSession();
  await rt.submit(meta.session_id, "一只猫");

  expect(generateCalls[0]).toMatchObject({ background: "transparent", outputFormat: "png" });
});

it("does not send prompt mode for a model without fast", async () => {
  const { provider, generateCalls } = imageProvider();
  const rt = makeRuntime(
    workspace,
    "image",
    provider,
    undefined,
    defaultImageModelOptions("Doubao-Seedream-5.5"),
  );
  const meta = await rt.createSession();
  await rt.submit(meta.session_id, "一只猫");

  expect(generateCalls[0]?.promptMode).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @agent/core -- tests/generateRuntime.test.ts`
Expected: FAIL，请求没有新字段，覆盖未生效。

- [ ] **Step 3: Implement in `packages/core/src/runtime/agentRuntime.ts`**

- 补 import。
- 在 `effectiveVideoOptions` 旁加：
  ```ts
  private effectiveImageOptions(): ImageModelOptions {
    const base =
      this.config.image ??
      defaultImageModelOptions(
        inferImagePresetFromModel(this.config.model) ?? DEFAULT_IMAGE_PRESET,
      );
    return mergeImageOptions(base, this.turnOptions?.image);
  }
  ```
- 生图分支调用 `generateImage` 时：
  ```ts
  const imageOpts = this.effectiveImageOptions();
  result = await this.provider.generateImage({
    model: this.config.model,
    prompt,
    ...(refImages.length ? { images: refImages } : {}),
    size: resolveImageSize(imageOpts),
    outputFormat: imageOpts.format,
    background: imageOpts.background,
    watermark: imageOpts.watermark,
    ...(imageOpts.promptModes.includes("fast") ? { promptMode: imageOpts.promptMode } : {}),
    signal: this.abort?.signal,
  });
  ```
- `normalizeTurnOptions`：把现有 video 解析抽成 `normalizeVideoTurnOptions(raw)`，新增 `normalizeImageTurnOptions(raw)`，两者都返回对象或 `undefined`；最终返回 `{ ...(video ? { video } : {}), ...(image ? { image } : {}) }`，都没有则 `null`。
- `normalizeImageTurnOptions` 只接受 `IMAGE_SIZE_TIERS` / `IMAGE_RATIOS` / `IMAGE_OUTPUT_FORMATS` / `IMAGE_BACKGROUNDS` / `IMAGE_PROMPT_MODES` 里的值，`watermark` 只接受布尔。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @agent/core -- tests/generateRuntime.test.ts`
Expected: PASS。

- [ ] **Step 5: Run full core tests**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/runtime/agentRuntime.ts packages/core/tests/generateRuntime.test.ts
git commit -m "Apply image options to generated turns." -m "Model defaults and per-turn overrides become request fields; unsupported values fall back, and transparent forces PNG."
```

---

### Task 5: Renderer 参数模块

**Files:**
- Create: `packages/app/src/renderer/imageModelForm.ts`
- Create: `packages/app/scripts/test-image-model-form.mjs`
- Modify: `packages/app/scripts/smoke-main.mjs`
- Test: `packages/app/scripts/test-image-model-form.mjs`

**Interfaces:**
- Consumes: 无（渲染进程不能 import core）。
- Produces: 与 Task 1 同名的类型、常量、函数；另外：
  - `IMAGE_SIZE_OPTIONS`、`IMAGE_RATIO_OPTIONS`、`IMAGE_FORMAT_OPTIONS`、`IMAGE_BACKGROUND_OPTIONS`、`IMAGE_PROMPT_MODE_OPTIONS`（`{ value, label }[]`）
  - `imagePresetLabel(preset): string`、`imageModelBlurb(preset): string`
  - `defaultImageModelIds(): Record<ImagePresetId, string>`
  - 复用 `videoModelForm.ts` 已导出的 `paintCheckGroup`、`readCheckGroup`、`readCheckGroupDefault`。

- [ ] **Step 1: Write the failing script**

Create `packages/app/scripts/test-image-model-form.mjs`:

```js
import assert from "node:assert/strict";
import {
  IMAGE_MODEL_PRESETS,
  defaultImageModelOptions,
  imageOptionsSummary,
  inferImagePresetFromModel,
  mergeImageOptions,
  normalizeImageModelOptions,
} from "../dist/src/renderer/imageModelForm.js";

assert.equal(IMAGE_MODEL_PRESETS.length, 3);
assert.equal(defaultImageModelOptions("Doubao-Seedream-5.5").format, "png");
assert.equal(defaultImageModelOptions("Doubao-Seedream-5.5").background, "auto");
assert.equal(
  imageOptionsSummary(defaultImageModelOptions("Doubao-Seedream-5.0-pro")),
  "2K · 自动 · jpeg · 水印",
);
assert.equal(
  inferImagePresetFromModel("doubao-seedream-5-0-flash-260915"),
  "Doubao-Seedream-5.0-flash",
);
assert.deepEqual(
  mergeImageOptions(defaultImageModelOptions("Doubao-Seedream-5.0-pro"), {
    size: "1K",
    ratio: "1:1",
  }),
  { ...defaultImageModelOptions("Doubao-Seedream-5.0-pro"), size: "1K", ratio: "1:1" },
);
assert.throws(
  () =>
    normalizeImageModelOptions("Doubao-Seedream-5.0-pro", {
      sizes: [],
      ratios: ["auto"],
      formats: ["png"],
      backgrounds: ["opaque"],
      watermark: true,
      promptModes: ["standard"],
      size: "2K",
      ratio: "auto",
      format: "png",
      background: "opaque",
      promptMode: "standard",
    }),
  /尺寸/,
);
console.log("image model form tests ok");
```

- [ ] **Step 2: Add the script to smoke and run it to verify it fails**

在 `packages/app/scripts/smoke-main.mjs` 的 `scripts` 数组里加 `["test-image-model-form.mjs"],`（放在 `test-model-kind-label.mjs` 旁边）。

Run: `npm run smoke -w @agent/app`
Expected: FAIL，`dist/src/renderer/imageModelForm.js` 不存在。

- [ ] **Step 3: Implement `packages/app/src/renderer/imageModelForm.ts`**

把 Task 1 的 `imageOptions.ts` 逻辑镜像过来，并从 `./videoModelForm.js` 导入 `paintCheckGroup`、`readCheckGroup`、`readCheckGroupDefault`。额外加：

```ts
export const IMAGE_SIZE_OPTIONS = [
  { value: "1K", label: "1K" },
  { value: "1.5K", label: "1.5K" },
  { value: "2K", label: "2K" },
] as const;

export const IMAGE_RATIO_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export const IMAGE_FORMAT_OPTIONS = [
  { value: "png", label: "png" },
  { value: "jpeg", label: "jpeg" },
] as const;

export const IMAGE_BACKGROUND_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "opaque", label: "opaque" },
  { value: "transparent", label: "transparent" },
] as const;

export const IMAGE_PROMPT_MODE_OPTIONS = [
  { value: "standard", label: "standard" },
  { value: "fast", label: "fast" },
] as const;

export function defaultImageModelIds(): Record<ImagePresetId, string> {
  return Object.fromEntries(
    IMAGE_MODEL_PRESETS.map((preset) => [preset.id, preset.defaultModel]),
  ) as Record<ImagePresetId, string>;
}
```

- `paintCheckGroup` 增加可选参数 `opts?: { minOne?: boolean }`：用户取消最后一个已勾选项时，把它重新勾上并返回，不触发后续 radio 逻辑。生视频调用不带这个参数，行为不变。
- `imagePresetLabel(preset)` 和 `imageModelBlurb(preset)` 内部用 `imagePresetOf` 查目录，找不到时回退到 preset 字符串。

- [ ] **Step 4: Run the script to verify it passes**

Run: `npm run build` 然后 `npm run smoke -w @agent/app`
Expected: PASS，输出包含 `image model form tests ok` 和 `app smoke ok`。

- [ ] **Step 5: Commit**

```powershell
git add packages/app/src/renderer/imageModelForm.ts packages/app/scripts/test-image-model-form.mjs packages/app/scripts/smoke-main.mjs packages/app/src/renderer/videoModelForm.ts
git commit -m "Mirror image options in the renderer." -m "The sandboxed renderer gets the same presets, normalization, summary, and merge rules as core, plus a min-one guard for checkbox groups."
```

---

### Task 6: 模型页生图配置

**Files:**
- Modify: `packages/app/src/renderer/index.html`
- Modify: `packages/app/src/renderer/models.ts`
- Modify: `packages/app/scripts/test-image-model-form.mjs`
- Test: `packages/app/scripts/test-image-model-form.mjs`

**Interfaces:**
- Consumes: Task 5 的 `imageModelForm.ts` 全部导出。
- Produces: 模型页选中 `image` 时显示三个 Tab、参数组、Model 自动填入、保存 `imagePreset` / `image` / `imageByModel`。

- [ ] **Step 1: Add failing HTML assertions**

在 `packages/app/scripts/test-image-model-form.mjs` 末尾加：

```js
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");
for (const id of [
  "model-image-options",
  "model-image-tabs",
  "model-image-blurb",
  "model-image-sizes",
  "model-image-ratios",
  "model-image-formats",
  "model-image-backgrounds",
  "model-image-watermark",
  "model-image-prompt-modes",
  "model-image-prompt-note",
  "model-image-baseurl-hint",
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
```

Run: `npm run smoke -w @agent/app`
Expected: FAIL，HTML 里还没有这些 id。

- [ ] **Step 2: Add the model form block to `index.html`**

在 `#model-video-options` 之后、API Key 之前插入：

```html
<p id="model-image-baseurl-hint" class="models-intro" hidden>
  生图走方舟 /images/generations。Base URL 填 https://ark.cn-beijing.volces.com/api/v3；Model 可填官方 ID 或 ep- 开头的 Endpoint ID。
</p>
<div id="model-image-options" class="model-video-options" hidden>
  <div id="model-image-tabs" class="video-option-tabs" role="tablist" aria-label="生图型号"></div>
  <div class="video-option-panel" role="tabpanel">
    <p id="model-image-blurb" class="video-model-blurb"></p>
    <fieldset class="video-check-group">
      <legend>尺寸 <span class="video-check-legend-hint">圆点默认</span></legend>
      <div id="model-image-sizes" class="video-check-row"></div>
    </fieldset>
    <fieldset class="video-check-group">
      <legend>画幅 <span class="video-check-legend-hint">圆点默认</span></legend>
      <div id="model-image-ratios" class="video-check-row"></div>
    </fieldset>
    <fieldset class="video-check-group">
      <legend>输出格式 <span class="video-check-legend-hint">圆点默认</span></legend>
      <div id="model-image-formats" class="video-check-row"></div>
    </fieldset>
    <fieldset class="video-check-group">
      <legend>背景 <span class="video-check-legend-hint">圆点默认</span></legend>
      <div id="model-image-backgrounds" class="video-check-row"></div>
    </fieldset>
    <label class="video-check">
      <input id="model-image-watermark" type="checkbox" checked />
      <span class="video-check-label">默认加水印</span>
    </label>
    <fieldset class="video-check-group" id="model-image-prompt-group">
      <legend>提示词优化 <span class="video-check-legend-hint">圆点默认</span></legend>
      <div id="model-image-prompt-modes" class="video-check-row"></div>
    </fieldset>
    <p id="model-image-prompt-note" class="models-intro" hidden>该型号固定 standard。</p>
  </div>
</div>
```

- [ ] **Step 3: Wire `models.ts`**

补 import、`StoredModel` 字段和 DOM refs，然后按下面的规则实现：

- `activeImagePreset` 默认 `DEFAULT_IMAGE_PRESET`；`imageDraftByModel = defaultImageByModel()`；`imageModelDraftByPreset = defaultImageModelIds()`。
- `readImageForm(preset)`：
  - 先读原始组：`sizes`、`ratios`、`formats`、`backgrounds`、`promptModes`、`watermark`。
  - 校验：`backgrounds` 含 `transparent` 且 `formats` 不含 `png` → 抛「透明背景需要同时启用 PNG 格式」；默认 `background === "transparent"` 且默认 `format !== "png"` → 抛「透明背景需要选择 PNG」。
  - 5.0-pro 才读提示词组；5.5 / 5.0-flash 固定 `promptModes: ["standard"]`、`promptMode: "standard"`。
  - 调 `normalizeImageModelOptions(preset, {...})`。
- `paintImageTabs(active)`：三个按钮，文案用 `imagePresetLabel`，点击时先 `stashActiveImageTab()`，再切换并 `modelInput.value = imageModelDraftByPreset[active]`。
- `paintImageParams(preset, options?)`：写 blurb、四组 check group（带 `minOne: true`）、水印 checkbox；只有 pro 显示提示词组，其他型号隐藏并显示 `#model-image-prompt-note`。
- `stashActiveImageTab()`：`try { imageDraftByModel[activeImagePreset] = readImageForm(activeImagePreset); imageModelDraftByPreset[activeImagePreset] = modelInput.value.trim(); } catch { /* keep previous */ }`。
- `loadImageDraft(entry?)`：按 `entry.imagePreset` → `inferImagePresetFromModel(entry.model)` → `DEFAULT_IMAGE_PRESET` 决定 preset；`normalizeImageByModel` 得到三组；`imageModelDraftByPreset = defaultImageModelIds()`，当前 preset 用 `entry.model` 覆盖；画 Tab 和参数；`modelInput.value = imageModelDraftByPreset[activeImagePreset]`。
- `syncKindFields()`：加 `const image = kind === "image"`；`imageOptions.hidden = !image`；`imageBaseUrlHint.hidden = !image`；`baseUrlInput.placeholder` 在 image 时写 Ark 地址；Base URL 为空时自动填 `https://ark.cn-beijing.volces.com/api/v3`；kind 为 image 时 `loadImageDraft()`。
- `openForm(entry)`：在现有 `syncKindFields()` 之后，如果 `modelKindOf(entry) === "image"` 再 `loadImageDraft(entry)`。`syncKindFields` 会先于 `baseUrlInput` / `modelInput` 赋值运行，所以 entry 版本必须最后再加载一次，以 entry 的 Model 和 Base URL 为准。
- `form submit`：`kind === "image"` 时
  ```ts
  const activeOptions = readImageForm(activeImagePreset);
  const packed = normalizeImageByModel(activeImagePreset, {
    ...imageDraftByModel,
    [activeImagePreset]: activeOptions,
  }, activeOptions);
  imagePreset = packed.preset;
  image = packed.image;
  imageByModel = packed.imageByModel;
  model = modelInput.value.trim() || imageModelDraftByPreset[activeImagePreset];
  ```
  然后把 `imagePreset` / `image` / `imageByModel` 写进 `StoredModel`。`model` 不能为空（沿用现有校验）。
- `modelRow`：`kind === "image"` 时摘要用
  ```ts
  entry.image ??
    defaultImageModelOptions(
      parseImagePresetId(entry.imagePreset) ??
        inferImagePresetFromModel(entry.model) ??
        DEFAULT_IMAGE_PRESET,
    )
  ```
  再 `imageOptionsSummary(...)`，和 `speechHost` 一起拼进 `summary.textContent`。

- [ ] **Step 4: Run build, script, and smoke**

Run: `npm run build` 然后 `npm run smoke -w @agent/app`
Expected: PASS，输出包含 `image model form tests ok` 和 `app smoke ok`。

- [ ] **Step 5: Manual check**

Run: `npm start`，打开「模型」页，添加一条类型为「生图」的模型：确认三个 Tab、Model 自动填入、切 Tab 保留参数、透明背景与 PNG 联动、保存后列表摘要出现。关掉应用。

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/renderer/index.html packages/app/src/renderer/models.ts packages/app/scripts/test-image-model-form.mjs
git commit -m "Configure Seedream models on the models page." -m "Image models get three preset tabs, per-preset sizes, ratios, formats, backgrounds, watermark, and prompt mode, with the model id auto-filled and editable."
```

---

### Task 7: Composer 生图芯片

**Files:**
- Modify: `packages/app/src/renderer/index.html`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/src/renderer/main.ts`
- Modify: `packages/app/scripts/test-image-model-form.mjs`
- Test: `packages/app/scripts/test-image-model-form.mjs`

**Interfaces:**
- Consumes: Task 5 的 `defaultImageModelOptions`、`mergeImageOptions`、`imageOptionsSummary`、`IMAGE_*_OPTIONS`；Task 4 的 `TurnSubmitOptions.image` 形状。
- Produces: composer 生图标签的摘要芯片、本轮参数弹层、提交时的 `options.image`。

- [ ] **Step 1: Add failing HTML assertions**

在 `packages/app/scripts/test-image-model-form.mjs` 的 id 列表里加：

```js
"composer-image-chip",
"composer-image-summary",
"composer-image-pop",
```

Run: `npm run smoke -w @agent/app`
Expected: FAIL，composer 还没有这些 id。

- [ ] **Step 2: Add the composer chip markup**

在 `index.html` 的 `#composer-video-chip` 后面加：

```html
<div id="composer-image-chip" class="composer-image-chip" hidden>
  <button type="button" id="composer-image-summary" class="composer-image-summary" aria-expanded="false" aria-controls="composer-image-pop">2K · 自动 · jpeg · 水印</button>
  <div id="composer-image-pop" class="composer-image-pop" hidden role="dialog" aria-label="本轮生图参数"></div>
</div>
```

- [ ] **Step 3: Extend `styles.css`**

把现有的 `.composer-video-chip`、`.composer-video-summary`、`.composer-video-pop`、`.composer-video-pop label`、`.composer-video-pop select` 选择器改成同时覆盖 `.composer-image-*`，并在收起态规则里加上 `.composer-image-chip`：

```css
.composer-video-chip,
.composer-image-chip { /* 原有规则 */ }
.composer-video-summary,
.composer-image-summary { /* 原有规则 */ }
.composer-video-pop,
.composer-image-pop { /* 原有规则 */ }
.composer-video-pop label,
.composer-image-pop label { /* 原有规则 */ }
.composer-video-pop select,
.composer-image-pop select { /* 原有规则 */ }

#composer:is(.is-compact, .is-thinking, .is-collapsed) .composer-video-chip,
#composer:is(.is-compact, .is-thinking, .is-collapsed) .composer-image-chip {
  display: none;
}
```

- [ ] **Step 4: Wire `main.ts`**

- 补 import：`defaultImageModelOptions`、`mergeImageOptions`、`imageOptionsSummary`、`DEFAULT_IMAGE_PRESET`、`inferImagePresetFromModel`、`IMAGE_*_OPTIONS`、`type ImageModelOptions` 等。
- DOM refs：`composerImageChip`、`composerImageSummary`、`composerImagePop`。
- 状态：`imageTurnOverride`、`imagePopOpen`。
- `activeImageModelOptions()`：和 `activeVideoModelOptions` 同形，返回 `entry.image ?? defaultImageModelOptions(entry.imagePreset ?? inferImagePresetFromModel(entry.model) ?? DEFAULT_IMAGE_PRESET)`。
- `effectiveImageTurn(base)`：`mergeImageOptions(base, imageTurnOverride)`。
- `syncComposerImageChip()`：只在 `activeComposerKind === "image"` 显示；没有模型时写「未配置生图模型」；否则摘要 `imageOptionsSummary(eff)`。
- `paintImagePop(base)`：把 `paintVideoPop` 里的 `addSelect` 抽成模块级 `addComposerSelect(labelText, value, options, onChange, labels?)`，视频和生图共用。生图加尺寸、画幅、格式、背景、水印（开/关）、提示词优化（`base.promptModes.length > 1` 时才加）；背景选 `transparent` 时把格式覆盖为 `png`、格式下拉只列 `png` 并重画；底部「恢复模型默认」清空覆盖。
- `closeImagePop()`；摘要按钮切换弹层；document click 同时处理两个弹层。
- `paintComposerKindTabs()` 调 `syncComposerImageChip()`。
- `setActiveComposerKind`：`next !== "image"` 时清空 `imageTurnOverride` 并 `closeImagePop()`。
- 新建会话时同样清空。
- 提交时：
  ```ts
  const turnOptions =
    activeComposerKind === "video"
      ? ...
      : activeComposerKind === "image"
        ? await (async () => {
            const base = await activeImageModelOptions();
            if (!base) return undefined;
            const eff = effectiveImageTurn(base);
            return {
              image: {
                size: eff.size,
                ratio: eff.ratio,
                format: eff.format,
                background: eff.background,
                watermark: eff.watermark,
                promptMode: eff.promptMode,
              },
            };
          })()
        : undefined;
  ```
- `window.agent.submit` / `replay` 的本地类型里把 `options` 改成 `{ video?: Partial<VideoModelOptions>; image?: Partial<ImageModelOptions> }`。

- [ ] **Step 5: Run build, script, and smoke**

Run: `npm run build` 然后 `npm run smoke -w @agent/app`
Expected: PASS。

- [ ] **Step 6: Manual check**

Run: `npm start`，新建会话，切到「生图」标签：确认摘要芯片出现、点开有六项（pro 才有提示词优化）、改参数后摘要跟着变、生成后图片按所选尺寸/格式保存；切到 Chat 后芯片消失，切回来参数还在。

- [ ] **Step 7: Commit**

```powershell
git add packages/app/src/renderer/index.html packages/app/src/renderer/styles.css packages/app/src/renderer/main.ts packages/app/scripts/test-image-model-form.mjs
git commit -m "Add per-turn image parameters to the composer." -m "The image tab gets the same chip and popover as video, with model defaults, per-turn overrides, a reset button, and transparent-background PNG coupling."
```

---

### Task 8: 文档与全量验证

**Files:**
- Modify: `README.md`
- Modify: `docs/ui-behavior.md`
- Modify: `docs/architecture.md`
- Modify: `docs/data-model.md`
- Modify: `docs/roadmap.md`
- Test: full suite

**Interfaces:**
- Consumes: 前七个任务的实现。
- Produces: 文档与代码一致。

- [ ] **Step 1: Update `README.md`**

- 模型条目的「生图」说明补：三个型号 Tab、尺寸档位 + 画幅、格式、背景、水印、提示词优化、Model 可填 `ep-...`。
- 配置说明补 `StoredModel` 的 `imagePreset` / `image` / `imageByModel`，写清默认值和 `transparent` 需要 `png`。

- [ ] **Step 2: Update `docs/ui-behavior.md`**

- 模型页一节补生图 Tab 和参数组、透明背景规则、列表摘要。
- 「图片与视频」一节补 composer 生图芯片和本轮覆盖。

- [ ] **Step 3: Update `docs/architecture.md`**

生图分流一段补请求字段：`size`、`output_format`、`background`、`watermark`，5.0-pro 的 `optimize_prompt_options.mode`，以及本轮覆盖的来源。

- [ ] **Step 4: Update `docs/data-model.md`**

补 `StoredModel.imagePreset` / `image` / `imageByModel`，以及生图请求参数和 `output_format` 的 MIME 规则。

- [ ] **Step 5: Update `docs/roadmap.md`**

把「后续可补：生图参数芯片」改成已落地，并指向本规格。

- [ ] **Step 6: Run the full verification**

Run:

```powershell
npm test
npm run build
npm run smoke -w @agent/app
```

Expected: 全部 PASS。`docs.test.ts` 的链接和配置表检查也要通过。

- [ ] **Step 7: Commit**

```powershell
git add README.md docs/ui-behavior.md docs/architecture.md docs/data-model.md docs/roadmap.md
git commit -m "Document Seedream image options." -m "The models page, composer chip, request fields, config keys, and roadmap match the implemented behavior."
```

---

## Self-Review

- **Spec coverage:** 生图型号目录（Task 1）、配置读写与旧配置兼容（Task 2）、请求体/尺寸映射/MIME（Task 3）、运行时合并与本轮覆盖（Task 4）、渲染进程镜像（Task 5）、模型页（Task 6）、composer（Task 7）、文档（Task 8）。规格里的非目标没有对应任务，这是有意的。
- **类型一致性:** `ImageModelOptions`、`ImagePresetId`、`mergeImageOptions`、`normalizeImageByModel`、`imageOptionsSummary` 在 core 与 renderer 同名同形；`ImageGenRequest` 的 `outputFormat` / `promptMode` 与 runtime 传参一致。
- **Review Focus:** 五个风险点分别在 Task 2（旧配置、Endpoint ID）、Task 1 + Task 4（透明背景）、Task 4（非法覆盖）、Task 3（JPEG MIME）有测试；5.5 / 5.0-flash 不发 `optimize_prompt_options` 在 Task 1 + Task 4 有测试。
- **比例:** 计划按任务给出测试和签名，没有把完整实现写成代码；UI 任务保留两个手动检查步骤。
