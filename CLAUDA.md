# clauda

终端编码 Agent，参考 Claude Code 的功能，后端走 OpenAI 兼容接口。

## 常用命令

- `npm run build` —— 编译到 `dist/`，**跑任何测试之前都要先构建**
- `npm test` —— 构建 + 单元 + 端到端，全绿才算通过
- `npm run typecheck` —— 只做类型检查，比 build 快
- `npm run dev -- "问题"` —— 用 tsx 直接跑源码，调试时用
- `npm run mock` —— 起本地假 OpenAI 服务端（默认 8899），离线调 UI
- `npm run desktop` —— 构建后起 Electron 桌面端（见下面「桌面端」一节）

## 编码约定

- **注释写「为什么」，不写「做什么」**。只在有非显然的取舍时写注释，比如某个
  workaround 绕开的是什么坑。纯描述性的注释一律不加。
- 注释和面向用户的文案都用中文；标识符、类型名用英文。
- ESM + NodeNext：**相对导入必须带 `.js` 后缀**（写 `./foo.js`，即使源文件是 `foo.ts`）。
- `strict` 且开了 `noUnusedLocals` / `noUnusedParameters`，未使用的变量会直接编译失败。
- 对象字面量里给 `Record<string, unknown>` 之类的类型赋值时注意 `exactOptionalPropertyTypes`
  相关的收窄，拿不准就跑 `npm run typecheck`。

## 架构上的硬约束

- **消息一律用 OpenAI wire 格式**（`WireMessage`）在内部流转，Provider 层不做格式转换。
  会话文件因此可以直接序列化落盘、原样读回。改这一层之前想清楚。
- **`Agent` 只依赖 `View` 接口**，不知道自己是跑在 REPL 还是无头模式。headless 和交互模式
  共用同一个主循环，差异全部落在 View 的实现上（`TerminalView` / `PlainView`）。
- **stdout 只放模型的回答**。工具进度、用量统计、错误全部走 stderr —— 这样
  `clauda -p "..." > out.md` 才是干净的文件。改输出时别破坏这条。
- **压缩历史时不能切开 `assistant(tool_calls)` 和它的 `tool` 结果**。分批逻辑在
  `agent.ts` 里靠 `while (cut > 1 && messages[cut].role === 'tool') cut--` 保证。
- **上下文核算必须包含工具 schema**：`contextTokens() = specsTokens + messagesTokens(...)`。
  这 7 个 schema 约 1404 token，作为请求的 `tools` 参数发送、不在 `messages` 里，
  早期版本漏算过。漏掉的后果是压缩触发点系统性偏晚 —— 窗口小于约 5600 时，
  真实请求已经撑爆窗口而估算值还没到阈值。真机校验：报告 2,238 vs 接口实收 2,189。
- **`ALL_TOOLS` 恒为 7 个内置工具，新工具一律不许往里加**。技能工具、MCP 工具都走
  `AgentOptions.tools` / `Agent.setTools()` 注入。加进 `ALL_TOOLS` 会同时打崩两处：
  `tests/unit.mjs` 里 1404 token 那条断言，和上面这条架构约束。技能工具还是**有条件**
  注入的（一个技能都没有就不挂，省下这份 schema 每轮的 token），更不可能进这个数组。
- **改动工具集必须同时重算 `specs` 和 `specsTokens`**（`Agent.setTools()` 就是干这个的）。
  这两个字段只在构造函数里算过一次，`streamOnce` / `runOneTool` 是调用时读 `this.tools`
  所以自动跟上，但漏算 token 的后果同上。
- **`config.ts` 的 `merge()` 必须显式列出 `mcpServers`**（新顶层段一律如此）。`...patch`
  是浅合并，项目配置里只要出现这个键，全局配的服务器就会被**整个顶掉**。现在的处理是按
  **服务器名**合并，同名时项目级的整体替换全局的，**不做字段级深合并** —— 想改全局某个
  服务器的单个字段，得把它整个重写一遍。
  「只有一个值的键」（`activeProvider`、`defaultAgent`）没有这个合并问题，但**同样要占
  一行**：靠 `...patch` 兜底的话，哪天有个调用方给了 `defaultAgent: undefined`
  （TS 上完全合法），这个键会被无声抹成 `undefined` 而不是空串。
- **MCP 子进程必须关掉**（`McpManager.closeAll()`）。`StdioClientTransport` 起的子进程会让
  事件循环一直活着，忘了关的表现是 `/exit` 之后**卡住不返回**而不是报错。三个出口都要接：
  REPL 的 `onExit`、无头模式的 `shutdown()`、以及 `SIGTERM` 兜底。
  故意**没接 `SIGINT`** —— 双击 Ctrl+C 归 readline 的 `rl.on('SIGINT')` 管，两边都接会打架。
- **系统提示词的段落顺序即语义**，新段落一律插在 `## 项目记忆` 之前。两处依赖这个顺序：
  `repl.ts` 的 `/memory` 靠 `split('## 项目记忆')[1].split('## 会话配置')[0]` 取项目记忆，
  往这两个标题之间插任何东西都会弄坏它；测试里也有对应的回归断言。
  当前顺序：`coreIdentity → agentIdentity → environment → toneAndStyle → toolGuidance →
  attachmentGuidance → modeGuidance → skillsSection → memoryIndexSection → memorySection →
  configSection`。智能体那段排第二是**唯一合理的位置**：它交付的就是「你是谁」，
  该紧挨着基础人格，而不是沉进环境 / 风格那几段「怎么做」里。
- **记忆只注入索引，正文一律不进提示词**（`memoryIndexSection` 只输出 name/description/type）。
  记忆库是无限增长的，正文一旦进提示词就是每轮都付。单测有「索引里不含正文」的断言
  盯着这条，别为了「让模型少调一次工具」把正文塞进去。
- **工具想改系统提示词，靠 `Tool.invalidatesPrompt` 声明，不要在 agent 循环里判断工具名**。
  目前只有 `memory_write` 用：不重建提示词的话，模型刚写下的事实当轮自己都看不见。
  代价是这一轮 `messages[0]` 变了、会打断后端的提示词前缀缓存，所以只在真写了记忆时触发。
- **工具想换掉工具集合，靠 `Tool.invalidatesTools` 声明**（同一套理由，别在循环里认工具名）。
  跑完走 `AgentOptions.onToolsChanged` 回调，而不是 Agent 自己 `setTools` —— 它手里那份数组
  是过期的，重算要回到持有项目运行时的那一层（`SessionManager.refreshProjectTools`，
  `setMcpEnabled` 现在也复用它，早先那是同一条循环的第二份写法）。**漏掉声明的症状是
  「刚加的东西当轮用不上」**：技能写得出来却载入不了、MCP 接上了工具一个没多，而且不报错 ——
  四个工具（`skill_write` / `skill_remove` / `mcp_add` / `mcp_remove`）都声明了它。
  两个 MCP 工具**不**声明 `invalidatesPrompt`（提示词里那段「## 可用技能」没动），
  但那条回调为省事一律连提示词一起重建 —— 它分不出刚跑的是哪个工具，宁可多重建一次。
- **记忆工具是无条件注入的**（不同于技能工具「有技能才挂」）：没有记忆时恰恰最需要
  `memory_write`，藏起来就永远写不进第一条。代价是这两个 schema 每轮都要付，实测
  **+384 token**（7 个内置是 1385）—— 调整它们的 description 时留意这个数。
- **技能和记忆的发现顺序方向相反，这是有意的，别当成不一致去「修」**：记忆把全局放在
  最后，因为在拼接起来的文本里「靠后 = 更权威」；技能是**按名查找**不是拼接，所以
  「更具体 = 更优先」，全局先进表、项目级覆盖它，离 cwd 近的赢。
- **单个工具结果必须按 token 封顶**（`capResult` → `capByTokens`）。`read_file` 的
  2000 是**行**上限不是 token 上限，`bash` 的输出压根没上限，而同样 2000 行代码和
  中文说明的 token 数差好几倍。超大结果偏偏落在历史末尾，压缩摘不掉它 —— 只能在这里封顶。
  默认取窗口的 1/4（上限 8000），小窗口模型会自动收紧。
- 权限检查顺序固定：deny 规则 → allow 规则 → 会话内允许 → 模式逻辑 → 询问用户。
  显式规则永远压过模式。
- **规则名要归一化后才能和工具名比**（`permissions.ts` 的 `normalizeToolName`）。
  配置和文档里写的是 Claude Code 那套名字（`Read`、`Write`、`TodoWrite`），而工具名是
  snake_case（`read_file`…），只做大小写不敏感比较的话这些规则**静默失效** ——
  用户以为拦住了其实没拦，是最危险的一类 bug。归一化是「小写 + 去掉单下划线 + 查别名表」，
  规则名和工具名走**同一个函数**，只处理一边会退化成 `read_file` → `read` 照样对不上。
  **双下划线必须原样保留**，前缀匹配靠 `mcp__` 区分服务器名和工具名。
- **`sessionId` 必须可变，且 `/new`、`/resume` 都要动它**（`index.ts` 里是 `let`，
  通过 `ReplOptions.onNewSession` / `onResumeSession` 回调改）。它是 `persist()` 写哪个
  文件的唯一依据：`/new` 不换 id 就会拿新会话**覆盖旧文件**，`/resume` 不接管 id 就会
  另起一个文件、原会话永不更新。CLI 的 `--resume`/`--continue` 走的是另一条路，也得改 id。
- **`agent.restore()` 内部负责重建系统提示词**。落盘时的 `messages[0]` 是按当时的配置
  生成的，恢复时可能已经过期（换了模型/模式、记忆库变了、cwd 不同）。放在 `restore` 里
  而不是各个调用点，是因为 CLI 和无头模式的 `/resume` 都走它，少接一处就漏一处。
  同处顺带清掉 `compactions` / `messagesAtLastCompact` —— 这两个不在快照里，
  留着会让压缩冷却误判成「刚压过」而一直不压。
- **MCP 的 `connect`、`listTools`、`callTool` 三处都要 `withTimeout`**。
  只罩 `connect` 是不够的：服务器握手成功却在 `tools/list` 上装死是常见故障，
  表现是 clauda **起不来**（实测能挂到用户手动 Ctrl+C），而工具调用卡住会把整轮对话
  吊死（工具是串行执行的，后面全停摆）。超时值按服务器存一份在 `this.timeouts`，
  因为 `callTool` 在工具闭包里拿不到 `cfg`。
- **配置优先级：默认值 < 环境变量（含 `.env`）< `~/.clauda/config.json` <
  `./.clauda/config.json` < 命令行参数**。配置文件压过环境变量是刻意反常识的：
  配置文件跟着项目走、是用户显式认可的意图，环境变量常是别的 shell 残留的导出。
  `.env` 和真实环境变量因为都进了 `process.env`，无法区分，算同一层。
  改顺序时注意 `loadConfig` 里 merge 的先后就是优先级，别靠注释记。
- **stdin 是管道时要过 `decodeInput()`**（`repl.ts` 里按 `isTTY` 分流）。
  **交互式终端绝对不能包这一层** —— 包了 raw 模式和方向键就失灵。

### 桌面端（Electron）

分界线只有一条：**`src/runtime/*` 里一行 electron 都不许有**，`desktop/main.js` 只是
它的薄适配。这条不是洁癖而是可测性 —— `tests/desktop-driver.mjs` 用**和主进程相同的代码
路径**（`DesktopApp.handle`）在子进程里跑完「建会话 → 发消息 → 授权 → 退出」，
窗口之外的行为全部有回归。`tests/unit.mjs` 末尾的 `== 自检：Electron 不许漏进运行时 ==`
把这条钉成了断言（扫 `dist/**/*.js` 里有没有 `from 'electron'`），别绕过它去 dist 里
手写适配代码。

- **`View` 接口一个新方法都不加**。`IpcView`（`src/runtime/ipc-view.ts`）复用的就是
  `TerminalView` / `PlainView` 那 10 个方法，`Agent` 一行没动。这是整个桌面端能成立的
  前提：多会话并行不是一个新主循环，只是多几个 `View` 实例。
- **`config` 必须按会话克隆**（`session-manager.ts` 的 `structuredClone`）。`/model` 写
  `config.provider.model`、`/mode` 写 `config.permissions.mode`，共享的话 A 切模型会串到
  所有会话，且 B 的系统提示词自报 A 的模型。
- **`PermissionManager` 的 `ask` 不监听 signal**（`permissions.ts` 的 `ask`），所以每条
  取消路径都必须**先 `denyAll(sessionId)` 再 abort**，否则待决的 Promise 永不 settle、
  `runTurn` 永久挂起，表现是「点了停止但没反应」。三条路径都要接：`abort`、
  `closeSession`、renderer 崩溃（`desktop/main.js` 的 `render-process-gone`）。
- **`PermissionManager` 的 asker 必须晚绑定**。构造时快照 `ref.ask` 的话，交互模式永远
  拿不到授权框。见 `permission-bridge.ts` 的 `askerFor`。
- **同一会话不许并发 `runTurn`**：`Agent` 只有一个 pending 槽，两条 user 消息交错入栈会让
  第一条的 Promise 泄漏。`SessionManager.send()` 在 `status !== 'idle'` 时直接拒绝，且
  **置位是同步的**（在第一个 await 之前），否则挡不住连点发送。
- **`McpManager` 按项目缓存、带引用计数**，最后一个会话关了才 `dispose()`。它的
  `closeAll()` 不可逆（`closed = true` 之后 `start()` 直接 return），提前关掉就再也开不回来。
- **开关 MCP 要广播给同项目所有会话**（`setMcpEnabled` 遍历 `session.cwd === cwd`）。
  只重算当前会话的话，其它会话的 agent 仍持有旧工具列表 —— 用户以为关了其实没关。
  而且**必须 `await` 并把异常放出去**：`McpManager.setEnabled` 在连不上时会抛，早先
  这个 Promise 被直接丢掉，于是「接入一个配错了的服务器」既不报错、工具也没接上，
  界面还显示成功。`mcp/set-enabled` 因此不能再无条件返回 `{ok:true}`。
- **会话 id 必须先过 `isSafeSessionId` 再拼路径**（`session.ts`）。它直接进
  `` path.join(dir, `${id}.json`) ``，而且**一路流到写路径** —— `persist.ts` 用同一个 id
  续写文件，所以 `id: '../../x'` 不是「读错文件」，是「写到别处去」（`.json` 后缀、
  内容是会话记录）。三个来源都不能信：桌面端 `session/resume` 的 IPC 载荷、
  CLI 的 `--resume <id>`、以及**会话文件里的 `id` 字段**（`index.ts` 恢复后会接管它）。
  最后一条决定了这道闸放在 `session.ts` 而不是只堵 IPC 口 —— 只堵 IPC 挡不住磁盘上
  被改过的文件。`desktop-app.ts` 里那两道是为了给人话错误，不是主防线。
  同一处：`loadSession` 解析出来还要过 `isSessionRecord`，随便一个 `.json` 都能
  `JSON.parse` 成功，而恢复会话的人拿 `messages` 直接用（`persistSession` 读 `.length`）。
- **写配置文件只能改磁盘上的原始文本，不许拿 `loadConfig()` 的结果回写**
  （`config.ts` 的 `writeProjectProvider` / `writeProjectProfile` / `writeActiveProfile` /
  `removeProjectProfile`，一律经 `readJsonObjectForWrite` 读原文）。
  `loadConfig` 内部的 `expandEnvRefs` 已经把 `${MY_KEY}` 换成了真实密钥，拿它回写等于把
  密钥明文落盘 —— 这是数据泄露，不是格式问题。同一处：改了默认模型／接口地址还要**同步
  内存里的 `project.config`**，因为它是新建会话**唯一**的来源（`openSession` 走的是
  `structuredClone(project.config)`），漏了就成了「改了没生效」；文件解析不了时**报错返回、
  不覆盖**，别为了容错丢掉整份配置。同步**不许图省事重跑 `loadConfig`** —— 它内部的
  `dotenv.config` 会改全局 `process.env`（见下面 `createProjectRuntime` 那条），
  `SessionManager.patchTemplate` + `syncTemplate` 就是在内存里做 `resolveProfiles` 那一件事。
- **技能与 MCP 的两条写路径沿用上面那条**（`skills/writer.ts` 的 `writeSkill` / `removeSkill`，
  `config.ts` 的 `writeMcpServer` / `removeMcpServer`），各自另有一条自己的：
  技能名按 `NAME_RE` 校验后**照用、不 slugify** —— 静默改名会让界面上的名字和目录名对不上，
  那是最难查的一类问题；`removeSkill` 有两道护栏（必须是某个 `skills` 根的直接子目录、
  里面真有 `SKILL.md`），因为它会一路走到 `rmSync(recursive)`，一个手滑的入参就是递归删任意目录。
  写完**顺序不能换**：先 `registry.refresh()` 再广播新工具集 —— 装配读的是 `skills.list()`，
  反过来算出来的还是旧名单（零技能时连 `skill` 工具都不在集合里，用户看到的是「技能页里有了，
  可它说没有这个技能」）。MCP 那边**先写盘再连接**：写盘可能因为文件不是合法 JSON 而抛，
  那时连接还没建；反过来则是「连接建好了、配置没写成」—— 一个谁也找不到的孤儿子进程，
  重启就没了，用户还以为是保存成功了。连不上时**不回滚配置**（那是个看得见也删得掉的状态）。
  保密一条：`env` / `headers` 的值可以含密钥，所以 **`ProjectInfo.mcp` 永远不把它们读回来**，
  表单只让填不让看，提示用户写成 `${VAR}` 占位符。
- **技能开关存的是「关掉的名字」（`config.disabledSkills`），两份配置合并时取并集**。
  限制只该越合越紧：全局关掉的在项目里也必须是关的，否则「项目级」就成了绕开全局限制的口子。
  代价是**打开必须两份都清**（`writeSkillDisabled` 的 `disabled: false` 分支写两个文件，
  `true` 只写选中的那份范围）—— 合并之后看不出某一条来自哪份文件，和 `removeMcpServerAnywhere`
  是同一个困境。`SkillRegistry` 是唯一的分配点，三个读法别用混：`list()` 排除关掉的（提示词、
  `skill` 工具、斜杠命令、智能体白名单全走它），`listAll()` 含关掉的**只给设置页**（它得能把
  关掉的再打开），`find()` 不管开关**只给删除路径**（改用 `get()` 会变成「禁用之后就再也删不掉」）。
  连带的坑：`ProjectInfo.skills` 走的是 `listAll()`，所以导航徽标不能直接数它（那是磁盘上有
  几个），要数 `skillCost.on` —— 否则关掉一个技能徽标反而涨。`mark()` 是 `disabled` 落到名单
  上的**唯一**入口：`refresh()` 换的是全新一批对象，名单和开关两边各维护标记的话必然有一边忘了同步。
- **`mcpServers.<名>.tools` 白名单在**装配时**过滤，不在 connect 时**（`McpManager.rebuildActive`）。
  这个字段一直存在，但只在连接时被读一次 —— 于是界面上根本改不动它（每勾一下重连一次子进程
  不可接受）。挪到装配处附带两个好处：服务器没连上时白名单照样算数，本地工具名也不会随名单变化。
  `undefined`（没写这个键）和 `[]` 是**两种状态**：前者全接，后者一个都不接；合并成一种的话
  「勾掉最后一个工具」会退化成「打开全接」，而界面上这两下长得一模一样。界面**全勾上发的是
  `null`**（= 删掉这个键）而不是那串名字 —— 名单是「挑过」的痕迹，留一份「恰好等于全部」的配置
  会让服务器以后新增的工具接不进来。
  写盘走 `config.ts` 的 `setMcpServerTools` / `setMcpServerToolsAnywhere`，**不能复用
  `writeMcpServer`**：那个接口是整条替换，只传 `{tools}` 会把 `command` / `args` / `env` 一起抹掉。
  它只动 `tools` 一个键，值没变就不写盘（勾一下重写一遍，文件 mtime 一直跳，外面那种「盯配置
  文件变化就重载」的工具会被白刷），返回值的意思是「这条在这份文件里」而不是「字节变了」。
  给界面看的细节一律由主进程出：`status()` 每台带一句 `toolLabel`（`工具 2/3` 只在被卡着时才带
  分母，终端和桌面端共用），工具明细走**按需**的 `mcp/tools/get` 通道进渲染层的 `mcpToolPanel`，
  **不进 `ProjectInfo`** —— 后者每轮刷新都要重算一遍，而工具明细比它大一个数量级。
- **新增表单的「范围」默认全局，agent 的 `scope` 默认项目 —— 这个不一致是有意的**：
  用户填表时眼睛就看着「范围」那一栏，改起来没有成本；agent 是在人不在场的时候动手，
  一次误判就往 `~/.clauda/skills`（或全局 `mcpServers`）里塞东西，波及的是**每一个**项目。
  要全局它会显式说。
- **厂商档案是唯一真源，`provider` 段只剩传输旋钮**（`profiles` + `activeProvider`，
  见 `resolveProfiles`）。`cfg.provider` 是「当前生效那份」的解析视图，所以十来处
  `cfg.provider.model` 的读取点一个字都不用改。遗留字段（老文件里端点还住在 `provider` 段）
  只在内存里**折进同名档案**，绝不写盘；真落笔时由 `ensureProfileShape` 把它们**原样搬**
  进新档案（搬的是磁盘原文，`"${DEEPSEEK_API_KEY}"` 搬过去还是占位符）。
- **改配置一律只对之后新建的会话生效**（`SessionManager` 的类注释）。端点、密钥、模型在
  `openSession` 那一刻就定死了：每个会话有**自己的 provider 实例**，而 `Agent.opts.provider`
  构造后不可变。接口地址 / 默认模型 / 加档案三个入口全是这个语义，活会话一个都不动。
  **加一份档案 ≠ 切过去**（`writeProjectProfile` 绝不改 `activeProvider`）：会改的话
  「同时配好几家」就不成立了 —— 配 B 之前得先把 B 变成当前。真要换是 `writeActiveProfile`，
  界面上对应一个显式按钮，且**缺地址或模型的档案不许设为当前**（否则之后每个新会话都打到
  空 URL）。**当前使用那份也不许删**：删了 `activeProvider` 就指向一个不存在的名字，
  配置会静默退回内置默认值（OpenAI + `gpt-4o-mini`），症状是「什么都没干，请求却换了一家」。
  历史：2026-10 之前端点与厂商是**项目级立刻生效**的（全项目共享一个 provider 实例，
  切厂商还会刷所有活会话的模型 + 重建系统提示词）。那让「切厂商」变成一个会打断正在跑的
  会话的动作，也让同一个设置页要同时讲两套作用范围，于是统一成了现在这一条。
- **智能体是一整套装配配方，一个目录一份 `AGENT.md`**（`src/agents/`，
  `types / registry / writer / apply`，形状逐条照 `src/skills/` 抄）：
  `~/.clauda/agents/<name>/AGENT.md`（全局）或 `<cwd>/.clauda/agents/<name>/AGENT.md`
  项目级（**离 cwd 越近越优先**，扫描顺序与技能同一套）。frontmatter 是标量配置
  （名字 / 描述 / 档案 / 模型 / 温度 / 权限三件 / 工具 / 技能 / 常见问题），**正文就是系统
  提示词那一段**。缺省的语义要分清：`undefined` = 没写这个键（沿用项目当前那份），
  `[]` = 写了但为空；`temperature` 的「写了 0」必须和「没写」分开，所以类型是
  `number | undefined` 而不是 `number`。
  校验取向和技能一致 —— **能退回默认的就退回并继续，不能退的才丢**：名字不合规退回目录名
  （目录名也不合规才整份丢掉）、温度非数字 / 越界只忽略这一项、`tools` / `skills` 里认不出
  的名字**原样保留**（它可能指一个这个项目还没装的 MCP 服务器）。只有 `profile` 指向不存在
  的档案时走「退回项目当前那份 + 在设置页标一句 `problem`」—— 静默换档案会让人对着一个
  「明明配了 DeepSeek 却在跑 Kimi」的会话查半天。
  **两条分隔符约定，别去「统一」**：`tools` / `skills` / `allow` / `deny` 这类**标识符列表
  用逗号**，`questions` 这类**散文列表用 `|`** —— 问题里本来就会带逗号（「跑测试要装什么，
  怎么装？」）。`|` 因此在 `questions` 里是**保留字符**，`writeAgent` 落盘时换成全角 `｜`；
  换行会把单行 frontmatter 撑破，所以每个标量与每条问题都过 `flatten`。**IPC 传的是数组**
  （`agent/add` 收 `string[]`），分隔符是**文件格式**的事、归 `writeAgent` 管 —— 渲染层和
  主进程各写一套 split 迟早分叉。正文里**不许出现 `## 项目记忆` / `## 会话配置`**：
  `repl.ts` 的 `/memory` 切的是**第一处**标题，正文里混进这两个词，提示词看着正常、
  `/memory` 却打印一堆垃圾，所以 `writeAgent` 里直接拒收（段插在记忆段之前是必要但不充分）。
- **会话把「自己是哪个智能体」冻成快照，恢复时绝不按名字重读磁盘**（`SessionRecord.agent`
  存的是解析好的 `AgentSpec`，不是名字）。这和技能 / MCP 的「改了当场对项目里所有会话生效」
  **故意相反**，理由与上面那条「改配置只对之后新建的会话生效」同源：**工具是会话手里拿的
  东西，换了手里就得换；智能体是这段对话的身份，身份不该在对话中途被换掉**。按名字重查会让
  「我把审查员调紧了一点」在**所有**老会话上一起生效，那正是用户选定「改一个智能体只影响
  之后新开的会话」时要排除的。冻结还白捡两件事：删掉一个智能体之后**老会话照样原样打开**
  （它自带配方，不依赖那个目录还在），恢复路径也少一次磁盘 IO。
  同一处：`AgentSpec` 里**绝不能出现 `apiKey` / `baseUrl`** —— 会话文件是磁盘上的明文 JSON，
  而 `config.json` 里的密钥可能正是 `${DEEPSEEK_KEY}` 这种占位符，抄一份进去等于把「密钥只
  留在一处」当面拆掉。端点与密钥照旧在恢复时从**当时的** config 取。
  快照要用一个 `readAgentSpec(v)` 把形状过一遍（缺 `name` 或 `prompt` 就当没有）——
  它是磁盘上的 JSON、手改得坏，而 `isSessionRecord` 刻意不验它。
  **CLI 没有会话级绑定**（也不做 `--agent` 开关）：它只读一次 `config.defaultAgent` 当名字
  去解析，装配配方（`applyAgentToConfig` / `scopedSkills` / `assemble(spec)`）与桌面端同源。
  不这么做的话，桌面端写进项目配置的「本项目默认」在命令行上完全无效，那个键就成了半截功能。
- **「没绑过」和「没有快照」是两件事，恢复路径永远传 `agentSpec: rec.agent ?? null`**。
  传 `null` 而不是省略是**必须的**：省略会落进「新会话」分支去套**当下的**项目默认，于是
  一条从没绑过智能体的旧会话会在用户什么都没点的情况下悄悄变成默认智能体 —— 行为静默改变，
  最难查的一类。`openSession` 的判据因此只有三条路：**`agentSpec` 只要出现过（哪怕值是
  `null`）就按「恢复」处理，快照权威、绝不看 `config.defaultAgent`**；否则拿 `agent` 当名字
  去注册表解析（`''` = 明确不要智能体）；否则就是没有智能体。**主进程没有「没给名字就用
  `defaultAgent`」这条魔法** —— 那个回退太容易咬人，套默认只发生在界面那一格下拉框里。
  名字给过却解析不出来（比如它刚被删掉）**不抛**：按「没有智能体」装配，另给一条
  `SessionInfo.agentWarning` 让通知栏说一声（渲染层按会话 id 去重，`session/state` 是高频的，
  每来一次快照弹一次会把通知栏刷满）。自动恢复的会话不该因为一个删掉的智能体就打不开。
  `applyAgentToConfig` **必须夹在 `structuredClone(entry.project.config)` 与
  `createProvider(config.provider)` 之间** —— provider 构造后不可变，晚一步的症状是
  **提示词说用 A、请求打到 B，且不报错**。
- **工具与技能的白名单必须按会话过滤，不能按项目**（`createToolAssembly` 的 `assemble(agent?)`
  每次拿智能体现算，`refreshProjectTools` 把计算**挪进循环**、各算各的）。同一个项目下两个
  会话可以绑**不同的**智能体，项目级共享一份的话，一个关了 `bash`、另一个还能跑。
  `assemble` 一共四个调用点（建会话 / 广播 / `beginTurnMark` / CLI 的 `repl.ts`），漏一个
  就是「有一个入口不过白名单」。判据复用 `permissions.ts` 的 `normalizeToolName` 加前缀匹配
  （`norm === n || norm.startsWith(n + '__')`，两边都归一化），于是 `mcp__linear` 盖住
  `mcp__linear__create_issue`、`mcp` 盖住所有 MCP 工具 —— 和权限那套 MCP 工具名的约定同源。
  **白名单连 `extraTools`（`skill_write` / `skill_remove` / `mcp_add` / `mcp_remove`）和
  `memory_*` 一起挡**。这是「写了 = 只要这些」的正确读法，但**反直觉、必须写进文档**：
  一个 `tools: read_file, grep` 的智能体不光不能写文件，还不能写技能、写记忆、挂 MCP。
  技能白名单靠一个**委托式的子集视图**实现（转发给项目那份真注册表再按名字过滤），于是
  `skillsSection()` / `makeSkillTool()` 一行没改，真注册表 `refresh()` 之后视图自动跟上。
- **故意没有 `agent_write`**（技能和 MCP 都有「对话里新增」，智能体没有）。它意味着模型能
  给自己写一份 `permission: auto` 的智能体 —— 一个**自我提权**的口子，比 `mcp_add` 那次
  「起个以你自己身份运行的子进程」更直接。要加也得先有一套独立的授权设计。
- **`agent/add` 不触发 `refreshProjectTools`**：改一个智能体只影响之后新开的会话，已开会话
  的工具集一个字不动。这和上面那两条（技能 / MCP 增删**当场**广播）是**相反**的，别看着
  不对称就去补一次广播。设置页那个新增表单的「范围」默认**本项目**（技能 / MCP 的表单默认
  全局），因为智能体文件是可以提交进 git 的、落在项目里才说得通。
- **provider 的 client 在 `stream()` 开头跟 `cfg` 对一次**（`provider/openai.ts` 的
  `syncClient`）。`new OpenAI({ baseURL })` 是构造函数里建好的快照，不同步的话 `cfg` 改了而请求
  发往旧地址，**且不报任何错**（症状是「改了没反应」）。当前这条**永远不会触发** —— 端点冻结在
  会话创建那一刻，会话内没人改 `cfg.baseUrl`/`apiKey`；留着是给「以后允许改本会话端点」兜底，
  别把它当成还在用的机制。`model` 从来不在此列 —— agent 每轮现读 `config.provider.model`。
- **厂商不存字段，由 `baseUrl` 反推**（`provider/vendors.ts` 的 `vendorByBaseUrl`；预置表里
  每个地址互不相同，是单射）。存一个 label 只会多出「文件被手改了、label 与 baseUrl 对不上、
  界面开始撒谎」这种状态。推导**必须在主进程做**：renderer 走 `app://` 协议，`main.js` 的
  目录穿越检查不让它 import 到 `dist/`，所以 `ProjectInfo` 只下发结论（`provider.vendorKey`）
  加整张表（`vendors`），renderer 按 key 查、不判。代价是那个 `'__custom__'` 字面量在
  `session-manager.ts` / `app.js` / `renderer-dom.mjs` 里各有一份，改名要三处一起改。
- **左栏只有一栏**（`index.html` 的 `<aside class="sidebar">`）：品牌 → 导航条 `.rail` →
  设置四项 `#settings-group` → 会话浏览区 `.browse`（项目路径 / 新会话 / 会话列表）→
  底部的设置停靠区 `.settings-dock`。导航条早先是独立的一窄条（76px），2026-10 合了进来 ——
  「看哪个视图」和「看哪个会话」本来就在同一列里点。
  **五个视图共用同一张三列骨架**，`style.css` 里一条 `.app[data-view=…]` 覆盖规则都没有，
  `data-view` 只作为「当前在哪一页」的 DOM 标记留着。所以新加一页不必回去补 CSS 名单
  （那条规矩早没了，别再照着做），但 `state.js` 的 `VIEWS` 仍然要加 —— 它既是视图名又是
  归约时要挡一道的白名单。
  **智能体排在最前面**：它是唯一一项「描述整段对话」的配置，模型 / 技能 / 工具都只是它
  参考的素材。
  **左栏是两套内容，点底部那个「设置」换一次**（用户的原话：「点击设置 隐藏会话相关内容，
  把设置的内容放在左侧列表上方」）：会话视图下是 `.rail`（只有「会话」一项）+ `.browse`；
  四个设置页下换成 `#settings-group`，接的正是原来「会话」那一格的位置，`.rail` 和
  `.browse` 一起让位（`renderRail()`）。
  **「设置开着没有」不是独立状态，等于「`state.view` 是不是 `sessions`」**。曾经有过一个
  单独的 `settingsOpen` 标志，它和视图各真各的，于是存在「分组收着、视图却在技能页」这种
  组合 —— 那时左栏是空的，什么也点不了。别再引第二个标志回来。
  「设置」按钮因此**会切视图**（进 `lastSettingsView`，默认智能体；再点回会话），不再是
  纯粹的展开器。它也是回会话视图**唯一**的路 —— `.rail` 那时是 `hidden` 的。
  `.browse` 里「＋ 新会话」上面那一格 `#new-session-agent` 是**会话级绑定的唯一入口**
  （见上面那条「没绑过 vs 没有快照」）：它**总是带一个具体值**（没选就发空串），所以桌面端
  永远不走「没传 `agent`」那条会去套项目默认的路。`#chat-agent` 显示的是**这一个会话**绑的
  智能体，不是项目的默认值 —— 它因此只能挂在 `SessionInfo` 上（`project/info` 是按 cwd 取的，
  一个字段都不来自具体会话），不能挂到 `.topbar` 上（那是 `space-between` 的两列 flex，
  多一个孩子会把控件整排挤歪）。空态那几条可点问题同理只能取 `SessionInfo.agentQuestions`
  （源自**这份会话冻结的** AgentSpec），回头按名字去 `ProjectInfo.agents` 现查会把刚冻下来的
  东西又变回活的。
  「＋ 新会话」在 `.browse` 里、**不在品牌那一行**：它属于当前项目的会话列表（放这儿才看得出
  「在哪个项目里新建」），虚线边框是和实线会话行区分的——点开已有的 vs 造一个新的。因为它在
  `.browse` 内，设置视图下会跟着一起被摘掉，这与既有的「会话行也点不出结果」一致（`openNewSession`
  同样不切视图），是顺带修好而不是新引入的别扭。`class` 只能是 `.new-session` 不能加 `ghost`
  —— `button.ghost` 的边框色会盖掉虚线。
  两条容易踩的：**底部 `.settings-dock` 里那个「设置」按钮任何时候都不能藏** —— 进了设置页
  之后 `.rail` 和 `.browse` 都是 `hidden` 的，它是回会话视图唯一的路，藏了就真回不去了；
  **每个子元素要写死 `grid-column`**（`display:none` 摘掉子元素后剩下的会自动补位，`.chat`
  会掉进那个 0 宽的列里）。`state.js` 里 `VIEWS` 既是视图名又是 CSS 选择器，拼错了不报错、
  只会让布局静默塌掉，所以归约时要挡一道。徽标（会话数 / 当前模型 / 技能数 / MCP 已连接比）
  编码的是后台状态，别把它退化成纯装饰。
- **`hidden` 属性在这些块上必须配一条显式的 `[hidden] { display: none }`**：`.rail` /
  `.browse` / `.rail-group` 都是作者写的 `display: flex`，和浏览器自带的
  `[hidden] { display: none }` 同为 (0,1,0)，而作者样式排在后面 —— 于是那个 `hidden` 完全
  不起作用，DOM 里看着是真的、屏幕上照样画着。这一条**踩过两次**（先 `.rail-group`，再
  `.rail` / `.browse`），两次都是靠开窗口看才发现，假 DOM 只能验属性、验不出样式。
  代价是「点开设置左边挂着两套内容」。同 `.view[hidden]` 那条弯路 —— 症状一样：**假 DOM
  全绿，真窗口不对**。
- **会话浏览区 `.browse` 是 flex 列且 `flex: 1; min-height: 0`**：它自己不吃掉剩余高度的话，
  里面 `.session-list` 的 `flex: 1` 就没有确定高度可分配，列表不会滚动，只会把整列越撑越长。
- **通知栏（`#notices`）必须待在侧栏之外**，在 `.app` 网格的第二行通栏（`grid-row: 2;
  grid-column: 1 / -1`，空的时 `display:none` 让这一行塌掉）。它早先是侧栏底部的一条，
  而侧栏当时在三个设置视图下是 `display:none`（现在换成 `.browse` 被摘），于是「MCP 开关
  接不上」这种**恰好发生在设置页上**的报错会死在引发它的那一页，一个字都看不到 —— 那正是
  把通道改成 `{ok:false, reason}` 要解决的问题，白修了。**放进 `.browse` 会重演这个 bug**：
  那正是设置视图下唯一被 `display:none` 的那块。别改成浮层：通知不自动消失也没有关闭按钮，
  浮层会常驻盖住输入框（底部正是输入框），要盖住什么才能看见，得先想清楚。
- **通知栏里只放「你刚做了什么、成没成」** —— 也就是渲染层自己那条 `notice()`。主进程
  `onWarn` 那类后台诊断（MCP 连不上、上下文压缩失败）**只打控制台**，一条都不往窗口推：
  它们带的是子进程的原始报错，一屏好几行技术细节，混进这条通栏就是刷屏，而用户要的
  「日志」正是这个。这不算把失败藏起来 —— 连不上的那台在「工具」页上红着并带着错误原文，
  徽标上的已连接数也跟着掉。`tests/unit.mjs`
  末尾有一条结构断言钉着「它不在 `<aside class="sidebar">` 里」（比实际需要更严一档，
  故意留着的余量）。
- **`createProjectRuntime` 必须把 `loadConfig` 包在 `process.env` 快照里**。它内部的
  dotenv 改全局 env 且不覆盖已存在的键，同时开两个项目时后加载的那个 `.env` 会**静默失效**、
  继承前一个项目的配置。还原时只动这次多出来 / 被改写的键，整个替换 `process.env` 会抹掉
  期间别的模块设的键。副作用：项目 `.env` 里的 `CLAUDA_HOME` 不会保留，它得走真实环境变量。
- **列表类接口一律不解析 `messages`**（`listSessionSummaries`）。侧边栏每轮都要刷新一次，
  整份解析全部历史对话会在会话攒多之后卡住。`desktop-app.ts` 里 `session/state` 也不带
  messages 是同一个道理 —— 那个通道每轮都调。
- **落盘时 `createdAt` 要从既有文件读回来**（`persist.ts`）。每轮都写 `new Date()` 的话它
  恒等于 `updatedAt`，「按创建时间排序」整个失真。
- **desktop 的 `preload` 必须是 CJS**（`desktop/preload.cjs`）：沙箱化的 preload 不支持
  ESM，而根 `package.json` 是 `type: module`，所以扩展名不能省。
- **renderer 的模块走 `app://` 自定义协议**（`main.js` 里 `protocol.handle`），不是
  `file://`。`<script type="module">` 在 `file://` 下会被 CORS 拦掉。改这里要同时改
  `registerSchemesAsPrivileged`（必须在模块顶层，晚于 `app.ready` 就无效了）。
- **`desktop/renderer/state.js` 与 `markdown.js` 是纯逻辑，一行 `document` / `window` 都不许有**。
  它们被 `tests/unit.mjs` 直接 import，import 期碰了 DOM 整份单测当场就炸。DOM 绑定全在
  `app.js` 里，那层只能人工看窗口。自检组还有一条源码级的正则护栏，免得等到跑测试才发现。
- **`app.js` 里只有一处 `innerHTML`**（助手气泡，且内容先过 `markdown.js` 的转义），
  其余一律 `textContent`。工具结果和报错里可能有模型输出，**不能当 HTML 塞** —— 那等于
  把 `read_file` 读到的任意文件内容当代码执行。`index.html` 的 CSP 是第二道兜底。
- **消息流是增量画的，别改回全量重绘**（流式输出时会整块闪）。「哪几个节点要重画」由
  `state.js` 的 `streamPlan` 判、有单测和 `renderer-dom.mjs` 两条盯着。这里的失败模式很隐蔽：
  漏画新建节点不会报错，只是切走再切回来前面全是空白。
- **`app.js` 绑的 id 必须和 `index.html` 对得上**。改了一边忘了另一边的话，
  `getElementById` 返回 null，启动时第一个 `addEventListener` 就抛 TypeError，
  窗口一片空白 —— 看着像整个渲染层没生效。自检组里有交叉断言盯着。
- **左栏和页标题叫「工具」，页内正文写「MCP 服务器」**（`index.html` 的 `nav-mcp` 与
  `SETTINGS_META.mcp`）。用户在那一页上装的是「能让 agent 干活的东西」，标题给的就是这个词；
  正文里保留「MCP 服务器」是因为**一个服务器会带出很多个工具**，丢掉这个名字会让
  「服务器连不上」和「工具没接上」变成同一句话。只有标签和标题这两处文本改了 ——
  `id="nav-mcp"`、`VIEWS` 里的 `'mcp'`、IPC 通道名、CSS 选择器一律不动，别顺手「统一」。
- **模型 / 技能 / 工具三个设置页共用 `project/info` 这一份快照**（`session-manager.ts`
  的 `projectInfo`），按 **cwd** 取 —— 里面每一个字段（技能、MCP、上下文、厂商档案）都是
  项目级的，没有一个来自某个会话，所以**一个会话都没开也得有**：技能与 MCP 挂在项目运行时
  上，而配它们正是开第一个会话之前想做的事。这条通道因此**有副作用**，第一次调用会把运行时
  建起来（`ensureProject`，幂等）。
  **项目运行时的生死不跟会话走**：会话开关只加减 `refs`，界面选中的那个目录另外把它钉住
  （`pinnedCwd`）—— 少了这枚钉子，「刚关掉最后一个会话」那个瞬间菜单徽标和三个设置页会一起
  变空。销毁（`dropProject`）要同时满足「没会话用」和「没被选中」两个条件：`ensureProject`
  换目录时会直接调过去，那时 `refs` 可能大于零。而 `disposeAll` 得**单独**收被钉住的那份 ——
  它没有会话引用，`closeSession` 带不走它，漏了就是「关窗之后进程不消失」（MCP 子进程留着）。
  前端那边 `state.project` 也**不再跟着会话清**（切同一项目的会话本来就没变化，清掉只会闪
  一下空态）；点开另一个项目里的会话时，`cwd` 与项目信息要一起跟过去，否则设置页显示的
  是上一个项目的样子。
  设置页在 `app.js` 里**按指纹增量重建**（同 `renderModal` 那套），没有这道判断的话
  流式输出期间每一帧都会重画整块，「默认模型」输入框当场失焦。**反过来也有坑**：MCP
  开关失败时服务器状态没变、指纹就不变，光重拉会判定「无变化」直接返回，开关停在用户
  刚拨过去的那一侧 —— 正是这次要修的那个谎，所以失败路径要显式作废指纹。
- **厂商那一块是左选右配，而「选中」不是「当前使用」**（`app.js` 的 `vendorPane`）。
  左栏点一行只换**正在编辑哪一份**（`selectedProfile`，纯界面状态），一个请求都不发；
  真正的切换只有右栏那个显式的「设为当前使用的厂商」。把两者合并（点谁就切谁）会让
  「同时配好几家」立刻不成立 —— 想改 B 的地址得先把 B 变成当前。两个状态在指纹里各占
  一格（`selectedProfile` **加上** `project.activeProvider`），少一个的症状是「点了左栏，
  右栏纹丝不动」。指纹里那份 `profiles` 摘要要带上 `baseUrl`：只比对 key 的话，改完
  地址界面不重画，看着像没保存。删档案走**两步内联确认**（`pendingRemove`，也进指纹），
  不复用 `renderModal` —— 那个宿主被授权请求用 `dataset.key` 占着。
- **技能页和 MCP 页各有一个内联的新增表单**（`skillFormBlock` / `mcpFormBlock`），
  同样不弹窗：`renderModal` 是授权专用的（无参无返回值，内容全由选中会话的 `pending`
  推出来）。两条容易踩的：表单里**正在输入的值绝不能进指纹** —— 值存在模块级的
  `skillForm` / `mcpForm` 里以便重画时回填，而任何一次 `replaceChildren` 都会把输入框连焦点
  一起抖掉，那正是这套增量重绘存在的理由（测试用**节点同一性**钉死这条：无关的 dispatch 之后
  `输入框还是同一个对象`）；两个删除各自用独立的 `pendingSkillRemove` / `pendingMcpRemove`，
  不复用 `pendingRemove`（那是厂商档案的 key，撞名会让 A 页的确认框跑到 B 页）。
  空态下表单也得在（提前 return 的话，「一条都没有」时唯一的出路就没了）。
- **展示文案不要在这里另造**：MCP 开销提示走 `src/runtime/mcp-cost.ts` 的
  `infoText` / `warnText`（纯文本、不含 ANSI，CLI 与桌面端共用），技能空态抄
  `repl.ts` 里 `/skills` 那句。两处各写一套的话，改了阈值或口径没人会想起来去对齐另一边。
- **MCP 行右侧那个数印 `server.toolLabel`，别在渲染层拼 `工具 ${toolCount}`**：它现在会带
  分母（`工具 2/3` = 被白名单卡着），措辞归主进程，渲染层只摆位置。「挑选工具」展开出来的
  明细是**按需**取的（`mcp/tools/get` → 模块级的 `mcpToolPanel`），所以**展开态、取没取到、
  取回来几条都要并进 `mcpFingerprint`** —— 少一个的症状是「点了三角纹丝不动」。那个按钮
  **不能挂 `.form-open`**：测试靠这个类名找「+ 新增」的三角，多一个同名的会把第一次匹配抢走。
  开关的顺序也是契约（`children[0]`），新加的东西一律往后追加。

## 测试

`tests/e2e.mjs` 在**进程内**起 mock 服务端再把 CLI 当子进程跑，不依赖真实 API Key，
也不要试图改成后台 `node mock-server.mjs &` —— 之前那样写过，旧进程占着端口导致改动没生效，
排查了很久。mock 服务端按「最后一条消息的 role」决定返回 tool_call 还是文本，
不要改成「消息里有没有 tool 结果」，多轮对话下会错。

`tests/mock-mcp.mjs` 是无依赖手写的 stdio MCP 服务器，`tests/mock-mcp-http.mjs` 是 HTTP 版
（拆成两个文件是因为「怎么被启动」不同：stdio 那个得能被 spawn，HTTP 那个是进程内起的）。
理由同上：装一套 SDK 只为了测协议会被 SDK 自己的行为带偏，升级时测试也跟着动。
协议版本一律**回显客户端请求的那个**，这样 MCP 升级默认版本时它不会突然连不上。

**MCP 的 HTTP 传输只能在 e2e 里验，不能写进 `tests/unit.mjs`**。进程内跑完一次 HTTP MCP
往返之后立刻 `process.exit`，Windows 上会撞 libuv 的 handle 断言
（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... win\async.c`）直接 abort，
退出码 127 把 `npm test` 的链断掉。跟服务器关不关没关系（`closeAllConnections` 也救不了），
是客户端那边还没收敛完；加 `setTimeout` 只是把问题往后推，实测 10ms 不够、50ms 才行，
这种「睡够久就没事」的断言迟早会在慢机器上翻车。跨进程就干净了 —— 真 CLI 接 HTTP
MCP 服务器退出码是 0，只有同一个 tick 里连着退出才会炸。
**MCP 那节之外的 e2e 用例必须保持在不带 `mcpServers` 的 home 下** —— `TMP_HOME` 是共享的，
往里面写配置会干扰其余用例。

## 桌面端

`npm run mock` 起假服务端，另开一个终端 `npm run desktop`。布局是三栏：左栏自上而下是
品牌、导航条（会话视图下只有「会话」一项，带进行中会话数）、当前项目与会话列表
（列表顶上依次是「用哪个智能体」的下拉框和一条虚线的「＋ 新会话」，下面按项目分组，
状态点是空闲 / 运行中 / 等待授权），最底下钉着「设置」；点它之后左栏整个换成设置四项
（智能体 / 模型 / 技能 / 工具，每项带实时徽标），会话那两块让位。中栏对话，顶栏标题右边
一格 `#chat-agent` 写着这个会话绑的智能体，消息流与输入框之间是**新会话空态的可点问题**
（点一条就当作发出去，不经过输入框）；右栏改动文件与待办。最底下还有一行通栏的通知栏，
没通知时整行塌掉。配色是**中性白**（`#f8f9fb` 底 / `#ffffff` 浮起），赤陶 accent 沿用了
更早暗色版的家族（白底上压深到 5.4:1）。
斜杠命令不做成输入框 —— `/model` 和 `/mode` 是中栏顶栏的控件，`/compact` 自动触发。
窗口**没有菜单栏**（`main.js` 里 `Menu.setApplicationMenu(null)`），文件 / 编辑 / 视图
那几项一个都用不上，白占一条。**那一行必须带 `process.platform !== 'darwin'`** ——
macOS 的 Cmd+Q / Cmd+H / Cmd+W 和复制粘贴都从菜单项的角色来，摘了等于把「退出」一起摘了。
Windows / Linux 上不受影响：可编辑元素里的 Ctrl+C/V/X 由 Blink 自己处理，不经过菜单的
加速键（已用真键盘事件验过：摘掉菜单后 Ctrl+V 照常把中文粘进输入框）。
底部的写作区是一张卡片（`.composer`）：左右各留 16px 和 `.stream` 的边距对齐，textarea
的 `min-height` 约三行。**随内容长高的上限 200px 在 `app.js` 和 `style.css` 里各写死了一份，
改一处要改两处。** 卡片自己就是输入框的样子，里面的 textarea 不画边框、不填底色 ——
焦点环由 `.composer:focus-within` 出（`textarea:focus` 的 `outline: none` 是全局规则，
两者不冲突，也不会出现里外两道环）。

```
desktop/                    薄壳，纯 JS，不在 tsconfig 的 rootDir 覆盖内
  main.js                   建窗口 / 注册 IPC / webContents → EventSink
  preload.cjs               contextBridge 暴露 window.clauda（必须 CJS）
  renderer/
    index.html  style.css   三列骨架（左栏 + 中栏 + 右栏 + 底部通知行），五个视图共用，data-view 只作标记
    state.js                纯归约 reduce(state, action)，单测直接 import
    markdown.js             最小 markdown → HTML（先转义再套标签）
    app.js                  DOM 绑定 + 流式增量更新
src/runtime/                全部逻辑，不依赖 Electron，被 tsc 和测试覆盖
  tools-assembly.ts         工具装配配方（CLI 与桌面端同源，否则两边会漂）
  mcp-cost.ts               MCP token 占比提示（纯文本，ANSI 颜色留给 CLI 包）
  ipc-view.ts               IpcView implements View
  permission-bridge.ts      授权 Promise 桥：requestId 防陈旧回复、denyAll 兜底
  session-manager.ts        Map<sessionId, Session> + Map<cwd, Project>（引用计数 + 界面选中的钉住）
  project.ts                createProjectRuntime：按 cwd 建 config / 技能 / 智能体 / MCP（provider 归会话）
  desktop-app.ts            channel 分发层（无 Electron），main.js 只是它的薄适配
  persist.ts                落盘，CLI 与桌面端共用
  attachment.ts             用户附件的归一化与校验（ingest 碰 fs / sanitize 纯函数）
```

**channel 一律返回 `{ ok, reason? }` 而不是抛异常**：IPC 那头的 catch 拿不到堆栈，
抛出去 renderer 只会看到一句 `Error invoking remote method`，什么都定位不了。
`desktop-app.ts` 的 `handle` 因此把整个 switch 包在 try 里。

**renderer 的消息流是「条目」数组而不是「消息」数组**：助手的一段话、一张工具卡片、
一条报错在界面上是三种不同的东西，硬塞进同一种结构渲染层还得再判一次类型。

**`messages-restored` 是整份替换，`session-state` 只并字段**。前者是打开历史会话
（要的就是「回到当初的样子」），后者每轮结束都会来一次且**不带 `items`** ——
整份替换会把整个消息流冲掉。

`tests/desktop-driver.mjs` 是桌面端最有价值的一条回归：它用子进程跑完两个会话并行 +
授权往返 + 恢复 + 退出，打印一行 JSON 给 `e2e.mjs` 断言。加桌面端功能时先看它。
它的会话 cwd 是临时目录（`write_file` 会真落盘，写进仓库根目录就污染工作区了）。

存快照时走那个 `snapshot()` 辅助函数（`structuredClone(await app.handle(...))`），**别直接存
`app.handle` 的返回值**：真实链路上 `ipcMain.handle` 会把返回值结构化克隆一份给 renderer，
而驱动里是直接调用 —— 拿到的和主进程里是**同一个对象**。`ProjectInfo.skills` 直接就是注册表
内部那个数组，后面「再把技能打开」会在驱动打印 JSON 之前把它改回去，于是早期快照看着是**最终**
状态：按中间状态写的断言会红（`disabled === true` 那条就是这么红的），按最终状态写的却可能因为
**中间那一步压根没生效**而假绿。同一类陷阱在 `session/state` 的 `tools` 上同样成立。

**附件在「添加的那一刻」就 ingest，不是发送时**。三条入口（拖拽 / 粘贴 / 选文件）都先走
`attachment/ingest`，字节在这一步读成 data URL 回到 renderer —— 缩略图、「图片太大」、
「没有磁盘路径」因此都是即时反馈，而不是发出去才失败。`session/send` 收到的已经是那份
归一化好的描述符，只核形状不再读盘。

**「是不是图片」看字节，不看名字**：`ingestAttachments` 与 `sanitizeAttachments` 都用
`sniffImage` 认魔数，**data URL 的 mime 一律以嗅出来的为准**，调用方声明的 `mime` / 扩展名 /
`data:image/` 前缀只用来分流。所以没有「扩展名 → mime」的表（`.jpg` 里装 PNG 时它只会给出
错标签）。理由是把一个改名成 `.png` 的文本发出去，端点会回 400，而用户看到的是
`errors.ts` 那句「这个端点不支持图片输入」—— 一句把人引到换模型上去的假话。
`desktop/renderer/app.js` 那条 `dataUrl` 兜底是 **renderer 送进来的字符串**，同一条规矩。

拖拽监听挂在 `els.app` 上而**不是 `window`**：假 DOM 的 `El` 没有 `window.addEventListener`，
挂上去整份渲染层单测当场跑不起来。同理粘贴挂在 `els.input` 上。

`tests/renderer-dom.mjs` 是一层够用的假 DOM，让 `unit.mjs` 能在 Node 里把 `app.js`
真跑一遍（`renderStream` / `paint` / `renderModal`）。**它不是浏览器实现的替代品**：
布局、样式、真实事件派发一概不管，开窗口看这一步省不掉。它只保证「该画的都画了」——
这一条纯逻辑单测盯不到，而漏画的症状（切走再切回来前面全是空白）看着像对话丢了，
不像渲染漏了。写这层的断言时**别只断言节点个数** —— 出 bug 时个数照样对，只是内容是空的。
另一个坑是 `unit.mjs` 里那个 `find()`：找不到时给的是 **`null`**，`check(..., x === undefined)`
会**永远为真**。这种「测了等于没测」的绿灯比红灯更费时间，拿捏不准就顺便断言一下正例。

## 已知坑

- REPL 的输入用「事件队列 + 等待者队列」自己管，**不能用 `rl.question()`**：
  管道输入会在提问注册前就把 'line' 事件走完，readline 直接丢掉，表现为瞬间 EOF 退出。
- **管道输入的第一行不会被回显**：readline 的 'line' 是异步派发的，`readLine()` 被调用时
  队列还是空的，于是走了等待分支（`rl.prompt()` 已经打过提示符），第二行起才命中
  「队列里已有」的 echo 分支。写 e2e 时别拿 stdout 断言管道进去的第一行 —— 查会话文件。
- **在本机（控制台代码页 936）用 bash heredoc 写测试脚本要小心**：命令字符串到达 bash 时
  已经是 GBK，写进 `.mjs` 的中文字面量会变成非法 UTF-8 源码（报 `Invalid or unexpected
  token` 或渲染成乱码）。测试脚本、fixture 一律用 Write 工具写。
- **改完 `desktop/renderer/style.css` 刷新窗口看到的可能还是旧样式**：`app://` 背后是
  `net.fetch(file://…)`，Chromium 会把它缓存住，`location.reload()` 拿不到新文件。
  用 CDP 目视验收时要 `Network.clearBrowserCache` + `Page.reload({ignoreCache:true})`，
  否则验的是上一版样式（`getComputedStyle` 一查就露馅）。挂载在 `app://` 会话上的
  旧样式会让元素定位整个错位，看着像 CSS 写错了。
  同一个坑还会以另一种面目出现：**用 heredoc 写 `.md` 测试数据也会写成 GBK**，而
  `readFileSync(..., 'utf8')` 读出来是一片乱码 —— 会被误判成「clauda 有编码 bug」。
  实测字节：heredoc 写「审查」是 `c9 f3 b2 e9`，Write 工具写才是 `e5 ae a1 e6 9f a5`。
  排查这类乱码先 `od -t x1` 看字节，别先怀疑代码。
- **`bash` 工具的输出要嗅探编码**，否则中文命令的结果在会话里显示成 `�`（模型看到的
  也是乱码）。中文 Windows（代码页 936）上 `cmd.exe` 的原生工具（certutil、findstr、
  ipconfig…）按控制台代码页吐 GB18030，而 node / python / Git Bash 的 coreutils 吐 UTF-8
  —— **同一个工具前后两条命令可以是两种编码**，所以只能看字节，不能按平台猜。
  判据（`sniffBytes`）和流式解码器都在 `util/console-decoder.ts`，stdin 那条路共用前者。
  两个要点：**stdout 和 stderr 各持一个解码器**（共用的话一个流末尾那半截字符会和另一个流
  的字节拼起来）；**别把「解不通 UTF-8」直接当成 GB18030** —— 管道按块给数据，一个汉字的
  三字节经常被切成 `e4 | b8 ad`，那是 `incomplete`、要等下一块，混为一谈会让每个被切开的
  汉字变成一个错字，也就是**又一种乱码**（`sniffBytes` 的 cut 循环允许砍到空就是为了这个）。
  没定调之前只放 ASCII 前缀出去，纯英文命令（`git status`）照旧一块一块地出字。
- **读文件一律按 UTF-8**（`CLAUDA.md`、`SKILL.md` 都一样），只有 stdin 的管道输入和
  `bash` 工具的子进程输出有 GB18030 兜底。用户在本机用记事本存成 ANSI 就会读成乱码。
  要不要给文件读也加编码探测是个
  独立决定，别顺手加 —— 会牵动记忆那一层。
- frontmatter 解析器（`skills/frontmatter.ts`）刻意**只支持单行 `key: value`**，嵌套、列表、
  块标量、行内 `#` 注释一概不认。**遇到不认识的一律降级，绝不抛异常** —— 坏一个技能不该
  中断整个会话，这是所有读取路径的统一原则（`loadMemory` 同）。围栏没闭合时当作「没有
  frontmatter」而不是「正文到结尾」，否则正文会被整段吞掉。
- **MCP SDK（v2）在解析 `tools/list` 结果时就强校验 schema**，比协议规范还严：
  `inputSchema.type` 必须是字面量 `"object"`。**一个不合规的工具会让整个服务器的工具列表
  被丢弃**，不是跳过那一个 —— 报错长这样：`Invalid result for tools/list: ... "path":
  ["tools", 1, "inputSchema", "type"]`。所以 `mcp/tool.ts` 里那个「补 `type: 'object'`」
  只是兜底，正常路径走不到；单测要验它得直接调 `makeMcpTool`。
- **stdio 传输必须显式传 `stderr: 'pipe'`**。默认是 `'inherit'`，会把 npx 下载进度之类的
  噪音直接倒进 clauda；而且只有 `'pipe'` 才会建出 `transport.stderr` 让我们收集失败原因。
  **不能自己做 `Writable` 塞给 `spawn` 的 stdio** —— Windows 上 Node 只接受带底层句柄的流，
  会直接报 `The argument 'stdio' is invalid`。收集流时还必须真的读走，否则缓冲满了会
  反向施压把子进程卡住。
- **`fail()` 必须保持同步的 `never`**，不能改成 `async` 再 `await`。TS **不会**因为一个
  被 await 的调用返回 `Promise<never>` 就认为后续代码不可达，改了会当场崩出一片
  TS2345 / TS18047。没有 await 余地才需要 `McpManager.closeAllSync()`（直接杀 pid）——
  它是兜底不是主路径，对 `npx` 这种自己还会再 spawn 一层的命令可能留下孙进程。
- readline 的 prompt 不能用 ANSI 转义（会导致换行位置算错），保持纯文本。
- 工具输出的路径统一转成正斜杠，否则 Windows 上 `src\a.ts` 跟模型拿到的 `src/**` 模式对不上。
- 上下文窗口设得极小时压缩会反复触发，靠 `messagesAtLastCompact` 冷却挡掉。
- **压缩治不了「单轮内被一个大工具结果顶爆」**：那种情况下要压的内容全堆在历史末尾，
  摘掉头部省不下多少。这是设计上的边界，不是 bug —— 真正的解法是工具结果封顶（见上）。
  `compact()` 里 `MIN_HEAD_TOKENS` 就是为此设的：头部太小干脆不压，免得摘要请求
  比省下来的还贵。
- 压缩后**消息条数不一定变少**（摘要是「1 条换 2 条」），该看的是 `contextTokens()` 降没降。
  写测试时别拿条数当断言。
- **按字节截断多字节文本，不能靠「丢掉尾部续字节」来对齐字符边界**
  （`memory-store.ts` 的 `truncateBytes`）。看着很自然，其实会一路吃光前面所有字符：
  **一个完整字符的末字节同样满足 `10xxxxxx`**，后退一步就退回了上一个字符的尾巴，于是
  一直退到只剩开头几个 ASCII。正确做法是从后往前逐个序列判断「这个序列整个落在切点内吗」。
  测试断言里那条「截断后仍有 1000+ 字符」就是专门盯着这个失败模式的 —— 只断言「没有 `�`」
  的话，被吃成空串的版本照样能通过。
- **`edit_file` 的 `new_string` 用 `requireStringOrEmpty`，不是 `requireString`**：
  显式传空串是合法意图（就是要删掉这段），而「压根没传」必须报错 —— 两者都落到空串的话，
  模型漏参数会把匹配到的原文**静默删掉**。这是唯一需要区分「缺失」和「空」的参数，
  别看着和其它工具不一致就去「统一」它。
- **`ToolCall.args` 运行期可能是 `null` / 数字 / 数组**，类型 `Record<string, unknown>`
  只是声明。provider 侧已经把这些形状转成 `_parseError`，但 `runOneTool` 里读 `args`
  前仍要收窄一次：那个读取点在工具循环的 `try` **之外**，抛出去会把整轮对话打挂，
  而不是变成一条工具错误结果。
- 记忆库正文用字节封顶（4KB）而不是字符数，中英混写下字符数根本约束不住体积；
  索引也一样按字节截断，两处都走 `truncateBytes`。
- **`WireMessage.content` 是 `string | ContentPart[]`，任何「假定它是字符串」的读取点都必须
  先过 `src/util/message.ts` 的 `messageText()`**。直接 `.split` / `estimateTokens` 在数组上
  会抛（`for (const ch of text)` 里 `ch.codePointAt` 是 undefined），而 `.slice` /
  `textContent` 那一类**不抛、只是静默变成 `[object Object]`** —— 后者更难查，因为它不报错。
  两档要分别设断言：崩的那条（`messagesTokens` 经 `contextTokens()`）钉「不抛且不爆表」，
  静默的那几条（`summarize` / `deriveTitle` / `state.js`）钉「字符串里不出现 `[object Object]`」。
  `string` 留在联合类型里是**刻意**的：老会话文件、工具结果、系统提示词、压缩摘要因此全都不用改。
- **图片按固定值 `IMAGE_TOKEN_ESTIMATE`（1200）计 token，绝不能写成「base64 长度 / 4」**：
  后者对一张 2MB 的图会算出约 70 万 token，`contextTokens()` 当场超过 `contextWindow`，
  压缩每轮都触发、上下文条永远顶格。要的是「模型看到多少信息」，不是「传了多少字节」。
  和 `estimateTokens` 一样刻意粗糙，只用于触发压缩。
- **Electron ≥32 删掉了 `File.path`**，拖拽 / 粘贴来的 File 只能经
  `webUtils.getPathForFile()` 拿磁盘路径。它是**同步**的，且对**没有磁盘来源**的 File
  返回**空串**（截图工具、网页里复制的图片都是这一类），对非 File 对象**会抛** ——
  调用点必须包 try。没有磁盘路径时由 renderer 自己 `FileReader` 读成 data URL 兜底，
  这是渲染层唯一一处碰字节的地方（它拿不到 fs）。
- **拖文件到窗口上，Chromium 的默认行为是导航到那个 `file://`**，整个 UI 被顶掉且没有回退
  路径。`main.js` 的 `will-navigate` 守卫 + `setWindowOpenHandler` 就是为此加的，
  不是可选的加固。写 UI 用例时别只看「chip 出现了」，还要看窗口没换页。
- 写桌面端 e2e fixture 时注意**别把请求发到真厂商的地址上去**：`project/set-vendor`
  之后 provider 真的会往新 baseUrl 发请求（实测撞回 `api.deepseek.com` 的 401），
  所以涉及真实发送的用例必须排在切厂商**之前**。
