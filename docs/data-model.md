# 数据模型

数据落在两处。用户目录里的 **agent home** 放配置、技能、MCP server 和记忆；工作区下的 `.agent/` 放会话，跟着项目走；项目级指令 `AGENTS.md` 在工作区根目录，不在 `.agent/` 里。换工作区不会串会话，密钥也不会进项目目录。用户级记忆会随着每次请求的 system 写进这个工作区的 `context.jsonl`。

agent home 默认按本机上这份代码的绝对路径分开，避免原版与克隆共用一份配置：

1. 环境变量 `LONG_TASK_AGENT_HOME`（若设置）
2. 否则 `~/.long-task-agent/<仓库路径的哈希>/`
3. 找不到桌面端仓库根时，退回 `~/.long-task-agent/`

升级后第一个启动的检出若发现旧的扁平 `config.json` 还在、且自己的 home 还空，会把旧目录复制进自己的 `<hash>/`，并留下 `~/.long-task-agent/.legacy-claim`；之后的克隆看到 claim 就从空 home 开始。旧的 `roots/<hash>/` 会在启动时抬到 `<hash>/`，顶层残留的扁平副本会清掉。

每个会话有三份日志，各回答一个问题：模型下次能看见什么（`messages.jsonl`）、发生过什么（`trace.jsonl`）、某次请求到底发了什么（`context.jsonl`）。三者用 id 互相指认。

## 落盘位置

```text
~/.long-task-agent/
  .legacy-claim                  哪一份检出认领了旧的扁平目录
  <hash>/                        这一份检出的 agent home（或 LONG_TASK_AGENT_HOME）
    home.json                    显示名（label）；正式版可留空。侧栏「设置」可改
    config.json                  模型配置、工作区列表、可选限额。先写临时文件再改名。每次保存前先复制成 config.json.bak。POSIX 上目录 0700、文件 0600
    config.json.bak              上一次成功保存前的副本
    mcp-servers.json             MCP server 清单和密钥，见 mcp.md
    skills/<name>/               已安装的技能，见 skills.md
    skills/.skill-settings.json  停用的技能名单
    AGENTS.md                    用户级指令，可选
    memory/                      记忆根目录
      user/                      用户级记忆（.md、journal、.lock）
      projects/<key>/            项目级记忆（摊平：.md、journal、lock、project.json 都在这一层）
        project.json             这个键对应的仓库根目录和创建时间
    browser-tabs.json            工作台浏览器上次的标签网址等
    browser-explain/             浏览器解释记录，不进任何工作区

{workspace}/.agent/sessions/{sessionId}/
  meta.json                      会话身份：id、工作区路径、标题、标题来源、时间
  messages.jsonl                 模型下次能看见的对话，一行一条 Message
  trace.jsonl                    审计事件，一行一条 TraceEvent
  context.jsonl                  每次模型调用实际发出的上下文
  images/                        随消息上传的图片 img_*，生图结果，以及解释侧栏里已有的 explain-img_*
  videos/                        随消息上传的视频 vid_*（mp4 / webm / mov）
  inbox.jsonl                    完成通知队列。不在对话里，排空后才写进 messages.jsonl
  tasks/                         本会话的任务清单
    {id}.json                    一个任务。编号是十进制字符串，删掉也不复用
    .highwatermark               用过的最大编号
    .lock                        修改清单时临时创建的锁文件
  subagents/{subagentId}/        一次 subagent 调用的独立落盘，不是另一个会话
    meta.json                    类型、父工具调用 id、output_dir、状态
    messages.jsonl  trace.jsonl  context.jsonl
  explain-meta.json              解释侧栏的状态
  explain-messages.jsonl  explain-trace.jsonl  explain-context.jsonl
  memory-cursor.json             后台提取处理到哪条消息
  memory-extract.jsonl           每次后台提取的请求、模型原文和判定
```

`{workspace}/AGENTS.md` 是项目级指令，可选，不在 `.agent/` 里。

`sessionId` 只能由字母、数字、下划线和连字符组成，避免拼进路径时逃出 `.agent/sessions/`。列会话只看 `sessions/` 的直接子目录，所以 `subagents/` 和 `tasks/` 不会被当成会话。

## 三份日志

| 文件 | 回答的问题 | 谁读 |
| --- | --- | --- |
| `messages.jsonl` | 模型下次能看见什么 | runtime 组上下文；界面画对话 |
| `trace.jsonl` | 发生过什么、按什么顺序、花了多久 | 审计；界面的文件页 |
| `context.jsonl` | 某次请求实际发出了什么 | 排查模型为什么这样做 |

拆成三份，是因为它们的用途不同：`messages` 是模型的工作记忆，发出前会在副本上换成短桩或整条丢掉；`trace` 记录动作本身；`context` 存下这次实际发出的样子，副本处理和磁盘原文对不上时能对回去。三份文件本身都只追加。没有按用户轮次收成的摘要。

### `messages.jsonl`

一行一条 `Message`：`id`、`session_id`、`turn_id`、`role`、`content`、`created_at`，以及按需出现的 `images`、`videos`、`name`、`tool_call_id`、`tool_calls`、`is_error`、`trace_id`、`interrupted`。

`role=tool` 的消息可以带 `tool_call_arguments`，只给界面和审计看。组装上下文时不会再发给模型，因为参数已经在配对的那条助手消息的 `tool_calls` 上。

### `trace.jsonl`

一行一条 `TraceEvent`：`id`、`session_id`、`turn_id`、`type`、`timestamp`，以及按需出现的 `message_id`、`request_id`、`token_usage`、`error`、`detail`。

主会话的事件类型有 `turn_start`、`user_message`、`llm_request`、`llm_response`、`llm_error`、`tool_call`、`tool_result`、`max_steps`、`cancel`。

各类型的具体内容放在 `detail` 里：

- `user_message` 只记字数、图片张数，以及这条消息是不是续跑期间暂存的（`held`），不记正文。
- `llm_request` 只记模型名、条数、字数、图片张数和 `context_id`。`context_id` 就是这条事件自己的 `id`，`context.jsonl` 里对应的请求行也用这个 `id`。
- `llm_response` 记助手全文和工具调用，`tool_call`、`tool_result` 记参数和完整输出。所以 trace 不只是索引，里面有正文。
- `tool_result` 的 `duration_ms` 只出现在真正执行过的调用上，不算等你点允许的时间；被拒绝和被停止的调用，分别带 `denied: true`、`cancelled: true`。

事件类型里没有单独的「许可决定」，许可结果体现在 `tool_result` 上。正常结束一轮也不写 trace，只发给界面一个 `done` 事件；到达上限和被停止各有一条 `max_steps`、`cancel`。

### `context.jsonl`

两种行：

- `{type: "tools", sha256, tools}`：一份工具定义，同一个哈希只写一次。
- `{type: "request", id, turn_id, model, tools_sha256, messages}`：一次请求。每条消息记角色、正文、`name`、`tool_call_id`、`tool_calls`；图片和视频只记路径和字节数，不存像素或视频数据。

工具定义不写进 system 正文。同一份定义按 sha256 只在 `{type: "tools"}` 行写一次，请求行用 `tools_sha256` 指向它。生图请求也写一行，带 `kind: "image"`，没有工具定义，也没有 `tools_sha256`；消息里是提示词和可选参考图的路径、字节数。空提示词或这一轮附了视频而被拒绝时，不写这一行。生视频和生音的提示回复也不写。

## 标识与关系

id 的格式是 `<前缀>_<32 位十六进制>`。前缀有 `sess`、`turn`、`msg`、`trace`、`perm`、`ask`、`subagent`、`note`、`img`、`vid`、`memj`、`memx`。`memj` 是一次记忆变更的 id，写在用户目录的 `journal.jsonl` 里；`memx` 是一次后台提取的 id，写在会话目录的 `memory-extract.jsonl` 里。两个都不出现在三份日志中。deferred 子代理的完成通知 id 是 `note_<子代理 id>`，所以同一个子代理只会入队一次。早先的子代理目录叫 `agent_…`，现在仍能读。

```mermaid
flowchart TB
  meta["SessionMeta<br/>session_id, workspace_path, title, title_source"]
  msg["Message<br/>id, turn_id, role, trace_id"]
  trace["TraceEvent<br/>id, turn_id, message_id, request_id"]
  calls["assistant.tool_calls[]"]
  toolmsg["role=tool 的 Message<br/>tool_call_id"]
  ctx["context.jsonl 请求行<br/>id"]

  meta -->|"1 对多"| msg
  meta -->|"1 对多"| trace
  msg -->|"trace_id = TraceEvent.id"| trace
  trace -->|"message_id = Message.id"| msg
  trace -->|"request_id 指回 llm_request / tool_call"| trace
  trace -->|"llm_request 的 context_id = 请求行 id"| ctx
  calls -->|"id = tool_call_id"| toolmsg
```

一条用户消息打开一个 `turn_id`。这一轮里的助手文本、工具调用和工具结果都带同一个 `turn_id`。`llm_response` 和 `llm_error` 用 `request_id` 指回对应的 `llm_request`；`tool_result` 用 `request_id` 指回它的 `tool_call`。

有几处例外：取消时写的 `llm_response` 没有 `request_id`；完成通知消息，以及一轮开头、续跑和存储失败时补齐出来的 tool 消息，没有 `trace_id`，也不写事件；自动标题那次模型调用不进 trace，也不进 context。后台提取同样不进这两份，写在会话目录自己的 `memory-extract.jsonl`。停止时补的「Cancelled」tool 消息不算例外：它们有 `trace_id`，也写 `tool_call` 和带 `cancelled: true` 的 `tool_result` 事件。

## 图片与视频

每张上传的图片最大 1,500,000 字节，每条消息最多 4 张，格式是 PNG、JPEG、WebP、GIF。主输入框上传前会重新编码：长边缩到 1600 像素，PNG 保持 PNG，其余转成质量 0.86 的 JPEG，GIF 只留第一帧。编码结果超过 900,000 字节时，改成质量 0.8 的 JPEG，PNG 也一样。生图写入同一目录，单张最大 15,000,000 字节。

每条消息最多 1 个视频，最大 20 MiB，格式是 `video/mp4`、`video/webm`、`video/quicktime`，落在 `videos/vid_<十六进制>.mp4`、`.webm` 或 `.mov`。

消息里只记 `images/` 或 `videos/` 下的相对路径。组请求时，只有最后一条用户消息上的图片和视频会变成像素或数据；更早的图片换成「（此轮附有 N 张图片，像素未再次发送。）」，视频换成「（此轮附有 N 个视频，未再次发送。）」。只有媒体、没有文字时，正文分别是「请看图片。」「请看视频。」或「请看附件。」。子代理从不发这些附件。

## 配置

agent home 下 `config.json` 的字段见 [README 的配置表](../README.md#配置)。

- 保存时先读回磁盘上的配置再合并，所以手改的限额不会被界面的保存冲掉；但写入是整份重写。
- 目录 chmod 0700，失败会被忽略；文件以 0600 创建，之后再 chmod 一次。Windows 上 chmod 基本不起作用，文件靠用户目录本身的权限保护。
- 读取时去掉 BOM，并对 Base URL、模型、密钥去掉首尾空白。不是合法 JSON 时，文件改名为 `config.json.broken-<时间>`，启动时说明这个路径；文件不存在则不动。缺少配置时不会再悄悄写成 OpenAI 地址；保存工作区等字段时若尚无文件，只写入空的模型字段。每次成功保存前会更新 `config.json.bak`。
- 文件解析失败时，不自动捏造供应商地址；发送前会提示先配置模型。
- 密钥明文保存，只靠文件权限保护。

## 什么不会写进日志

- 配置里的 `apiKey`、`searchApiKey`，以及 `models` 列表里每条的密钥，都不由 runtime 写进三份日志。
- `user_message` 事件只记字数、图片张数和 `held`。
- `tool_call_arguments` 只给界面看，不发给模型。

注意边界：shell 读到的任何内容、网关返回的错误正文，都会原样写进日志，见 [安全模型与已知边界](tools-and-permissions.md#安全模型与已知边界)。

会写进去的一处：用户级指令和用户级记忆在每次请求的 system 里，于是随 `context.jsonl` 出现在工作区的 `.agent/` 里。工作区里的这份是副本，改它不会改记忆。
