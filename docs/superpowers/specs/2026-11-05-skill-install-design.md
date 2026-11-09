# 安装技能

日期：2026-11-05

> **这是当时的设计记录，不再随代码更新。** 现行行为以 [技能](../../skills.md) 为准。已知和代码不一致的地方：
>
> - 「脚本」一节说不新增脚本工具、用 shell 执行脚本。现在有专门的 `run_skill_script`，提示词反而要求模型不要用 shell 跑技能脚本。
> - 文件表里说 preload 暴露 `replaceSkill`。现在 preload 暴露的是 `listSkills`、`installSkill`、`uninstallSkill`、`setSkillEnabled`、`openSkillFolder`；`replaceSkill` 只留在 core 里，界面没有入口。

安装把一份技能复制到本机用户目录，让每次模型请求都带上它的名字和 description。用户在输入框用 `/name` 点名，或模型调用 `read_skill`，才会在这一次发送里带上正文。下一次发送不再附上正文。

## 已定行为

### 安装位置

副本放在 `%USERPROFILE%\.long-task-agent\skills\<name>\`，与 `config.json` 同级。不写入工作区，不写入本仓库，不写入会话目录。

`name` 来自 `SKILL.md` 的 frontmatter，不用文件夹名。合法名字是一段路径：小写字母、数字、连字符，不能以连字符开头或结尾，长度 1 到 64，正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。

复制整棵目录，但跳过任意层级上名为 `.git`、`node_modules`、`__pycache__` 的目录。符号链接先解析：目标在源目录外则整次安装失败；目标在源目录内则按文件内容复制，副本里不保留符号链接。

这是快照。之后修改原来的文件夹，副本不变。

同名时的两个入口：

- **安装**：名字已存在则拒绝，不覆盖。更新这个名字时，直接改技能目录里的文件，或先卸载再添加。
- 把符合规范的文件夹拷进 `skills\<name>\` 同样算已安装。列表不记录「是不是从按钮装的」，每次都扫这个目录。文件夹名必须等于 frontmatter 的 `name`，并且 `SKILL.md` 能解析，否则不出现。

先复制到 `skills` 下的临时目录，成功后再改名。复制失败时删掉临时目录。界面不再提供整份替换。

卸载删除该名字的目录。目录不存在则报错。正在进行的发送已经读入的正文继续用到这次发送结束。

安装、卸载、开关不重建 `AgentRuntime`。目录在每次组装时从磁盘重读。

### 停用

每张卡片有一个开关。关掉表示不用，不删除文件夹。状态写在 `skills\.skill-settings.json`，不写进技能文件夹，所以改技能文件不会把开关拨回去。

停用后：模型目录里没有它，`/` 菜单不列出它，发送里的 `/name` 在写入用户消息前失败，`read_skill` 和 `run_skill_script` 拒绝它。再打开后，下一次请求恢复。已经在进行的发送仍用开始时读入的正文。

### 技能页

侧栏「技能」在右侧主区域打开一页，不再使用对话框。页上有已安装数量、「添加技能」，以及每个技能一张卡片。添加仍是选择文件夹并安装。同名拒绝。卡片上可以卸载，也可以停用。目录变化后列表会重新扫描。

点击卡片在系统文件管理器中打开 `%USERPROFILE%\.long-task-agent\skills\<name>\`。打开的是本机副本，不是当初选择的源文件夹。在这个目录里改文件，会改变之后请求读到的副本。

再点「技能」，或点会话、新建会话、会话台和会话文件页，回到原来的主区域。输入框里的 `/` 菜单不变。

### 上下文里有什么

三层分开：

| 层 | 进入上下文的时机 | 存放 |
| --- | --- | --- |
| `name` 与 `description` | 已安装且开启之后的每一次模型请求 | 只在当次 system 里，不写 `messages.jsonl` |
| `SKILL.md` 正文 | 这次发送的用户文本含 `/name`，或模型调用 `read_skill` | 见下文 |
| `references/`、`scripts/`、`assets/` | 模型按路径去读或用 shell 执行 | 留在副本里 |

「一次发送」指一次 `submit`，包含其中每一次组装和工具调用，不是单次 HTTP。

用户文本里的 `/name` 留在用户消息里。正文不写入该消息。`submit` 开始时把这些正文读进这次调用的内存，这次循环里的每一次组装都附到 system。循环结束即丢弃。下一次用户消息不从磁盘重读、不再附上。

发送中途改了副本或拨了开关：已附上的正文仍是发送开始时的那一份。`read_skill` 读的是调用当时的磁盘。

`context.jsonl` 继续记录实际发出的 messages。因此这次发送的每一步都会含有正文。沿用现有审计，不另做摘要。

system 的顺序：原有系统提示、已安装技能目录、这次发送附上的正文、工具表。目录和正文计入 `contextCharLimit` 已有的预算扣减，不新增截断规则。单份正文或单个引用文件超过 `maxReadChars`（默认 50000）时，按 `read_file` 的方式截断并注明已截断。

### 输入「/」

标记是「开头或空白之后的 `/`，加上一个合法技能名」。`C:/Windows` 和 `https://` 不匹配。一次消息可以有多个标记。手动输入与从菜单插入等价。

菜单在光标处的未完成标记上打开，列出已安装技能的 `name` 和一行 `description`，用 `/` 后面的字过滤。方向键移动，Enter 插入 `/name ` 并且不发送，Esc 关闭。没有已安装技能时，菜单显示「尚未安装技能」。

名字未安装，或正文读不出来：在写入用户消息之前失败，错误中带上这个标记。`messages.jsonl` 不增加这轮用户消息。界面把已经清掉的输入放回去，并去掉为这次发送先画上的气泡。

### `read_skill`

只读工具，`classifyToolCall` 将其标为 `read`，不弹确认。未登记的工具今天会按写操作处理，所以必须显式登记。

参数：

- `name`：已安装技能名，必填。
- `path`：副本内的相对路径，可省略。

省略 `path` 时返回 frontmatter 之后的正文。这次发送已经附上了该正文时，只返回「已在上下文中」，不再把正文写入工具结果。

给出 `path` 时返回文本。解析后的 `realpath` 必须仍在该技能目录内，符号链接逃逸拒绝。非文本文件返回字节数和绝对路径，不返回字节。

下一次及以后的发送在组装出站副本时，把更早 `turn_id` 上的 `read_skill` 结果收成一句：`此前读过技能 <name> 的正文。需要时再调用 read_skill。` 带路径时把「正文」换成该相对路径。`messages.jsonl` 保持全文。同一次发送里的结果保持全文。

### 脚本

不新增脚本工具，不把脚本注册进工具表。目录说明要求模型用 `powershell`（其他系统用 `bash`）执行副本里的绝对路径，工作目录仍是当前工作区。

文件工具不能写技能目录，因为路径在工作区外。shell 仍然可以改副本。这一版不加第二套 shell 沙箱。副本被改乱后，在技能目录里改回，或卸载后重新添加。

本机是 Windows 时，技能里的 `bash scripts/foo.sh` 不会执行。系统提示继续禁止启动 `bash.exe` 和 WSL。这一点不在本设计里解决。

## 组件

| 单元 | 职责 |
| --- | --- |
| `packages/core/src/skills/frontmatter.ts` | 从 `SKILL.md` 开头读 `name` 和 `description` |
| `packages/core/src/skills/installedSkills.ts` | 副本根目录、列举、安装、卸载、停用、按相对路径读取 |
| `packages/core/src/skills/tokens.ts` | 从用户文本提取 `/name` |
| `packages/core/src/context/assemble.ts` | 把目录和这次发送的正文放进 system；出站时收束旧的 `read_skill` 结果 |
| `packages/core/src/tools/readSkill.ts` | `read_skill` 工具 |
| `packages/core/src/tools/policy.ts` | 把 `read_skill` 标为 `read` |
| `packages/core/src/runtime/agentRuntime.ts` | 发送前校验标记；在这次 `submit` 的循环内把正文传给组装 |
| `packages/app/electron/main.ts` | 目录对话框与 IPC |
| `packages/app/electron/preload.ts` | 暴露 `listSkills`、`installSkill`、`replaceSkill`、`uninstallSkill` |
| `packages/app/src/renderer/skills.ts` | 技能页与 `/` 菜单 |

`main.ts` 已经超过两千行。对话框和菜单不继续写进该文件，只在那里接线。

frontmatter 只解析本设计需要的子集，不引入 YAML 依赖：

- 文件以 `---` 开头，到下一个仅含 `---` 的行结束。
- `name` 为单行标量。
- `description` 支持单行标量、双引号、单引号，以及块标量 `>`、`>-`、`|`、`|-`。
- 其他键忽略。
- 缺少 `name` 或 `description`、值为空、名字不合法、块标量无法解析：安装失败，不写副本。

IPC 沿用 `agent:` 前缀。主进程用与「增加工作区」相同的 `showOpenDialog` 选择文件夹。渲染进程不接收磁盘路径以外的文件内容；正文由 core 在发送时读取。

目录说明的固定句子：

```text
# Installed skills
- <name>: <description>
...
Skill use:
- The catalog above is always present. The body is not, until this user message contains /<name> or you call read_skill.
- If /<name> is in the user message, that body is already in this request. Do not call read_skill for the body again. Call read_skill with path to read a reference or asset.
- Run a script with the shell tool and the absolute path inside the skill directory. The shell working directory stays the workspace. Do not edit the skill directory.
```

这次发送附上的每份正文前加一行 `# Skill body: <name>`。

## 错误

| 情况 | 结果 |
| --- | --- |
| 没有 `SKILL.md`，或 frontmatter 无效 | 不复制，对话框说明原因 |
| 安装时名字已存在 | 不覆盖，提示直接改技能目录或先卸载再添加 |
| 技能已停用时发送 `/name`，或调用 `read_skill` / `run_skill_script` | 不把正文交给模型；文件夹保留 |
| 符号链接指向源目录之外 | 安装失败，旧副本保留 |
| 发送时任一 `/name` 未安装或正文不可读 | 不写用户消息，输入恢复，错误里含该标记 |
| `read_skill` 的名字未安装 | 工具结果为错误，循环继续 |
| `read_skill` 的路径逃出该技能目录 | 工具结果为错误，循环继续 |
| 卸载一个不存在的名字 | 对话框说明未找到 |

## 测试

用 `@agent/core` 的 vitest 覆盖，不依赖手点 Electron：

- 缺少 frontmatter、名字不合法、单行与 `>` / `|` 的 description、安装拒绝同名、直接拷入的合规范文件夹会出现在列表、停用后文件夹仍在但读不到正文、卸载。
- 复制时跳过 `node_modules`，源目录外的符号链接使安装失败。
- `read_skill` 拒绝目录穿越和指向目录外的符号链接；非文本返回大小和绝对路径。
- 组装时目录始终在；正文只在调用方传入的那一份里出现。
- 更早 `turn_id` 的 `read_skill` 正文和引用文件，在出站副本上收成短句；同一次 `turn_id` 保持全文；磁盘消息不变。
- 未知 `/name` 在 `persistMessage` 之前抛出。

界面的菜单开合不进 core 测试。

## 不做

- 不把正文记入 `meta.json`，也不在后续发送中自动重附。
- 不为会话做「已启用技能」芯片，也不限制一次最多启用几个。
- 不把每个脚本注册成工具。
- 不在安装后监视源文件夹。
- 不为技能目录增加 shell 沙箱。
- 不解决 Windows 上技能脚本要求 bash 的问题。
