# Composer 品类一级

日期：2026-11-23

> **状态：已落地。** 现行行为以 [界面行为](../../ui-behavior.md)、[数据模型](../../data-model.md)、[生视频用法要点](../../video-generation.md) 与代码为准。

## 问题

品类绑在「当前模型」上：模型框小、易残留上次的生视频/生图，用户按 Chat 心智发送后只能取消。品类必须显式、难忽略。

## 已定行为

### 品类（一级）

Composer 上固定四个互斥选项（文案 / 存储）：

| 界面 | 存储 `composerKind` |
| --- | --- |
| Chat | `text` |
| 生图 | `image` |
| 合成语音 | `tts` |
| 生视频 | `video` |

- 缺省 / 非法值 → `text`。
- **新建会话**时把 `composerKind` 置为 `text`（各品类上次选用的模型 id 仍保留）。
- 切换品类不清空草稿正文与附件；附件上限与校验按新品类执行。
- **不**把语音识别、网搜放进这四个：ASR 仍是麦克风旁路（`currentAsrModelId`），网搜仍是 `currentSearchModelId`。

### 模型（二级）

- 模型下拉**只列出当前品类**的模型；无该类模型时显示「未配置模型」，点开模型页。
- 配置增加 `currentModelByKind?: { text?; image?; tts?; video? }`；切换品类时把 `currentModelId` 设为该品类记忆的 id（无效则该类第一条）。
- 在下拉里改模型：更新 `currentModelId` 与 `currentModelByKind[composerKind]`。
- 模型页对生文/生图/TTS/生视频点「使用」：同时把 `composerKind` 切到该类型并选用该条。ASR/网搜「使用」规则不变（旁路，不改 `composerKind`）。

### 发送反馈

| 品类 | 主按钮 aria / 可访问名 | placeholder 方向 |
| --- | --- | --- |
| Chat | 发送 | 向…发送消息 |
| 生图 | 生成图片 | 描述要生成的图片 |
| 合成语音 | 合成语音 | 输入要朗读的文本 |
| 生视频 | 生成视频 | 描述要生成的视频 |

品类在主 composer **左侧竖栏**（与整张圆角卡等高）：展开时四格自上而下；收起 / compact / thinking 时只露当前品类一格，点该格先展开。短标签 `Chat` / `图` / `语音` / `视频`，全称放在 `title` / `aria-label`。外观要能一眼看出当前品类（不仅靠模型名里的类型后缀）。

### 生视频子模式（品类内）

- 默认：按附件**推断**模式（可改）：0 图无视无音 → `text`；1 图 → `first_frame`；2 图且无视无音 → `first_last`；有视频、≥3 图、或有音频 → `reference`。仅 1 图也可被用户改成 `last_frame`。
- Composer 底栏与模型选择器**同一行**显示**摘要芯片**（模式 · 分辨率 · 时长 · 画幅 · 附件计数，过长省略）；点击打开 popover 做**本轮覆盖**（不写回模型页默认，除非提供「存为默认」——第一版可不做存为默认）。
- 本轮覆盖经 submit 传入 runtime，优先于模型条目上的 `video.mode` 等默认值。
- 分辨率 / 时长 / 画幅选项仍受该视频模型启用集约束；Lite 参考模式禁用 `adaptive`。

### 持久化与上下文组装

- 四个品类共用同一会话：`messages.jsonl` 按时间一条时间线，不按 Tab 拆文件。
- **Chat**：组装时带上全部历史；图/视/音在 outbound 上换成路径说明（最新一条用户图/视可例外 inline）；音频永不 inline。
- **生图 / 生视频 / TTS**：上游为单次生成 API，请求体只需本轮提示词与本轮附件；不把同 kind 的历史轮次当作 chat history 发给生成接口（界面与 `messages.jsonl` 仍保留那些轮次）。
- 生图管线不会先用纯文本澄清再画；要澄清须走 Chat 或另做确认交互。

### 明确不做

- 不根据提示词自动跨品类切换。
- 不做「生成计划确认卡」扣费前预览（可后续）。
- 解释栏仍为生文专用，不加品类 Tab。

## 配置字段

- `composerKind?: "text" | "image" | "tts" | "video"`
- `currentModelByKind?: Partial<Record<"text" | "image" | "tts" | "video", string>>`
- 保留 `currentModelId`：始终等于当前品类正在用的那一条（与 runtime / 旧读者兼容）。

## 验收

1. 当前为生视频时切到 Chat，发送走生文模型；新建会话品类回到 Chat。
2. 品类下无模型时不能误用其它品类模型发送。
3. 生视频：附图 1 张时摘要为首帧（或可改）；带参考视频时为参考素材；发送请求体 role 正确。
4. 文档：`ui-behavior.md`、`video-generation.md`、README 配置表与 `StoredConfig` 字段一致。
