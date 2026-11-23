# Seedream 生图模型配置与运行参数

日期：2026-11-24

状态：待实现

## 为什么

模型页目前对「生图」类型只保存显示名、Base URL、Model 和 API Key，生图请求也只发 `model`、`prompt` 和可选参考图。用户无法按型号配置尺寸、画幅、输出格式、背景、水印和提示词优化；composer 生图标签也没有本轮参数入口。

现在只有三个可用型号：Doubao-Seedream-5.0-pro、Doubao-Seedream-5.5、Doubao-Seedream-5.0-flash。它们的默认值和可用参数不同，需要像生视频一样在模型页按型号各存一套参数，并让运行时和 composer 真正使用。

## 目标

1. 模型页选中「生图」时，按三个型号 Tab 配置各自的参数；保存 `imagePreset`、`image` 和 `imageByModel`。
2. Model 字段保留，切换 Tab 时自动填入该型号的官方 ID，用户可改成 `ep-...` Endpoint ID 或新版本号。
3. 生图请求按配置带上 `size`、`output_format`、`background`、`watermark`；5.0-pro 另带 `optimize_prompt_options.mode`。
4. composer 生图标签出现和生视频同位置、同样式的摘要芯片和本轮参数弹层。
5. 修复按 `output_format` 保存 JPEG 时 MIME 被当成 PNG 的问题。

## 非目标

- 不做组图/一次多张。三个型号都不支持 `sequential_image_generation`；App 层并发多次请求也不在本次范围。
- 不做图层拆分（`layer_decomposition`）。
- 不暴露 `safety_identifier`、`response_format`。
- 不改变参考图上限。composer 生图仍最多 4 张；Ark 型号支持 10 张，后续再调。
- 不改 `ImageGenResult` 的单图结构。
- 不新增生图专用 Base URL 字段；仍用模型条目的 `baseUrl`。

## 约束

- 三个型号一次请求只出一张图，没有 `n` 参数。
- `size` 只接受 `1K` / `1.5K` / `2K`，或 `宽x高`（小写 `x`）。两种写法不能混用。像素方式总像素 921600–4624220，宽高比 1/16–16。
- `output_format` 默认：5.0-pro `jpeg`、5.5 `png`、5.0-flash `jpeg`。
- `background` 可选值：5.0-pro / 5.0-flash 为 `opaque`、`transparent`；5.5 另有 `auto`。默认：5.5 `auto`，另外两个 `opaque`。
- `optimize_prompt_options.mode`：5.0-pro 支持 `standard` / `fast`；5.5 和 5.0-flash 仅 `standard`。
- `watermark` 默认 `true`。
- 透明背景要求 `png`；`jpeg` 与 `transparent` 同时使用会报错。只要启用 `transparent`，就必须同时启用 `png`，否则 composer 切到透明背景时没有合法的格式可选。
- 官方模型 ID（2026-11-24）：
  - `doubao-seedream-5-0-pro-260628`
  - `doubao-seedream-5-5-261028`
  - `doubao-seedream-5-0-flash-260915`
- 渲染进程不能 import core；参数目录和归一化需要在 core 与 renderer 各放一份，和 `videoOptions.ts` / `videoModelForm.ts` 一样保持同步。

## 方案选择

### 型号与 Model 字段

- **A（落选）**：完全照生视频，隐藏 Model 输入，三个 Tab 内置官方 ID。界面最一致，但 Ark 的 Endpoint ID（`ep-...`）和带日期后缀的新版本号用不了，升级型号要改代码。
- **B（选用）**：Tab 决定参数组和默认模型 ID，Model 输入保留。切换 Tab 时自动填入该型号官方 ID，用户可改成 `ep-...` 或新版本。参数能力仍由 Tab 决定。

选 B 的理由：Ark 实际使用中 Endpoint ID 和版本号会变，隐藏 Model 会把用户锁死在代码里的 ID 上。

### 尺寸控制

- **A（落选）**：只给 `1K` / `1.5K` / `2K` 三档，直接作为 `size` 发送。画幅只能靠提示词。
- **B（选用）**：档位 + 画幅。选「自动」时只发档位；选具体画幅时映射成 `宽x高`。

选 B 的理由：和生视频的「分辨率 + 画幅」对应；不选画幅时保持接口的档位默认行为，选了就得到确定的输出尺寸。

## 型号目录

三个型号共用：

- 尺寸：`1K`、`1.5K`、`2K`，默认 `2K`
- 画幅：`自动`、`1:1`、`4:3`、`3:4`、`16:9`、`9:16`，默认 `自动`
- 参考图：最多 10 张（App 当前上限 4）
- 水印：默认开

差异：

| preset id | Tab 文案 | 官方 ID | 输出格式（默认） | 背景（默认） | 提示词优化（默认） | 图层拆分上限 |
| --- | --- | --- | --- | --- | --- | --- |
| `Doubao-Seedream-5.0-pro` | `5.0-pro` | `doubao-seedream-5-0-pro-260628` | png / jpeg（jpeg） | opaque / transparent（opaque） | standard / fast（standard） | 16 |
| `Doubao-Seedream-5.5` | `5.5` | `doubao-seedream-5-5-261028` | png / jpeg（png） | auto / opaque / transparent（auto） | standard（standard） | 99 |
| `Doubao-Seedream-5.0-flash` | `5.0-flash` | `doubao-seedream-5-0-flash-260915` | png / jpeg（jpeg） | opaque / transparent（opaque） | standard（standard） | 16 |

每个 Tab 的说明文案只写定位和能力，不写价格：

- 5.0-pro：旗舰画质，支持 fast 提示词优化；最多 10 张参考图，图层拆分最多 16 层。
- 5.5：最新一代，默认 PNG 和自动背景；最多 10 张参考图，图层拆分最多 99 层。
- 5.0-flash：速度优先，提示词优化仅 standard；最多 10 张参考图，图层拆分最多 16 层。

## 配置数据

在 `packages/core/src/config/types.ts` 增加：

```ts
export type ImagePresetId =
  | "Doubao-Seedream-5.0-pro"
  | "Doubao-Seedream-5.5"
  | "Doubao-Seedream-5.0-flash";

export interface ImageModelOptions {
  sizes: ImageSizeTier[];
  size: ImageSizeTier;
  ratios: ImageRatio[];
  ratio: ImageRatio;
  formats: ImageOutputFormat[];
  format: ImageOutputFormat;
  backgrounds: ImageBackground[];
  background: ImageBackground;
  watermark: boolean;
  promptModes: ImagePromptMode[];
  promptMode: ImagePromptMode;
}

export interface StoredModel {
  // 现有字段不变
  imagePreset?: ImagePresetId;
  image?: ImageModelOptions;
  imageByModel?: Record<ImagePresetId, ImageModelOptions>;
}

export interface AgentConfig {
  // 现有字段不变
  image?: ImageModelOptions;
}

export type TurnSubmitOptions = {
  video?: Partial<Pick<VideoModelOptions, "mode" | "resolution" | "duration" | "ratio">>;
  image?: Partial<
    Pick<ImageModelOptions, "size" | "ratio" | "format" | "background" | "watermark" | "promptMode">
  >;
};
```

类型取值：

```ts
type ImageSizeTier = "1K" | "1.5K" | "2K";
type ImageRatio = "auto" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
type ImageOutputFormat = "png" | "jpeg";
type ImageBackground = "opaque" | "transparent" | "auto";
type ImagePromptMode = "standard" | "fast";
```

新增 `packages/core/src/config/imageOptions.ts`，提供：

- `IMAGE_MODEL_PRESETS`：三个型号的目录，含 `id`、`label`、`defaultModel`、`blurb`、`sizes`、`ratios`、`formats`、`defaultFormat`、`backgrounds`、`defaultBackground`、`promptModes`、`defaultPromptMode`。
- `ImageByModel`、`defaultImageModelOptions(preset)`、`defaultImageByModel()`。
- `normalizeImageModelOptions(preset, raw)`：过滤非法值，至少保留一项；默认单选值必须落在启用集合里。
- `normalizeImageByModel(activePreset, imageByModelRaw, activeImage?)`：合并存储的每组参数和旧单组参数。
- `readImageModelOptions(preset, raw)`、`imagePresetOf(modelOrPreset)`、`inferImagePresetFromModel(model)`、`imageOptionsSummary(options)`。

### 向后兼容

- 已有 `kind: "image"` 的模型，没有 `imagePreset` / `image` / `imageByModel` 时，按模型名推断 preset（`doubao-seedream-5.0-pro...`、`5-5`、`5-0-flash`）；推断不出时用 5.0-pro。Model 字段保持用户原来的值，不覆盖。
- `cleanModel` 在读取时补上归一化后的 `imagePreset`、`image`、`imageByModel`；`toAgentConfig` 在运行时也能回退到 `defaultImageModelOptions(model)`，所以不必先打开模型页保存一次。
- `duplicateModel` 用对象展开复制，`imagePreset` / `image` / `imageByModel` 自动带上。

## 模型页

选中类型「生图」时：

```text
类型：生图
[ 5.0-pro ][ 5.5 ][ 5.0-flash ]
旗舰画质，支持 fast 提示词优化…
Model  [doubao-seedream-5-0-pro-260628]   ← 切 Tab 自动填，可改
尺寸   ☑1K ☑1.5K ☑2K                     默认 ●2K
画幅   ☑自动 ☑1:1 ☑4:3 ☑3:4 ☑16:9 ☑9:16   默认 ●自动
格式   ☑png ☑jpeg                        默认 ●jpeg
背景   ☑opaque ☑transparent               默认 ●opaque
水印   ☑ 默认加水印
提示词优化 ☑standard ☑fast                 默认 ●standard
```

行为：

- 类型切换时显示生图块，隐藏生视频、语音块。Model 输入保持可见（和生视频不同）。
- Base URL 旁增加提示：`https://ark.cn-beijing.volces.com/api/v3`。Base URL 为空时自动填入该地址，用户可改。
- Tab 从 `imagePreset` 决定；没有时按 Model 名推断；再没有用 5.0-pro。
- 切换 Tab：先暂存当前 Tab 的参数组和 Model 输入值，再画新 Tab 的说明和参数，并把 Model 输入换成该 Tab 记住的值（默认官方 ID）。当前会话内切回来时保留用户改过的 Model 值；未激活 Tab 的值只在本次表单会话内存里保留。
- 每组参数仍用「方框启用、圆点设默认」；提示词优化只在 5.0-pro 显示两组，5.5 / 5.0-flash 显示一行「该型号固定 standard」。
- 透明背景与格式联动：背景组只要启用了 `transparent`，格式组就必须启用 `png`；保存时若不满足，拒绝并提示「透明背景需要同时启用 PNG 格式」。默认背景为 `transparent` 时，默认格式必须是 `png`，否则保存时拒绝。composer 选透明背景时自动把格式切到 `png`。
- 每组参数至少保留一项：生图的启用组（尺寸、画幅、格式、背景、提示词优化）在用户尝试取消最后一项时不生效，保持勾选并提示「至少保留一项」。这样切走的 Tab 也不会留下空组；手改配置里的空组由归一化回退到默认值。
- 保存时：`model` 取当前 Model 输入；`imagePreset` 取当前 Tab；`image` 取当前 Tab 归一化后的参数；`imageByModel` 取三组参数。`kind` 仍为 `image`。
- 校验：至少启用一个尺寸、一个画幅、一种格式、一种背景；Model 和 Base URL 不能为空（沿用现有规则）。
- 列表摘要：`2K · 自动 · jpeg · 水印`；水印关时写 `无水印`；`promptMode` 为 `fast` 时追加 `fast`；`background` 为 `transparent` 时追加 `透明背景`。`opaque` / `auto` 不追加，避免依赖「型号默认背景」的定义。
- 复制、修改、移除、使用行为不变；复制会带上生图参数。

## Composer

生图标签下，和生视频芯片同位置、同样式：

```text
[图] 生图   [2K · 自动 · jpeg · 水印]  ← 点开
  尺寸     [2K v]
  画幅     [自动 v]
  格式     [jpeg v]
  背景     [opaque v]
  水印     [开 v]
  提示词优化 [standard v]        ← 仅 5.0-pro 出现
  [恢复模型默认]
```

行为：

- 芯片只在 `activeComposerKind === "image"` 时显示；没有当前生图模型时显示「未配置生图模型」，点开不弹参数。
- 摘要取生效值，顺序为尺寸、画幅、格式、水印；背景不是默认值时追加。
- 弹层选项只列模型页启用过的值。提示词优化只有 `base.promptModes` 多于一项时才显示。
- 选择只写本轮覆盖 `imageTurnOverride`，不改配置；值必须落在该模型启用集合里，否则忽略并回到默认。
- 选择 `transparent` 时，格式自动切到 `png`，格式下拉只留 `png`，直到背景改回非透明。模型页保证启用透明背景时 `png` 一定在格式启用集合里，所以这个覆盖值不会越界。
- 「恢复模型默认」清空本轮覆盖。
- 离开生图标签、新建会话时清空本轮覆盖并关闭弹层；同一标签内连续发送保留上次选择（和生视频一致）。
- 发送时把生效参数放进 `options.image`，随 `submit` 传给主进程。
- 当前模型不是生图或没有配置时，保持现有拦截和提示。

## 运行时

`normalizeTurnOptions` 解析 `options.image`，和 `video` 一起返回；`effectiveImageOptions()` 用模型配置做底，合并本轮覆盖，并逐项校验是否在启用集合里。若合并后 `background === "transparent"`，强制 `format = "png"`，作为手改配置的兜底。

生图分流在调用 `provider.generateImage` 时传：

```ts
{
  model: this.config.model,
  prompt,
  images: refImages,          // 有参考图时
  size: resolveImageSize(eff), // "1K" / "1.5K" / "2K" / "2560x1440"
  outputFormat: eff.format,
  background: eff.background,
  watermark: eff.watermark,
  promptMode: eff.promptModes.includes("fast") ? eff.promptMode : undefined,
  signal: this.abort?.signal,
}
```

### 尺寸映射

`resolveImageSize(options)` 放在 `packages/core/src/provider/imageGeneration.ts`：

| 档位 | 自动 | 1:1 | 4:3 | 3:4 | 16:9 | 9:16 |
| --- | --- | --- | --- | --- | --- | --- |
| 1K | `1K` | 1024x1024 | 1152x864 | 864x1152 | 1280x720 | 720x1280 |
| 1.5K | `1.5K` | 1536x1536 | 1728x1296 | 1296x1728 | 1920x1080 | 1080x1920 |
| 2K | `2K` | 2048x2048 | 2304x1728 | 1728x2304 | 2560x1440 | 1440x2560 |

全部组合的总像素在 921600–4624220 内，宽高比在 1/16–16 内。

### 请求体

`buildImageGenerationBody` 在现有 `model`、`prompt`、`image` 之外，按传入值追加：

```json
{
  "size": "2560x1440",
  "output_format": "jpeg",
  "background": "opaque",
  "watermark": true,
  "optimize_prompt_options": { "mode": "standard" }
}
```

- `optimize_prompt_options` 只在型号支持 fast（即 `promptModes` 含 `fast`）时发送，避免 5.5 / 5.0-flash 收到不支持的字段。
- 不发送 `response_format`，保持现在的「有 `b64_json` 用 `b64_json`，否则下载 `url`」行为。
- 参考图字段保持现有 `image`（单张字符串，多张数组）。

### 响应 MIME

`parseImageGenerationResponse` 的 MIME 优先级改为：

1. `data[0].mime`
2. `data[0].output_format`（`png` → `image/png`，`jpeg` → `image/jpeg`）
3. 响应 `content-type`
4. 请求的 `outputFormat`
5. `image/png`

下载 URL 的路径同样在 content-type 和扩展名都判断不出时，用请求的 `outputFormat` 兜底。这样 `output_format: "jpeg"` 不会被存成 `.png`。

### 记录

`context.jsonl` 的生图请求行保持现有结构（`kind: "image"`，消息里是提示词和参考图路径/字节数），不新增参数快照；生成的图仍写一条助手消息、`image_count: 1`、`generated_images` 事件。

## 错误处理

- 模型页保存时，某组被清空 → 报错并阻止保存（沿用生视频文案风格）。
- 启用了 `transparent` 但没有启用 `png` → 报错「透明背景需要同时启用 PNG 格式」。
- 默认背景 `transparent` 且默认格式 `jpeg` → 报错「透明背景需要选择 PNG」。
- 本轮覆盖值不在启用集合里 → 静默忽略，用模型默认。
- 接口返回错误 → 沿用现有 `HTTP <status>: <body>` 提示，不重试成其他类型。
- 模型名是未知 ID → 参数用 5.0-pro 默认值，Model 原样发送；接口不支持时直接显示接口错误。
- 用户选的 `background=transparent` 在接口侧因输入图限制失败 → 显示接口错误，前端不做额外猜测。

## 测试

core：

- 新增 `packages/core/tests/imageOptions.test.ts`：三个 preset 的默认值；启用集合过滤；空组报错；`imageByModel` 合并；旧单组参数展开；模型名推断；摘要文案（`fast`、`透明背景`）。
- 更新 `packages/core/tests/imageGeneration.test.ts`：请求体带 `size` / `output_format` / `background` / `watermark` / `optimize_prompt_options`；尺寸映射表；`output_format: jpeg` 解析成 `image/jpeg`；URL 下载的 MIME 兜底。
- 更新 `packages/core/tests/generateRuntime.test.ts`：生图轮使用模型配置；本轮覆盖生效；非法覆盖忽略；`transparent` 强制 `png`；`generateImage` 收到预期字段；仍只保存一张图。
- 更新 `packages/core/tests/loadConfig.test.ts`：生图条目归一化、旧配置兼容、`toAgentConfig` 带 `image`、复制带参数。

app：

- 新增 `packages/app/scripts/test-image-model-form.mjs`（构建后运行）：`normalizeImageModelOptions`、`normalizeImageByModel`、`imageOptionsSummary`、`resolveImageSize` 的纯函数断言。
- 现有 `npm run build` 必须通过。

## 文档

- `README.md`：生图条目说明补参数；配置表补 `imagePreset` / `image` / `imageByModel`。
- `docs/ui-behavior.md`：模型页生图 Tab、参数组、摘要；composer 生图芯片。
- `docs/architecture.md`：生图分流补请求字段和本轮覆盖。
- `docs/data-model.md`：配置字段和生图请求参数。
- `docs/roadmap.md`：把「生图参数芯片」从后续可补改成已落地。

## 留给实现者的决定

- 公共的 `paintCheckGroup` / `readCheckGroup` / `readCheckGroupDefault` / `fillSelect` 是否从 `videoModelForm.ts` 移到独立模块；两种做法都可以，只要不复制两份实现。
- 「至少保留一项」是在共享的 `paintCheckGroup` 上加可选参数，还是在生图表单里单独实现；不改生视频现有行为即可。
- 生图芯片的 CSS 是把现有 `.composer-video-*` 选择器扩展成同时覆盖 `.composer-image-*`，还是重命名为通用 `.composer-param-*`；视觉不变。
- 说明文案的最终措辞。
- 测试脚本的具体命名和是否接入 npm 脚本。
