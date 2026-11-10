# 子代理与多任务评测

[`cases.json`](cases.json) 有 16 条用例（mt-01 到 mt-16），按用例声明的层级跑真实的 `@agent/core`：

- `model`：只看模型在第一个回合里选了什么（工具、参数、任务措辞）。
- `runtime`：模型输出由脚本给定，只看运行时对任务清单、领取、依赖和子代理的处置。
- `both`：用真实模型跑完整回合，让运行时的拒绝与回执真实发生，再看结果。

`runner/` 是执行器。它把每条用例放进一个临时工作区，写入 fixture、历史消息和已有任务，然后启动 `AgentRuntime`，最后从事件流、请求记录、任务快照和磁盘文件里取证据逐项打分。

## 运行

```powershell
npm run eval                 # 构建 core 和 runner，跑全部用例
npm run eval:build           # 只构建
node evals/subagent-multitask/runner/dist/cli.js --layer runtime
node evals/subagent-multitask/runner/dist/cli.js --id mt-05,mt-06 --verbose
```

需要先构建 `@agent/core`（`npm run eval` 会自动构建）。`runtime` 用例不需要模型；`model` 和 `both` 需要一份兼容 OpenAI 的配置：

```json
{ "baseUrl": "https://api.example.com/v1", "model": "model-name", "apiKey": "..." }
```

默认读取 `~/.long-task-agent/config.json`（与桌面应用同一份配置，密钥不会打印）。也可以用 `--config <path>` 指定。没有配置时，`model`/`both` 用例显示为 `SKIP`，`runtime` 用例照常跑。

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--id <id[,id]>` | 只跑指定用例 |
| `--layer <model\|runtime\|both>` | 只跑某一层 |
| `--group <no-list\|parallel\|dependent\|failure>` | 只跑某一组 |
| `--no-live` | 强制跳过需要模型的用例 |
| `--config <path>` | 指定模型配置 |
| `--timeout <ms>` | 覆盖单条用例的时限 |
| `--verbose` | 打印每次工具调用、任务快照和最终回复 |
| `--keep` | 保留临时工作区并打印路径 |
| `--json` | 输出机器可读结果 |
| `--list` | 列出用例 |

退出码：`0` 全部通过或跳过；`1` 有失败或报错；`2` 参数/配置错误。

## 一条用例怎么跑

1. `workspace.ts` 在系统临时目录建工作区，写入 `fixture`、创建会话、把 `transcript` 合成 assistant 的 `tool_calls` 后落盘、按 `prior_tasks` 写任务文件。
2. 按层级选模式：
   - `runtime`：`ScriptedProvider` 按 `scripted_parent` 逐条返回；一条脚本项就是一条 assistant 回复。`scripted_subagent.inner_tools` 是子代理的回复序列；`calls_complete_task` 为假时不自动补 `complete_task`。
   - `model`/`both`：`RecordingProvider` 包住真实模型，记录每次请求和回复。
3. 提交 `user` 文本，等待回合结束（或被策略取消），再读任务、消息、子代理目录和磁盘文件。
4. `graders.ts` 把用例的 `must`/`must_not`/`tasks_*` 翻译成带 id 的检查项；`report.ts` 输出 PASS/FAIL 和失败项的证据。

### 模型探测策略

只用真实模型时，跑完整个回合既慢又可能触发用例之外的后续动作。`policies.ts` 给部分用例加了停止策略：

| 策略 | 用例 | 行为 |
| --- | --- | --- |
| `stopBeforeTools` | mt-02、mt-03、mt-04、mt-14 | 第一个父回复流完后取消，批次里的工具不执行 |
| `stubSubagents` | mt-01、mt-11 | 子代理请求不发给模型；延后交付的受理文字仍会返回，子代理本身不完成，避免回执开新回合污染探测 |
| `stopAtSubagent` | mt-15 | 父回复里出现 `subagent` 后取消 |
| `stopAtWrite` + `stopAtSubagent` | mt-12 | 出现写入类工具或子代理后取消 |
| 不设策略 | mt-05、mt-06、mt-07、mt-08 | 完整跑完，运行时行为本身就是评测对象 |

取消发生在父回复流结束之后、批次落盘和执行之前（`provider.onParentExchange`），所以同一条回复里的兄弟调用不会被截断。

### 特殊脚手架

- **mt-06**：`SCAFFOLD_NPM_TEST` 把 fixture 的 `npm test` 换成必定成功的空脚本，这样父会话跑完测试才有「通过」可完成。其他用例保留原 fixture（mt-07、mt-15 需要失败的测试）。
- **mt-13**：`DIRECT_SUBAGENT` 绕过父回合，直接调 `runIsolatedSubagent`，因为用例考察的是子代理自己调用 `task_create` 的结果。
- **mt-16**：`WAIT_FOR_DEFERRED` 在结束前等待延后工作落定，否则第二个子代理的拒绝发生在观察之后。

### 运行时用例的脚本约定

`scripted_parent` 的每一项是**一条助手回复**，不是一次工具调用。同一项里放多个调用才能测并行批次。`args` 里写工具参数；`scripted_subagent.parent_call` 也接受像 mt-10 那样把参数平铺在外层。`scripted_subagent.id` 是子代理的固定 id，只有 mt-13 直接用得到。

## 已知的用例问题

评测器按用例原文打分，下列问题会体现在结果里，不会在运行时偷偷修正：

- **mt-05**：`must_not` 把 `docs/api` 列为禁止的 `output_dir`，`must` 却要求它。评分按 `must` 处理，接受 `docs/api` 和 `docs/cli` 两个并列目录，并在 note 里说明。
- **mt-15**：fixture 的 `npm test` 指向不存在的 `test.js`，失败日志是 `MODULE_NOT_FOUND`。评分接受这种结构性失败，只看「先跑命令、再把日志交给 explore」。
- 工作区里 `.agent/` 对模型可读。mt-01 实测中模型翻 `.agent/sessions/.../subagents/` 找子代理 id；用例没有禁止，但这不是产品希望鼓励的行为。

### 已修正的用例

这三条原先与产品规则或自身矛盾，已按下面的方式改掉，旧结论不再适用：

- **mt-06**：`output_dir` 从 `src/pay` 改为 `src`（`writeScope` 只允许写 `output_dir` 本身或其子路径，`src/pay` 写不了 `src/pay.ts`）；用户指令改为「先查清 src 里的金额计算」，让 explore 有真实可查的范围；worker 的任务必须限定只改 `src/pay.ts`。
- **mt-08**：允许第三条路径「先完成 #1，再派 #2」。原来的 `must_not` 禁止把 #1 标完成，和「不派发，先做 #1」的变体冲突；现在只禁止「在 #1 未完成时启动 #2 的子代理」。完成 #1 的可以是父会话，也可以是父会话派出的 worker；只要 #2 的受理发生在 #1 完成之后即可。
- **mt-12**：补上 `src/auth/token.ts` 的 fixture（`return token.length < 8;`），并把回执改成真实陈述「空字符串长度为 0，会通过」。原来的 `length > 8` 与「空字符串会通过」自相矛盾。

## 提示词修正

评测结果里有一类失败不是用例问题，而是父会话不知道该什么时候派、派给谁。对应的规则写进了 `packages/core/src/runtime/agentRuntime.ts` 的 `SUBAGENT_RULES`/`TASK_RULES` 和 `packages/core/src/tools/agentTool.ts` 的 `subagent` 工具说明：

| 规则 | 针对的用例 |
| --- | --- |
| 用户点名用子代理，或这一轮要两处独立调查时，第一个回复只能是子代理调用，不能先 `list_dir`、`read_file`、`keyword_search` 或建任务 | mt-01、mt-04、mt-14 |
| 用户说「分几步」「先…再…最后」时，把三次 `task_create` 作为第一个动作，先于任何 `list_dir`/`read_file`/`powershell`；工作进了任务清单后按步派发：调查交 `explore`，写文件交 `worker`，父会话只自己做命令和只有它能做的决定 | mt-06 |
| 用户点名一个已知路径的文件时，第一个动作就是 `read_file` 那个路径，不先 `list_dir` 找它 | mt-02 |
| 一个目录只派一个 worker；同一目录的多份文件写进一个 task，不按文件拆 | mt-14 |
| worker 的 `output_dir` 取包含所有目标文件的最窄目录；task 里点名具体文件，并说明不要改其他文件；并行时声明不写对方的目录 | mt-05、mt-06 |
| 用户点名要跑的命令，作为第一个工具调用单独执行；失败后把输出交给 `explore` 定位文件和行号，父会话不自己诊断 | mt-15 |
| 用户说这一轮不用等结果，或只要 agent id 和 `output_dir` 时用 `deferred`；受理结果里已经带了这两项，不要去翻输出目录或 `.agent/` | mt-01、mt-05、mt-14 |
| task 用用户正在使用的语言写，完成标准里点名文件和行号 | mt-04 |

评分器另有三处措辞容忍，不算产品规则：mt-04 的 task 用英文写 `line numbers`/`do not edit` 也算；mt-05 的边界句接受「不要读改那个目录」一类写法；mt-06/mt-15 只把「让子代理去跑测试」算违规，task 里引用 `npm test` 的失败背景（「跑 npm test，命令失败了」「不要运行任何测试命令」「由父会话运行」）都不算。

## 结构

| 文件 | 作用 |
| --- | --- |
| `cli.ts` | 参数解析、模型配置加载、顺序执行、输出 |
| `cases.ts` | 读取并校验 `cases.json`，按 id/层/组筛选 |
| `workspace.ts` | 临时工作区、fixture、历史消息、已有任务 |
| `provider.ts` | 脚本提供者、录音提供者、停止策略 |
| `policies.ts` | 每条用例的模式、时限、脚手架 |
| `runCase.ts` | 组装配件、提交回合、等待/停止延后工作、收集观察 |
| `observe.ts` | 从事件、请求、任务、文件和收件箱构造观察 |
| `graders.ts` | 16 条用例的检查项 |
| `grade.ts` | 检查项工具函数（批次、顺序、任务快照） |
| `report.ts` | 文本/JSON 报告 |
| `coreInternals.ts` | 动态加载 `@agent/core` 未公开导出的子代理入口 |
