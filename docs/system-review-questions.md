# 系统通读题单

22 道题，按「骨架 → 机制 → 扩展 → 工程」排列。每题给出要覆盖的概念和答案线索：先读对应文档，再回到代码确认，最后能不看文档口述两分钟，才算过。题目里的「线索」都指向仓库现有文件，不要求额外资料。

用法：读一遍 [README](../README.md) 和 [架构与运行机制](architecture.md)，然后逐题打勾。答题顺序建议 1 → 2 → 3 → 5 → 7 → 8 打底，再 4、6、9–11，然后 12–16，最后 17–22。

## 一、骨架：进程与数据

- [ ] **1. 这个系统有几条不可动摇的不变量？分别靠什么机制保证，破了会怎样？**
  - 覆盖点：渲染进程无 Node、core 不依赖 Electron、一个 runtime 同时只跑一轮、磁盘对话只追加、一轮内不换模型配置、MCP 连接池进程内一份。
  - 线索：[架构与运行机制](architecture.md)「不变量」；`packages/app/electron/main.ts`（窗口配置）；`packages/core/src/runtime/sessionRuntimePool.ts`。

- [ ] **2. 一次发送从按下发送键到 `done`，经历了哪些对象和边界？**
  - 覆盖点：`submit` → 主进程 → `SessionRuntimePool`（上限 5）→ `AgentRuntime` → `OpenAICompatibleProvider`；`agent:event` 如何回到界面；换模型时比较的 11 个字段；为什么「改配置」的生效方式是换对象而不是改字段。
  - 线索：[架构与运行机制](architecture.md)「一轮提问怎么走」「Runtime 的生命周期」；`packages/core/src/runtime/agentRuntime.ts`。

- [ ] **3. 为什么一个会话要写三份日志？它们分别回答什么问题、如何互指？**
  - 覆盖点：`messages.jsonl`（模型的工作记忆）、`trace.jsonl`（审计）、`context.jsonl`（某次请求的真面目）；id 前缀与 `trace_id`、`request_id`、`context_id` 的关系；为什么裁剪只在发出去的副本上做；为什么不做按轮摘要。
  - 线索：[数据模型](data-model.md)「三份日志」「标识与关系」。

- [ ] **4. 配置和会话分别落盘在哪？agent home 的哈希隔离、认领和损坏处理怎么工作？**
  - 覆盖点：`LONG_TASK_AGENT_HOME` → `<仓库路径哈希>/` 的解析顺序；`.legacy-claim` 迁移；`config.json.bak`、`.broken-<时间>`、chmod 0600/0700；为什么密钥不进项目目录；`.agent/` 的目录结构。
  - 线索：[数据模型](data-model.md)「落盘位置」「配置」；`packages/core/src/config/agentHome.ts`、`loadConfig.ts`。

## 二、一轮循环与上下文

- [ ] **5. 一轮 ReAct 循环的完整状态机是什么？`maxSteps` 到底数什么？**
  - 覆盖点：`turn_start` → 组装 → 流式请求 → 工具批执行 → 排空完成通知 → `done`；默认 50 步意味着「第 51 批被跳过」；三次 `web_search` 只算一步；续跑轮和暂存（held）用户消息排在什么位置；自动标题第几轮触发、什么条件下不触发。
  - 线索：[架构与运行机制](architecture.md)「一轮提问怎么走」第 4–8 步；`packages/core/src/session/autoTitle.ts`。

- [ ] **6. 一批工具调用里，哪些能并发、哪些必须串行？为什么？**
  - 覆盖点：`ask_user` 之前的 `subagent` 用 `Promise.all`；相邻只读调用（哪些算只读）可并发；任务工具和 MCP 工具不并发；重复只读调用抑制（「中间没有别的调用、用户轮之间不延续」是什么意思）。
  - 线索：[架构与运行机制](architecture.md)「一轮提问怎么走」第 5 步；`packages/core/src/tools/policy.ts`。

- [ ] **7. 一次请求的上下文是怎么装出来的？超预算时先丢什么、保什么？**
  - 覆盖点：system → 指令与记忆 → 技能目录 → 本轮技能正文 → 任务/批量提醒 → 历史 → 最后一条 → 补齐 → 媒体 → `tools` 的十段顺序；`contextCharLimit` 只是历史预算不是硬上限；短桩规则、受保护结果、预算公式（含 −100）；图片/视频「只有最后一条用户消息 inline」。
  - 线索：[架构与运行机制](architecture.md)「上下文怎么装」；`packages/core/src/context/assemble.ts`、`compress.ts`、`repairToolCalls.ts`。

- [ ] **8. 停止、出错、重启：三条失败路径各自做什么？**
  - 覆盖点：停止时挂起权限按拒绝、`taskkill /T /F`、合成结果收口、只影响本条会话；`llm_error` 不自动重试；工具错误变成 `is_error` 结果继续；重启后哪些状态还在、`deferred` 子代理怎么处理。
  - 线索：[架构与运行机制](architecture.md)「停止」「出错与恢复」。

## 三、工具与授权

- [ ] **9. 工具分几级？`classifyToolCall`、`PermissionGate`、`AskGate` 的职责边界是什么？**
  - 覆盖点：allow / ask 等分级语义；为什么把门做成接口（Electron 里是 `Deferred*`，测试里是 `AutoAllow*`）；权限卡的 `request_id` 和 trace 里的 `request_id` 为什么不是一回事。
  - 线索：[工具与权限](tools-and-permissions.md)「分级与许可门」；`packages/core/src/runtime/permission.ts`、`askGate.ts`、`tools/policy.ts`。

- [ ] **10. shell 命令怎么被分级？路径沙箱的边界在哪？安全模型哪些是「已知不做」的？**
  - 覆盖点：命令分级的判定输入；文件工具只能在工作区内、`write_file` 拒绝已存在的符号链接；写类工具不碰 `.agent`；硬链接仍是已知缺口。
  - 线索：[工具与权限](tools-and-permissions.md)「Shell 命令怎么分级」「文件工具的路径沙箱」「安全模型与已知边界」；`packages/core/src/tools/fsSandbox.ts`、`bash.ts`、`dangerous.ts`。

- [ ] **11. 工具输出会在哪几个环节被截断？上限分别是多少、发生在写盘前还是写盘后？**
  - 覆盖点：`maxReadChars`（默认 5 万）与 `maxToolOutputChars`（默认 2 万）；子代理回执 6000 字；截断发生在写入会话之前，和上下文预算丢弃是两个层次。
  - 线索：[架构与运行机制](architecture.md)「上下文怎么装」末尾；`packages/core/src/tools/host.ts`。

## 四、子代理与任务

- [ ] **12. `explore` 和 `worker` 子代理有什么区别？`joined` 和 `deferred` 又是什么？**
  - 覆盖点：权限确认差异；回执只给父会话一条；`output_dir` 锁只存在内存里；为什么子代理落盘在会话目录里而不是另开会话。
  - 线索：[子代理、任务清单与完成通知](subagents-and-tasks.md)「子代理」「交付」「并发与 output_dir 锁」；`packages/core/src/runtime/subagentRun.ts`。

- [ ] **13. 任务清单为什么放在会话里？完成通知队列怎么把「后台完成」变成「续跑轮」？**
  - 覆盖点：状态与依赖、十进制编号不复用、`.highwatermark`；任务提醒的 10 次间隔与批量提醒的 4 次规则；`inbox.jsonl` 的格式与排空时机；`note_<子代理 id>` 的幂等性；续跑期间用户消息被暂存的顺序。
  - 线索：[子代理、任务清单与完成通知](subagents-and-tasks.md)「任务清单」「完成通知」；`packages/core/src/store/taskStore.ts`、`inboxStore.ts`；`packages/core/src/context/taskReminder.ts`、`batchReminder.ts`。

## 五、模型与生成管线

- [ ] **14. 模型 kind、composer 品类、各种「当前」指针是什么关系？**
  - 覆盖点：六种 kind 与四个品类；`composerKind`、`currentModelByKind`、`currentModelId`、`currentSearchModelId`、`currentAsrModelId`、`currentExplainModelId` 各自的作用域；网搜和 ASR 为什么是旁路；解释栏为什么只认生文模型。
  - 线索：[README](../README.md)「配置」；`packages/app/src/renderer/models.ts`；`packages/core/src/config/composerKind.ts`、`modelKind.ts`。

- [ ] **15. 生图请求的参数是怎么合并出来的？透明背景为什么有额外约束？**
  - 覆盖点：模型条目默认值 → 本轮 composer 覆盖；透明背景强制 PNG 且只在恰好 1 张参考图时发送，否则回退非透明默认；尺寸档位与 `宽x高`；响应 MIME 的五级判定；校验失败为什么不写 `context.jsonl`。
  - 线索：[架构与运行机制](architecture.md)「一轮提问怎么走」生图分支；[数据模型](data-model.md) 生图段落；`packages/core/src/config/imageOptions.ts`；`packages/core/src/provider/imageGeneration.ts`；`packages/app/src/renderer/imageModelForm.ts`。

- [ ] **16. 生视频的「型号 × 素材模式 × 附件」约束是什么？TTS/ASR 又为什么绕过工具循环？**
  - 覆盖点：五种素材模式的附件数量规则（含参考素材图 ≤9、视频 ≤3、音频 ≤3、合计 ≤12、不能只附音频）；首帧/尾帧画幅用 `adaptive`、Lite 禁止 `adaptive`；派欧云 URL 拼接（去尾斜杠、可选 `/v1`、走 `/v3/minimax/v2/...`）与异步轮询；TTS/ASR 忽略方舟 Base URL 改打 openspeech；音频落在 `audios/`。
  - 线索：[架构与运行机制](architecture.md) 生视频与语音分支；[生视频用法要点](video-generation.md)；`packages/core/src/config/videoOptions.ts`、`provider/videoGeneration.ts`、`provider/volcSpeech.ts`；`packages/app/src/renderer/videoModelForm.ts`。

## 六、扩展与集成

- [ ] **17. MCP 为什么是「一份连接池、按轮快照」？两种传输、命名和打码怎么处理？**
  - 覆盖点：五个 runtime 共用一个池；每轮开始时把工具定义拍进这一轮，子代理和解释栏不拿；stdio 与 Streamable HTTP；工具名前缀与密钥打码；按次确认与配置（`mcp-servers.json`）。
  - 线索：[MCP](mcp.md)；`packages/core/src/mcp/pool.ts`、`names.ts`、`redact.ts`；`packages/app/electron/mcpIpc.ts`。

- [ ] **18. 技能和记忆分别如何进入上下文？为什么主会话不能写记忆？**
  - 覆盖点：`SKILL.md` 格式、安装目录与停用名单、`/技能名` 注入与 8000 字截断、`read_skill`、技能脚本；记忆四类与两级 `AGENTS.md`；`user`/`feedback` 带正文、`project`/`reference` 只带一行；6000 字预算；后台提取固定走生文模型的回退链；`memory_read` 为什么只给子代理；提取游标 `memory-cursor.json`。
  - 线索：[技能](skills.md)、[记忆](memory.md)；`packages/core/src/skills/prompt.ts`、`memory/prompt.ts`、`extract.ts`；`packages/app/electron/memoryIpc.ts`。

- [ ] **19. 工作台浏览器如何做到「网页碰不到应用」？标签怎么持久化、什么时候才加载？**
  - 覆盖点：`WebContentsView` + `sandbox` + 无 preload；DeepSeek 独立分区及其动机；只加载 http/https、新窗口变新标签、权限白名单；`browser-tabs.json` 防抖写入、重启后懒加载；全屏时 `layout()` 的特殊处理；浏览器页借用解释栏时为什么用 `browser:explain` 这对固定标识、记录存哪。
  - 线索：[架构与运行机制](architecture.md) 模块地图 `browserTabs.ts` 段；`packages/app/electron/browserTabs.ts`、`browserPolicy.ts`、`browserTabsStore.ts`；`packages/app/src/renderer/browserView.ts`、`browserExplain.ts`、`explainDrag.ts`。

## 七、界面与工程

- [ ] **20. 渲染层「谁负责什么」？三个纯函数模块解决了什么难题？**
  - 覆盖点：`main.ts` 决定页面和轮次归属、`ui.ts` 只画 DOM、其余模块不持有会话；`runEventGate`（事件属于哪一轮/哪条会话）、`escapeKey`（Esc 的优先级）、`composerCollapse`（收起/展开规则）；它们有独立测试脚本的意义。
  - 线索：[架构与运行机制](architecture.md) 渲染层分工；`packages/app/src/renderer/runEventGate.ts`、`escapeKey.ts`、`composerCollapse.ts`；`packages/app/scripts/test-run-event-gate.mjs` 等。

- [ ] **21. 消息区与模型页的关键交互规则是什么？**
  - 覆盖点：长消息折叠、只看用户问题、问题轨（刻度、截断、跳转）、查找跳过隐藏文字；模型页 Tab 归属与「打开时停在输入框当前品类」；当前/使用按钮与悬停操作（复制、修改、移除）的单行显示与不遮挡摘要；列表摘要内容（各 kind）与密钥掩码。
  - 线索：[界面行为](ui-behavior.md)；`packages/app/src/renderer/messageCollapse.ts`、`questionsOnly.ts`、`questionNav.ts`、`models.ts`。

- [ ] **22. 构建和测试是怎么分层的？为什么 preload 必须是 CJS？这套分层能挡住什么、挡不住什么？**
  - 覆盖点：core 与 app 两个 tsconfig；`copy-static.mjs` 把 html/css 复制进 dist 并把 `preload.js` 拷成 `.cjs`（`"type": "module"` 的约束）；core 用 vitest，渲染层用 node 断言脚本 + `smoke-main.mjs` 串联，evals 放长任务评测；`docs.test.ts` 这类「文档即测试」的约定；这套体系覆盖不到真实 GUI 渲染的事实。
  - 线索：[README](../README.md)「开发」「测试」；`packages/app/scripts/smoke-main.mjs`、`copy-static.mjs`；`packages/core/tests/docs.test.ts`。