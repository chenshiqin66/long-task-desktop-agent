# 工具与权限

模型能做的一切都经过工具：读写文件、跑命令、联网搜索、派子代理、问人。每次工具调用先由 `classifyToolCall`（`packages/core/src/tools/policy.ts`）分成 `read`、`write`、`blocked` 三档：`read` 直接执行，`write` 停下来等人点允许，`blocked` 不执行。文件类工具另有一道路径沙箱；shell 没有沙箱，只靠命令分级。

这份文档先讲分级和许可门，再列工具、路径沙箱和 shell 命令的分级规则，最后写这套机制挡不住什么。

## 分级与许可门

| 档 | 做法 |
| --- | --- |
| `read` | 直接执行 |
| `write` | 发出 `permission_request`，界面弹出「需要确认才能执行」，卡片里列出要执行的命令或工具调用，按钮是「允许这一轮」「拒绝」「停止」 |
| `blocked` | 不执行，写一条错误工具结果 |

允许一次，这一轮后面的写操作、命令、`run_skill_script` 和 `worker` 子代理都不再询问。「一轮」指一次发送带起的整段模型循环；完成通知开出的续跑轮重新计。拒绝只否定这一次调用：写成一条 `Cancelled: user denied permission` 工具结果，模型可以换个做法继续。`blocked` 不受「允许这一轮」影响。`ask_user` 不经过许可门，它本身就是停下来等人。

<!-- 待作者确认：为什么按轮放行，而不是逐条确认？推测：长任务里逐条确认会把人钉在屏幕前；按轮放行是打扰和控制之间的折中，「停止」按钮兜底。 -->

## 工具一览

内置 19 个工具，都在 `createBuiltinTools()`（`packages/core/src/tools/host.ts`）里注册。shell 工具的名字随平台变：Windows 上叫 `powershell`，启动 `powershell.exe`；其他系统叫 `bash`，用 `bash -lc`。

| 工具 | 分级 | 要点 |
| --- | --- | --- |
| `read_file` | 自动 | 整个文件读进来，按 `maxReadChars` 截断 |
| `list_dir` | 自动 | 跳过名为 `node_modules`、`.git`、`.agent` 的子项 |
| `keyword_search` | 自动 | 一次最多 8 个词，按字面、区分大小写；跳过大于 1,000,000 字节的文件；条数上限 `maxSearchResults` |
| `web_search` | 自动 | 调 DeepSeek 搜索接口，复用聊天的 API key；`count` 默认 8、最大 50；查询超过 128 字截断 |
| `read_skill` | 自动 | 读已安装技能的正文或附件，见 [技能](skills.md) |
| `task_create`、`task_list`、`task_get`、`task_update`、`task_delete`、`claim_task`、`complete_task` | 自动 | 只改本会话 `.agent` 里的任务清单，见 [子代理、任务清单与完成通知](subagents-and-tasks.md) |
| `ask_user` | 不经许可门 | 问题最长 2000 字，最多 6 个选项、每个最长 200 字；回答最长 8000 字 |
| `write_file`、`str_replace`、`delete_file` | 确认 | 结果文件最长 500,000 字；`str_replace` 要求唯一匹配，否则传 `replace_all`；`delete_file` 不删目录 |
| `run_skill_script` | 确认 | 只跑技能目录里的 `.py`、`.js`、`.mjs`、`.cjs`；参数是数组，最多 32 个、每个最长 2000 字，不经 shell |
| `subagent` | explore 自动；worker 确认 | 派一个子代理，见 [子代理、任务清单与完成通知](subagents-and-tasks.md) |
| `powershell` / `bash` | 看命令 | 命令最长 8000 字；超时 `bashTimeoutMs`；输出超过 `maxToolOutputChars` 时结束进程，返回截断的输出，不算失败 |

未知工具按 `write` 分级；宿主找不到实现，返回错误结果。工具参数解析失败、工具内部抛错，都变成 `is_error` 的工具结果交还模型，不打断循环。有一个例外：子代理里调用 `subagent` 或 `ask_user` 时，整个子代理以失败结束，见 [已知问题](roadmap.md#已知问题)。

shell 命令的执行环境：Windows 上以 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` 启动，命令按 UTF-16LE 编码传入，不经过命令行的引号转义。外层包装把输出编码设为 UTF-8，并把外部程序的非零退出码当作工具失败。其他系统用 `bash -lc`。工作目录是当前工作区，环境变量继承应用进程。输出按块解码，一个多字节字符恰好落在两块交界时，这个字会变成乱码。

`web_search` 的地址由聊天的 Base URL 推出来：以 `/v1` 结尾时拼 `/tools/search`，否则拼 `/v1/tools/search`。这是 DeepSeek 的搜索接口；Base URL 指向别家服务商时，这个工具多半会报错。返回给模型的是编号的纯文本结果，工具说明要求模型用 `[n]` 标注来源。

## 文件工具的路径沙箱

`read_file`、`list_dir`、`keyword_search`、`str_replace`、`delete_file` 先对目标路径取 `realpath`，再要求它落在工作区的 `realpath` 之内。符号链接指向工作区外，会被拒绝。

`write_file` 的目标可能还不存在。它从目标的父目录往上找第一个存在的祖先，确认这个祖先在工作区内，再递归建目录，建完对父目录再取一次 `realpath` 复核。

写入类工具（`write_file`、`str_replace`、`delete_file`）还不能落进 `.agent`，会话状态只能经各自的工具修改。读不受这条限制。比较之前，路径先换成文件系统实际会碰到的那一条：已经存在的部分取 `realpath`，展开符号链接、目录联接、大小写和 8.3 短名，比较本身也不分大小写。所以 `.AGENT/…`、指向 `.agent` 的目录联接都进不去。子代理仍占着的 `output_dir` 锁按同样的方式比较（`packages/core/src/tools/writeScope.ts`）。

只有一项检查区分大小写：子代理自己的写入必须落在它的 `output_dir` 里。这是放行的一侧，在区分大小写的文件系统上忽略大小写会把范围放宽；拦截的一侧忽略大小写，最多是多拦。

## Shell 命令怎么分级

shell 是最难管的工具：一条命令可能读、可能写，也可能在参数里藏着另一条命令。分级只做一件事：判断这条命令能不能不问人就执行。

**原则：一条命令只有在 bash 和 PowerShell 两套解析规则下都判为只读，才自动放行。** 这个工具在 Windows 上跑 PowerShell，在其他系统上跑 bash，而两者对引号、转义和注释的规则不一样。比如在 PowerShell 里 `‘` 能结束字符串，`\` 只是普通字符；在 bash 里正好相反。只按一套规则判断，引号的边界一旦和 shell 不一致，后面的重定向、甚至一整条命令，都会被当成引号里的文字放过去。两套都判，结论就不依赖当前跑在哪个系统上，测试在哪台机器上跑结果都一样。

判断按这个顺序走：

1. **拦截**：两类命令直接 `blocked`，点过允许也不执行（`packages/core/src/tools/dangerous.ts`）。
   - 磁盘级工具：`mkfs`、`dd of=/dev/…`、`Format-Volume`、`Clear-Disk`、`Initialize-Disk`、`Remove-Partition`、`format X:`、`diskpart`、`wipefs`、`blkdiscard`，以及用 `shred`、`fdisk`、`parted` 这类工具或重定向写 `/dev/` 下的磁盘设备。
   - 递归删除整个盘或根目录。这一步不按固定写法匹配，而是把命令拆成语句、管道阶段和词，去掉引号（包括 PowerShell 认的弯引号），`bash -c '…'`、`cmd /c "…"` 里的命令再拆一遍。删除命令（`rm`、`rmdir`、`rd`、`del`、`erase`、`Remove-Item`、`ri`）带了递归参数（`-r`、`--recursive`、`/s`、`-Recurse` 及其缩写），目标归一化之后是根或根下的全部，就拦：`/`、`//`、`/*`、`/tmp/..`、`C:\`、`C:/`、`C:\*`、`$env:SystemDrive\` 都算。根目录经管道送进删除命令也算，比如 `Get-ChildItem C:\ | Remove-Item`、`ls / | xargs rm -rf`。

   认不出用变量拼出来的路径，也不管用户目录和系统目录，这些落到后面的步骤，按写操作要确认，见 [已知问题](roadmap.md#已知问题)。
2. **扫描**：按每种 shell 自己的规则，标出引号、转义、注释之外还在起作用的字符。遇到这次不建模的语法就要求确认：命令替换 `$(...)` 和反引号、圆括号和花括号、bash 的 heredoc（`<<`）、PowerShell 的 here-string（`@'`、`@"`）、块注释 `<#`、停止解析符 `--%`、词中间的 `#`。命令里有控制字符也要确认。
3. **切段**：在 `;`、`&&`、`||`、换行、单独的 `&` 处切开，再按管道 `|` 切成若干阶段。每一段的每个阶段都必须只读。切分只看引号外的字符，所以 `echo "a;b"` 不会被切开。
4. **重定向**：`>`、`>>`、`2>`、`*>`、`&>` 这类，目标只要不是 `/dev/null`、`$null`、`&1`、`&2`，就算写。
5. **命令名**：按 shell 的方式拼出命令名，去掉引号和转义，所以 `gi"t" push` 认作 `git push`。命令名必须在下面的只读白名单里，并且只能由字母、数字和 `_./+-` 组成。`rm`、`mv`、`cp`、`sed`、`tee`、`chmod` 这类一律算写。`sudo` 也不在名单里，所以带 `sudo` 的命令一律要确认，`sudo cat a` 不会因为 `cat` 只读就自动执行。
6. **参数**：白名单里有些命令带上特定参数就会写文件、执行别的程序或求值代码，这些组合要确认：

| 命令 | 怎样才算只读 |
| --- | --- |
| `git` | 子命令只能是 `status`、`diff`、`log`、`show`、`branch`，且不带 `--output`。子命令前面不能有全局选项：`-c` 能临时改配置去执行程序，所以 `-c`、`-C`、`--no-pager` 都要确认。`git branch` 只能带列出类参数，带名字就是建分支 |
| `find` | 不带 `-delete`、`-exec`、`-execdir`、`-ok`、`-okdir`、`-fprint`、`-fprint0`、`-fprintf`、`-fls` |
| `sort` | 按 GNU 规则逐个字母解析，不能出现 `-o`（`-bo out.txt` 就是 `-b -o out.txt`），也不带 `--output`、`--compress-program` |
| `tree` | 不带 `-o`、`-R` |
| `uniq` | 最多一个位置参数，第二个就是输出文件 |
| `rg` | 不带 `--pre`、`--hostname-bin`，这两个会执行程序 |
| `file` | 不带 `-C`，它会写 magic 文件 |
| `test` | 不带 `-v`、`-R`。bash 会对变量名里的数组下标求值，下标里的 `$(...)` 会被执行 |
| `printf` | 格式串前面不带 `-v`，连写的 `-vNAME` 也算。理由同上 |
| `curl` | 不带写文件、读配置、上传或发数据的选项（完整清单见表下），方法只能是 GET 或 HEAD |
| `Invoke-WebRequest`、`Invoke-RestMethod`（`iwr`、`irm`） | 不带 `-OutFile`、`-InFile`、`-Body`、`-Form`、`-CustomMethod`、`-Resume`，`-Method` 只能是 GET 或 HEAD。参数缩写按 PowerShell 的唯一前缀规则展开，`–OutFile` 里的长破折号也认 |

curl 要确认的选项：短选项 `-o`、`-O`、`-T`、`-d`、`-F`、`-D`、`-c`、`-K`，连写在 `-sSo` 这种组合里也算；长选项 `--output`、`--output-dir`、`--remote-name`、`--remote-name-all`、`--upload-file`、`--dump-header`、`--cookie-jar`、`--config`、`--trace`、`--trace-ascii`、`--stderr`、`--libcurl`、`--etag-save`、`--hsts`、`--alt-svc`、`--data`、`--data-raw`、`--data-binary`、`--data-urlencode`、`--data-ascii`、`--form`、`--form-string`、`--json`，按 curl 的规则，这些名字的无歧义前缀也算；还有带 `%output{` 的写出格式。

Windows PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，所以 `curl` 两套参数规则都要过。GNU `wget` 不在白名单里，因为它默认就把下载内容写进文件。

<details>
<summary>只读白名单全集</summary>

命令名不区分大小写。

- 通用：`ls`、`pwd`、`cat`、`head`、`tail`、`rg`、`grep`、`find`、`echo`、`printf`、`test`、`[`、`which`、`where`、`type`、`file`、`stat`、`wc`、`sort`、`uniq`、`diff`、`tree`、`basename`、`dirname`、`realpath`、`true`、`false`
- PowerShell：`Get-ChildItem`（`gci`、`dir`）、`Get-Content`（`gc`）、`Get-Item`（`gi`）、`Get-Location`（`gl`）、`Select-String`（`sls`）、`Measure-Object`、`Resolve-Path`、`Split-Path`、`Test-Path`、`Write-Output`、`Write-Host`、`Get-Command`（`gcm`）、`Get-Date`、`Select-Object`、`Where-Object`、`Sort-Object`、`Group-Object`、`Compare-Object`、`Get-FileHash`、`Format-Table`、`Format-List`、`Out-String`、`Out-Host`
- 只换目录：`cd`、`Set-Location`（`sl`）、`Push-Location`、`Pop-Location`、`pushd`、`popd`
- 只发 GET：`curl`、`curl.exe`、`Invoke-WebRequest`（`iwr`）、`Invoke-RestMethod`（`irm`）

`[` 虽然在名单里，但不满足命令名的字符规则，所以 `[ … ]` 实际总要确认。`git` 不在名单里，单独按上表的规则判断。

</details>

**保守的代价。** 有些其实只读的命令也要确认，比如 `Get-ChildItem | Where-Object { $_.Length -gt 1MB }`（脚本块）、`(Get-Content a.txt).Length`（括号）、`ls {a,b}`（花括号展开）、带 `#` 片段的 URL，以及 `npm test` 这类不在白名单里的命令。「允许这一轮」把这份代价压在每轮一次点击里。

上面每一条规则都有对应的测试，在 `packages/core/tests/policy.test.ts`。白名单本身和这份文档的一致性由 `packages/core/tests/docs.test.ts` 检查。

## 安全模型与已知边界

这套机制是一道确认门，防的是模型莽撞或被误导时不经询问就改东西。它不是沙箱，挡不住一个有意攻击、而你又点了允许的场景。

**它保证的：**

- 文件工具读写不出工作区，写入类工具不碰 `.agent`；换大小写、走目录联接都绕不过去。有一个已知缺陷：`write_file` 的目标若已经是指向工作区外的符号链接，内容会先写到外面，复核失败后才报错，见 [已知问题](roadmap.md#已知问题)。
- 自动执行的 shell 命令，在上面规则覆盖的范围内，不写文件、不执行别的程序。
- 递归删除整个盘或根目录、格式化或擦除磁盘，点过允许也不执行。用变量拼出来的路径认不出，删用户目录、系统目录不在这份名单里，这些只剩确认这一道，见上面第 1 步。
- 配置里的 `apiKey` 不由 runtime 写进会话日志（`llm_request` 只记模型名、条数、字数、图片张数和 `context_id`）。

**它挡不住的：**

- **点过允许之后**，命令以你的用户权限运行，可以写工作区外，也可以改 `.agent` 和技能目录。`run_skill_script` 同样如此。
- **只读命令不限路径。** 自动放行的 `cat`、`Get-Content` 能读你能读的任何文件，包括 `~/.long-task-agent/config.json` 里的 API key。读出的内容会写进 `messages.jsonl`、`trace.jsonl`、`context.jsonl`。
- **PowerShell 的「读」不止于文件。** 经 provider，`Get-ChildItem env:` 能列出全部环境变量，`Get-Content env:OPENAI_API_KEY` 能读出单个变量，`Get-ChildItem HKCU:\` 能读注册表，这些都自动执行。shell 继承了应用进程的环境变量，所以放在环境变量里的密钥同样读得到。
- **UNC 路径会连外部主机。** 在 Windows 上，读命令里的 `\\host\share` 会去连接那台主机，连接时可能把你的 NTLM 凭据哈希发过去。
- **GET 请求自动放行，所以数据可以经 URL 带出去。** 模型读到的内容可以拼进 `curl https://…?q=…` 发出，不弹确认。网页内容里的提示注入可能诱导模型这样做。
- **同一工作区的会话共用目录。** `read_file` 读得到 `.agent` 里其他会话的记录。
- **`.agent` 明文保存文件内容、命令输出和图片。** 代码不会替你把它加进 `.gitignore`。
- **子代理的工具调用不经过分级和许可门**，只靠类型自带的工具子集和 `output_dir` 限制。`worker` 的启动本身要确认。
- **git 会按本地配置运行程序。** `git status`、`diff`、`log`、`show` 可能按 `.git/config` 调用 pager、外部 diff 或 fsmonitor；而这一轮早先放行的写入，可能已经改过 `.git/config`。
- **网关的错误正文原样落盘。** 有的服务商会在错误信息里回显打了码的 key。

已知的代码缺陷单独列在 [路线图](roadmap.md#已知问题)。
