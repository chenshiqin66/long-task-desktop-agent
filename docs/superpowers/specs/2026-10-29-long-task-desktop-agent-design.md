# 长任务型桌面智能体（一期）设计说明

日期：2026-10-29  
状态：待用户审阅  
相关：[产品说明书 Page](https://cursor.com/canvas/store-084edf9f-41fb-4d5c-a440-bc464a5f4689/4d4b781c-d39d-48fa-a00e-44347cc2f43e)

## 1. 目标

交付可安装的 Electron 桌面客户端，验证「单会话、可中断、有上限的 ReAct、三类内置工具、jsonl + trace、流式、可恢复」闭环。一期主场景为**本地代码仓库**上的长任务；通用文件夹场景二期扩展，但工作区绑定模型保持通用。

## 2. 已确认决策

| 项 | 决策 |
| --- | --- |
| 语言 | TypeScript |
| 壳 | Electron |
| 结构 | Monorepo：`packages/core` + `packages/app` |
| 路线 | Core 硬核 + Electron 薄壳 |
| 模型 | OpenAI 兼容（含自建/第三方网关） |
| 工作区 | 一会话绑定一工作目录 |
| 步数上限 | 单次用户回合最多 50 步工具循环；到顶停止并提示用户继续或改指令 |
| 中断 | 保留已流出文本并标 interrupted；杀进行中 bash；未完成 tool_call 不执行；trace 记 cancel |
| 落盘 | `{workspace}/.agent/` |
| 不做 | 记忆提取、自定义工具、联网、右侧产物窗、子代理、多会话并发长任务、任意步回滚 |

## 3. 架构

### 3.1 包职责

- **`packages/core`（纯库）**  
  会话管理、上下文拼装与压缩、ReAct 循环、Tool Host、OpenAI 兼容 Provider、`.agent/` 读写、事件发射。全部核心逻辑可单测，不依赖 Electron。

- **`packages/app`（Electron）**  
  左：会话列表；中：对话与输入。通过 IPC 调用 core、订阅流式事件。不直接调模型或工具。

### 3.2 运行时关系

```
UI (app)  --submit/cancel-->  Agent Runtime (core)
     ^                              |
     |         events               +--> LLM Provider (OpenAI-compatible)
     +------ text/tool/error/done --+
                                    +--> Tool Host (bash / Read / search)
                                    +--> Store (.agent jsonl + trace)
```

### 3.3 会话与路径

- `sessionId` + `workspacePath` 一对一绑定（创建时选定，一期不中途更换）。
- 工具 cwd / 文件访问根 = 该 `workspacePath`。
- 数据目录：`{workspace}/.agent/sessions/{sessionId}/`

## 4. 数据流

### 4.1 用户回合

1. UI → core：`submit({ sessionId, text })`
2. 追加 user 消息到 `messages.jsonl`；分配 `turn_id`；写 trace 起点
3. 拼装上下文（固定顺序）：system → 工具描述 → 压缩后历史 → 当前 user
4. 流式调用 LLM；推送 UI；落盘 assistant
5. 若有 `tool_call`：Tool Host 执行 → tool result 落盘并回灌
6. 重复 4–5，直到无工具调用或达到 50 步 → `done`（若因上限则提示）

### 4.2 落盘布局

```
{workspace}/.agent/
  sessions/{sessionId}/
    meta.json          # workspace、创建时间等
    messages.jsonl     # user | assistant | tool
    trace.jsonl        # 事件、token、错误、取消
```

关联字段至少：`session_id`、`turn_id`、`trace_id`（或等价 message/event id）、事件类型、时间戳、token。

### 4.3 中断

- 取消进行中的 LLM 请求与 bash。
- 已流出 assistant 文本保留并标记 `interrupted`。
- 未完成的 `tool_call` 不执行、不写入成功 tool result；trace 记 cancel。
- 会话回到可继续输入状态。

## 5. 上下文与压缩

- **拼装顺序**（写死）：system → tools → 压缩历史 → 当前 user。
- **轮的定义**：一次用户提交算一轮的起点；该提交触发的 assistant / tool 消息同属该轮，直到本回合 `done` 或中断。
- **轮次规则**：当历史中的用户轮次数超过 10 时，保留最早 3 轮与最近 10 轮的完整消息；介于两者之间的轮次合并为一条摘要消息（若最早 3 与最近 10 重叠，则不摘要、保留全部）。
- **体积规则**：另设上下文字符上限（实现时可配置，测试中用小阈值）；超限同样触发压缩或截断。单条工具输出、Read/搜索返回先截断再入历史。

## 6. 工具

| 工具 | 作用 | 约束 |
| --- | --- | --- |
| bash | 执行 shell | cwd 为工作区；默认超时 60s（可配置）；输出截断；失败回传 |
| Read | 读文件 | 禁止工作区外与 `..` 逃逸；单次体积上限 |
| 关键字搜索 | 搜文件 | 工作区内；条数/体积上限 |

失败、超时、越界一律以 tool result（含错误信息）返回模型，禁止静默挂起。

## 7. 错误与安全

- LLM 鉴权失败、超时、上下文超限 → UI 可见错误 + trace；允许重试。
- 存储写入失败 → 停止本轮并报错。
- API key 仅存本机配置，不得写入 messages/trace 明文。
- bash 可拒绝明显高危模式（如对根路径的破坏性删除）；一期保持规则简单可测。

## 8. 配置

本机可配置：base URL、model、API key、默认超时、步数上限（默认 50）。一期不做多 Provider 路由。

## 9. 测试策略（TDD）

优先在 `packages/core`：

1. 上下文拼装顺序与压缩（轮次 + 体积）
2. ReAct：假 Provider；满 50 步强制停止
3. 工具：超时、越界、截断、失败 result 形状
4. 落盘与恢复：id 关联；中断后文件状态
5. OpenAI 兼容请求/流式契约（mock HTTP）

`packages/app`：少量烟雾（开窗、发送、停止）。不测真实模型效果与完整安装包 E2E。

开发顺序建议：先测通 core 闭环，再挂 Electron 薄壳。

## 10. 验收口径

用户可安装客户端 → 配置 OpenAI 兼容接口 → 选定仓库工作区并建会话 → 流式对话与工具过程可见 → 可停止 → 重启后历史从 `.agent/` 恢复 → messages 与 trace 能按 turn 对齐 → 满 50 步有明确提示。

## 11. 非目标（一期）

记忆、插件工具、联网搜索、右侧生成物、子代理、并发多会话长跑、检查点回滚到任意步、Tauri、非 OpenAI 官方第二协议实现。
