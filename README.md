# clauda

一个跑在终端里的编码 Agent —— 参考 Claude Code 的功能实现，后端走 **OpenAI 兼容接口**，
所以 DeepSeek、Kimi、Ollama、vLLM、OpenAI 官方都能直接接。

```bash
clauda                          # 进入交互模式
clauda "把这个模块的报错处理理顺"   # 直接提问
clauda -p "解释 src/agent/loop.ts" --output-format json   # 无头模式，适合脚本调用
```

## 它有什么

- **真的会动手**：读写文件、执行命令、搜索代码库，多轮调用工具直到任务完成
- **流式输出**：边生成边渲染，带 Markdown 高亮和工具调用进度
- **权限闸门**：三种模式 + allow/deny 规则，默认模式下改文件和跑命令都要你点头
- **上下文自动压缩**：接近窗口上限时自动把早期对话摘要掉，长会话不会爆
- **会话持久化**：每个目录独立的会话历史，`--continue` / `--resume` 随时接着聊
- **项目记忆**：`CLAUDA.md` 存项目约定，每次会话自动带进上下文
- **技能**：把成套的操作指引写进 `SKILL.md`，模型按需载入，也可用 `/技能名` 手动触发
- **记忆库**：模型在会话里学到的事实自己存下来，跨会话复用；只注入索引，正文按需取
- **MCP**：接上 Model Context Protocol 服务器，工具集在运行时长出来，`/mcp` 可随时启停
- **不锁死厂商**：任何 OpenAI 兼容端点；常见厂商（DeepSeek、豆包/火山方舟、通义千问/百炼、
  Kimi、MiniMax、智谱 GLM、硅基流动、OpenAI、本地部署）的接口地址与候选模型名已内置

## 安装

需要 Node.js ≥ 20。

**自己机器上长期用** —— 装到全局，之后任意目录都能直接敲 `clauda`：

```bash
npm install
npm run build
npm install -g .
```

这条装出来的是**软链**（`<npm 全局前缀>/node_modules/clauda` 指向本仓库）。好处是改完源码
重跑 `npm run build` 就立刻生效、不用重装；代价是仓库目录不能挪走或删掉。
用 nvm 的话注意全局包是按 Node 版本隔离的，切版本后要重新装一次。

**打包分发给别人** —— 出 tarball，对方本地装：

```bash
npm run build
npm pack                              # 产出 clauda-0.1.0.tgz
npm install -g ./clauda-0.1.0.tgz     # 在目标机器上
```

这条是真拷贝、自包含，只带运行时依赖。**打包前一定要先 `npm run build`** —— `dist/`
在 `.gitignore` 里而包里装的就是构建产物，忘了构建会打出个跑不起来的包。

**发到 registry**：`npm publish`，之后任何人 `npm install -g clauda`。

不装全局也能直接用：`node /path/to/clauda/dist/index.js`。

## 配置

三种方式，优先级从低到高：**环境变量（含 `.env`）→ `~/.clauda/config.json` → 当前目录 `.clauda/config.json` → 命令行参数**。

配置文件压过环境变量是有意的：配置文件跟着项目走、是你显式认可的意图；环境变量常是别的
shell 会话里残留的导出，容易在不该生效的时候悄悄换掉端点。要临时盖过配置就用命令行参数，
它永远最高。

配置文件里可以用 `$VAR` / `${VAR}` 引用环境变量，这样端点写在配置文件里、密钥留在环境里，
不必把 key 明文落盘：

```json
{ "provider": { "apiKey": "${MY_DEEPSEEK_KEY}" } }
```

取不到的环境变量原样保留（不会被替换成空串），所以含 `$` 的正则和权限规则不会被动。

最省事的是环境变量（或复制 `.env.example` 为 `.env`）：

```bash
# DeepSeek
export CLAUDA_BASE_URL=https://api.deepseek.com/v1
export CLAUDA_API_KEY=sk-xxxxxxxx
export CLAUDA_MODEL=deepseek-chat

# 本地 Ollama
export CLAUDA_BASE_URL=http://localhost:11434/v1
export CLAUDA_API_KEY=ollama
export CLAUDA_MODEL=qwen2.5-coder:14b
```

也兼容 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 的写法。

**地址的路径各家不一样，不是一律以 `/v1` 结尾** —— 百炼是 `/compatible-mode/v1`、
方舟是 `/api/v3`、智谱是 `/api/paas/v4`。常见厂商的完整前缀与候选模型名都内置在
`src/provider/vendors.ts`，桌面端的「设置 → 模型 → 厂商」直接选。手填时只写主机名
（`http://localhost:11434`）会自动补上 `/v1`，已经带路径的一律原样保留。

只要地址命中内置的那一家，密钥可以只写厂商专属的变量名，不必再配 `CLAUDA_API_KEY`：

| 厂商 | 变量 |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 豆包 · 火山方舟 | `ARK_API_KEY` |
| 通义千问 · 百炼 | `DASHSCOPE_API_KEY` |
| Kimi · 月之暗面 | `MOONSHOT_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| 智谱 GLM | `ZHIPU_API_KEY` |
| 硅基流动 | `SILICONFLOW_API_KEY` |

这条回退只在**一个密钥都没配到**时生效：配置文件里写了 `apiKey` 的永远赢。本地部署不需要密钥。

写配置文件的话：

```json
{
  "provider": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "temperature": 0,
    "maxTokens": 8192
  },
  "permissions": {
    "mode": "default",
    "allow": ["Read", "Glob", "Grep", "Bash(npm run:*)"],
    "deny": ["Bash(rm -rf:*)"]
  },
  "pricing": { "input": 1, "output": 2, "currency": "CNY" },
  "contextWindow": 128000,
  "autoCompact": true,
  "maxToolResultTokens": 8000,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
      "permission": "read"
    }
  }
}
```

`pricing` 填每百万 token 的单价，`/cost` 才能算出钱。不填就只显示 token 数。

`contextWindow` 决定什么时候自动压缩历史，填模型真实窗口即可 —— `/cost` 里的
「上下文占用」按这个值算百分比。它计入了每轮都要发的工具 schema（约 1,400 token），
所以空会话也不会显示成 0。

`maxToolResultTokens` 是**单个**工具结果的 token 上限，超了会截断并告诉模型分段获取。
不填则按 `contextWindow / 4` 自动取值（上限 8000）—— 本地 4k 窗口的模型会自动收紧到
1k，避免一个 `read_file` 就把窗口吃光。注意 `read_file` 自己的 2000 是**行**上限，
不是 token 上限。

## 用法

### 命令行参数

```
clauda [prompt]                    直接提问
-p, --print <prompt>               无头模式，执行一次就退出
--model / --base-url / --api-key   覆盖配置
--permission-mode <mode>           default | auto | plan
--max-tokens <n>                   单次回复的最大 token 数
--context-window <n>               模型上下文窗口
-c, --continue                     继续当前目录最近一次会话
-r, --resume [id]                  恢复指定会话
--list-sessions                    列出历史会话
--init                             让模型调研项目并生成 CLAUDA.md
--output-format <text|json>        无头模式的输出格式
```

无头模式下 **stdout 只有模型的回答**，工具调用和用量统计都走 stderr。
所以 `clauda -p "..." > 报告.md` 拿到的是干净的文件：

```bash
clauda -p "总结一下这个项目" > 概览.md
clauda -p "有哪些 TODO" --output-format json | jq -r .result
```

注意：无头模式下没人能回答授权弹窗，写文件和执行命令默认会被拒绝。
需要放行就加 `--permission-mode auto`。

### 交互模式里的命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 全部命令 |
| `/status` | 当前配置与连接信息 |
| `/model <名称>` | 切换模型 |
| `/mode <模式>` | 切换权限模式 |
| `/cost` | token 用量与上下文占用 |
| `/compact` | 手动压缩历史 |
| `/clear` `/new` | 清空历史 / 开新会话 |
| `/init` | 生成 CLAUDA.md |
| `/skills` | 列出可用技能 |
| `/技能名` | 触发同名技能，见下文「技能」 |
| `/memory` | 查看项目记忆（`CLAUDA.md`） |
| `/memories` | 列出记忆库，见下文「记忆库」 |
| `/mcp` | MCP 服务器状态，`/mcp off <名字>` 临时摘掉 |
| `/tools` | 列出可用工具（按来源分组） |
| `/files` | 本会话读写过的文件 |
| `/sessions` `/resume <id>` | 会话列表 / 恢复 |

输入技巧：行尾 `\` 续行（粘贴多行代码用）；`↑` `↓` 翻历史；
`Ctrl+C` 打断当前任务，连按两次退出。

**管道输入会自动识别编码**（`clauda < 脚本`、`printf ... | clauda`）：按行先试 UTF-8，
遇到非法字节就整体退回 GB18030 重解。中文 Windows 的控制台代码页是 936，从 cmd 重定向过来的
输入常常是 GBK 而不是 UTF-8，不兜这一层就会解成一片 `�` 喂给模型。交互式终端不走这条路径
（不做编码探测，否则会破坏 raw 模式和方向键）。

注意管道输入的第一行在输出里看不到回显 —— readline 的 'line' 事件是异步派发的，
第一行到达时提示符已经打出去了，从第二行起才有回显。

## 权限

三种模式：

- **default** —— 读操作（读文件、搜索）自动放行；写文件和执行命令逐次询问
- **auto** —— 全部放行，适合无头模式和你完全信任的场景
- **plan** —— 只读，写和执行一律拒绝。让模型先出方案再动手

规则语法（`permissions.allow` / `permissions.deny`，deny 优先）：

```
Bash                      所有命令
Bash(npm run:*)           以 npm run 开头的命令
write_file(src/**)        只允许写 src 下的文件
mcp__linear               整个 linear 服务器的工具
mcp                       所有 MCP 工具
```

不带参数的工具名按**前缀**匹配，`mcp__linear` 能盖住 `mcp__linear__create_issue`。
双下划线这个分隔符保证了 `bash` 不会误匹配到 `bashx`。带参数的路径规则不受影响，
也**不支持**用在 MCP 工具上（见上文「MCP」）。

另外无论什么模式，`rm -rf /`、`mkfs`、fork bomb 这类命令都会被硬拦一道。

## 工具

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读文件，带行号，支持 offset/limit 分段 |
| `write_file` | 整文件写入（新建或覆盖） |
| `edit_file` | 精确字符串替换，要求原文唯一 |
| `glob` | 按文件名模式查找，按修改时间排序 |
| `grep` | 正则搜索文件内容，支持 content/count/files 三种输出 |
| `bash` | 执行 shell 命令，可超时、可中断、危险命令拦截 |
| `todo_write` | 任务清单，用于拆解多步任务 |

`glob` 和 `grep` 是纯 JS 实现，默认跳过 `node_modules`、`.git`、`dist` 等目录，
不依赖 ripgrep，装完就能用。

所有工具的结果都会按 `maxToolResultTokens` 封顶，截断处会留下明确提示并让模型改用
分段获取（`read_file` 的 offset/limit、`grep` 的 head_limit），而不是让它傻乎乎地重试一次。

## 项目记忆

在项目根目录放一个 `CLAUDA.md`（或 `.clauda/CLAUDA.md`），内容会自动进入每次会话的上下文：

```markdown
# 我的项目

## 常用命令
- 跑测试：npm test
- 构建：npm run build

## 编码约定
- 错误一律用 Result 类型返回，不抛异常
```

全局偏好放 `~/.clauda/CLAUDA.md`。当前目录没有记忆文件时，用 `/init` 让模型自己调研着写一份。

## 技能

技能是**成套的操作指引** —— 比记忆更「只在这类任务里才用得上」，所以它不进系统提示词的正文。

一个技能就是一个目录加一份 `SKILL.md`：

```
.clauda/skills/code-review/SKILL.md     项目级
~/.clauda/skills/code-review/SKILL.md   全局
```

```markdown
---
name: code-review
description: 审查改动的代码，按严重程度列出问题
---

按以下步骤做代码审查：

1. 先用 git diff 看清楚改了哪些文件
2. 逐个文件检查错误处理、边界条件、命名
3. 按「必须改 / 建议改」两档列出问题，每条带上文件:行号
```

系统提示词里**只放技能的名字和 description**，正文靠 `skill` 工具按需载入 ——
所以装十个技能也只多十几行字，不会把正文全塞进每轮请求。

两条触发路径：

- **模型自己调**：任务和某个 description 对得上时，模型先调 `skill` 工具拿到正文再照做
- **你手动触发**：直接敲 `/code-review`，正文会作为一条用户消息发出去，可带附加要求
  （`/code-review 只看 src/ 下的改动`）

同名时**离当前目录近的赢**：项目级 `.clauda/skills/` 压过全局 `~/.clauda/skills/`。
一层层往上找，越具体越优先。

`name` 不写就用目录名；写了但不符合 `[a-z0-9][a-z0-9-]*`（比如带了大写或下划线）也会退回目录名 ——
技能名要能直接当斜杠命令敲，所以得收窄。`description` 不写则取正文第一句。

几个注意点：

- frontmatter 只支持**单行 `key: value`**。嵌套、列表、多行值一概不支持，遇到了会当普通正文忽略掉，
  不会报错也不会吞掉你的内容。
- 技能名和内置命令撞了的话**内置优先** —— 你会看到 `/status` 走内置命令，同名技能被遮蔽，
  `/skills` 里会标出来。
- `SKILL.md` 必须是 **UTF-8**。用记事本存成 ANSI(GBK) 的话读出来是乱码。

## 记忆库

`CLAUDA.md` 是**你写**的项目说明，全文进上下文。记忆库是**模型自己写**的 —— 它在会话里
摸清的你的偏好、某个下次还会踩的坑，都存成一篇篇小文件，之后的会话直接带着走。

它和 `CLAUDA.md` 是两套东西，别混：

| | 项目记忆 | 记忆库 |
| --- | --- | --- |
| 谁写 | 你 | 模型 |
| 范围 | 项目（跟着仓库走） | 全局（`~/.clauda/memory/`） |
| 进上下文 | 全文 | **只有索引**（名字 + 用途） |
| 存放 | `CLAUDA.md` | `~/.clauda/memory/<名字>.md` |

一篇记忆就是一个带 frontmatter 的 markdown 文件：

```markdown
---
name: commit-in-chinese
description: 提交信息一律用中文
type: feedback
---

这个仓库的 commit message 用中文写，正文说明为什么改而不是罗列改动。
```

`type` 是 `user`（关于你本人）/ `feedback`（对你工作方式的指正或认可）/ `project`（正在做的事）/ `reference`（外部资源位置）。

两条路径：

- **模型自己判断该记就记**。写入是 `write` 权限，默认模式下会弹一次授权给你把关，
  plan 模式直接挡住，auto 模式放行。
- **你直接说「记住这个」**。也可以直接编辑 `~/.clauda/memory/` 下的文件，格式就是上面这样。

系统提示词里只放**名字和用途**，正文靠 `memory_read` 按需取 —— 和技能是同一套渐进披露，
所以记几十条也不会把正文全塞进每轮请求。`/memories` 随时看有哪些。

几个注意点：

- **同名即覆盖**，没有版本历史，也没有删除命令 —— 要删就直接删文件。设计上假设
  一条记忆只放一个事实，内容变了就重写一遍。
- 单篇正文上限 4KB，超了会被拒绝并提示拆成几条。记忆是一句话量级的东西，写不下通常
  意味着该拆。
- 记忆库是**全局**的，不分项目。项目特有的约定写进 `CLAUDA.md` 更合适 —— 那是跟着
  仓库走、能被提交的。

## MCP

[MCP（Model Context Protocol）](https://modelcontextprotocol.io) 服务器把外部能力
（数据库、工单系统、浏览器……）暴露成一组工具。clauda 连上之后，这些工具会和内置的 7 个
一样交给模型，由模型自己决定何时调用。

在配置文件的 `mcpServers` 里列出要接的服务器 —— **不显式写就不会连任何服务器**，
默认一个都不接：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
      "permission": "read"
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" },
      "permission": "exec"
    }
  }
}
```

字段：

| 字段 | 说明 |
| --- | --- |
| `command` `args` `env` `cwd` | **stdio** 传输：clauda 起一个子进程，走管道通信 |
| `url` `headers` | **HTTP** 传输（Streamable HTTP），接远端服务器 |
| `type` | `stdio` / `http`，不写就按有没有 `url` 推断 |
| `enabled` | `false` 则启动时就不连。和运行期的 `/mcp off` 效果一样但机制不同 |
| `permission` | `read` / `write` / `exec`，**默认 `exec`**（最保守） |
| `tools` | 白名单，只接这些工具 —— 挡住大服务器几十个工具全塞进来 |
| `timeoutMs` | 连接超时，默认 15000 |

`env` 和 `headers` 里可以用 `${VAR}` 引用环境变量，令牌就能留在环境里不落盘。

**成本要留意**：每个接进来的工具的 schema 每轮请求都要发一遍，还会让自动压缩提前触发。
所以默认只接你写出来的服务器，`tools` 白名单和 `permission: 'read'` 都是省钱的旋钮。
接入时会在 stderr 打一行 `已接入 MCP：…`，`/mcp` 页脚也有总数。

运行期用 `/mcp` 看状态、`/mcp off <名字>` 临时摘掉（会真的断开连接，工具当场从工具集消失；
`/mcp on <名字>` 重新接上）：

```
  filesystem  stdio  已连接  工具 12
  linear      http   失败    连接 MCP 服务器 linear 超时
  docs        stdio  未启用  工具 0

这些工具的 schema 每次请求都要发，约 812 token。用 /mcp off <名字> 可以摘掉。
```

「未启用」既可能是配置里写了 `enabled: false`，也可能是你刚 `/mcp off` 掉的 ——
前者重启还在，后者只影响本次会话。

几个注意点：

- **单个服务器坏掉不影响会话**。连不上只会在 stderr 警告一句、`/mcp` 里记成「失败」，
  其余服务器照常接入。
- MCP 工具名会被改写成 `mcp__<服务器>__<工具>` —— 后端的函数名只允许 `[A-Za-z0-9_-]`，
  服务器上的 `item.get` 这种名字发过去会被直接拒绝。`/tools` 里看到的是改写后的名字，
  调用时会还原成真实名字；超长会截断并补一段哈希，同名会加 `_2` `_3` 后缀。
- MCP 工具**不支持参数级权限规则** —— 靠猜「哪个参数是路径」太不可靠，猜错的后果是
  「以为拦住了其实没拦住」。要收窄就用每个服务器自己的 `permission`，或用 `tools` 白名单。
- 权限弹窗会给 MCP 工具单独标一句：它的具体行为不在 clauda 的管控范围内。

## 架构

```
src/
  index.ts            CLI 入口与参数解析
  config.ts           配置合并（默认值 < env < 全局 < 项目 < CLI）
  permissions.ts      权限闸门：模式 + 规则匹配
  provider/
    types.ts          Provider 接口与流式事件定义
    vendors.ts        常见厂商预置：接口地址、密钥变量名、候选模型与坑位提醒
    openai.ts         OpenAI 兼容实现，负责 tool_calls 分片拼装
  agent/
    agent.ts          主循环：流式 → 工具调用 → 回填结果 → 再流式；含上下文压缩
    system-prompt.ts  系统提示词组装
    memory.ts         CLAUDA.md 发现与加载
    memory-store.ts   记忆库：全局目录的读写（复用技能的 frontmatter 解析）
    session.ts        会话落盘与恢复
    view.ts           Agent 与终端之间的接口
  skills/
    frontmatter.ts    最小 YAML frontmatter 解析（无依赖）
    registry.ts       SKILL.md 发现与读取
  mcp/
    naming.ts         工具名消毒与撞名消解（纯函数）
    tool.ts           把 MCP 工具包成 clauda 的 Tool
    manager.ts        连接池、启停、工具装配
  tools/              read/write/edit/glob/grep/bash/todo/skill/memory
  ui/                 渲染、REPL、斜杠命令、主题
```

分层的要点：`Agent` 只依赖 `View` 接口，不关心是交互式终端还是无头输出，
所以同一套循环能同时支撑 REPL 和 `-p`。

## 开发

```bash
npm run dev          # 用 tsx 直接跑源码
npm run typecheck    # 只做类型检查
npm test             # 构建 + 单元 + 端到端
npm run mock         # 起一个假的 OpenAI 兼容服务端，离线调 UI 用
```

`tests/` 里的端到端测试会在进程内起一个 mock 服务端，把 clauda 当子进程跑，
覆盖工具往返、权限、压缩、会话恢复和错误提示 —— 不需要真的 API Key。

## 已知限制

- 工具调用依赖后端的原生 function calling。不支持该能力的模型（部分本地小模型）会无法调用工具。
- `glob` / `grep` 不解析 `.gitignore`，只按目录名黑名单跳过。
- 没有子 Agent / 并行任务编排，工具是串行执行的。
- **压缩治不了「单轮内被一个大工具结果顶爆」**。那种情况下要压的内容全堆在历史末尾，
  摘掉头部省不下多少，所以只能靠 `maxToolResultTokens` 事前封顶，而不是靠压缩事后补救。
- 上下文占用是**估算**（CJK 按 1 字 1 token、拉丁按 4 字符 1 token）。实测与 DeepSeek
  实际计费口径相差约 2%，用来决定何时压缩足够了，别拿它当账单。
- **读文件一律按 UTF-8**，包括 `CLAUDA.md` 和 `SKILL.md`。只有管道输入（stdin）有 GB18030 兜底。
  中文 Windows 上写这些文件请确认编码是 UTF-8，否则会读成乱码。
- 技能没有版本、依赖、参数校验，也不支持相对路径引用别的文件 —— 就是一个目录一份 `SKILL.md`。
- MCP 只支持 **stdio** 和 **Streamable HTTP** 两种传输，没有 SSE 和 WebSocket。
- MCP 服务器声明的 schema 必须符合规范（`inputSchema` 得带 `type: "object"`）。规范的
  v2 客户端会在解析 `tools/list` 时强校验，**一个不合规的工具会让整个服务器的工具列表被丢弃**，
  不是跳过那一个。真遇到了会在 stderr 看到 `Invalid result for tools/list`。
- MCP 工具的结果里，图片和音频只留占位符（`[图片内容，已省略：image/png]`）——
  clauda 是纯文本 CLI，内联 base64 只是白烧 token。
- 记忆库没有语义检索，靠模型读索引里的名字和用途自己判断该读哪条。这要求 `description`
  写得能让人一眼看出该不该点开 —— 写得含糊那条记忆基本就找不回来了。
- 记忆库是全局的，没有按项目隔离，也没有同步机制。多台机器各存各的。

## License

MIT
