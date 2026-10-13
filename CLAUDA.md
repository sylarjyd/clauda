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
- **MCP 子进程必须关掉**（`McpManager.closeAll()`）。`StdioClientTransport` 起的子进程会让
  事件循环一直活着，忘了关的表现是 `/exit` 之后**卡住不返回**而不是报错。三个出口都要接：
  REPL 的 `onExit`、无头模式的 `shutdown()`、以及 `SIGTERM` 兜底。
  故意**没接 `SIGINT`** —— 双击 Ctrl+C 归 readline 的 `rl.on('SIGINT')` 管，两边都接会打架。
- **系统提示词的段落顺序即语义**，新段落一律插在 `## 项目记忆` 之前。两处依赖这个顺序：
  `repl.ts` 的 `/memory` 靠 `split('## 项目记忆')[1].split('## 会话配置')[0]` 取项目记忆，
  往这两个标题之间插任何东西都会弄坏它；测试里也有对应的回归断言。
  当前顺序：`coreIdentity → environment → toneAndStyle → toolGuidance → modeGuidance →
  skillsSection → memoryIndexSection → memorySection → configSection`。
- **记忆只注入索引，正文一律不进提示词**（`memoryIndexSection` 只输出 name/description/type）。
  记忆库是无限增长的，正文一旦进提示词就是每轮都付。单测有「索引里不含正文」的断言
  盯着这条，别为了「让模型少调一次工具」把正文塞进去。
- **工具想改系统提示词，靠 `Tool.invalidatesPrompt` 声明，不要在 agent 循环里判断工具名**。
  目前只有 `memory_write` 用：不重建提示词的话，模型刚写下的事实当轮自己都看不见。
  代价是这一轮 `messages[0]` 变了、会打断后端的提示词前缀缓存，所以只在真写了记忆时触发。
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
- **写配置文件只能改磁盘上的原始文本，不许拿 `loadConfig()` 的结果回写**
  （`config.ts` 的 `writeProjectModel`）。`loadConfig` 内部的 `expandEnvRefs` 已经把
  `${MY_KEY}` 换成了真实密钥，拿它回写等于把密钥明文落盘 —— 这是数据泄露，不是格式问题。
  同一处：改了默认模型还要**同步内存里的 `project.config`**，因为 `openSession` 走的是
  `structuredClone(project.config)`，只写文件的话已开着的项目新建会话仍拿旧模型
  （表现是「改了没生效」）；文件解析不了时**报错返回、不覆盖**，别为了容错丢掉整份配置。
- **左侧导航条同时是状态脊**（`index.html` 的 `.rail`），四个视图 `sessions / model /
  skills / mcp` 由 `.app[data-view]` 驱动 grid 模板切换（会话视图四列，设置视图两列）。
  两条容易踩的：**每个子元素要写死 `grid-column`**（`display:none` 摘掉子元素后剩下的会
  自动补位，`.chat` 会掉进那个 0 宽的列里）；`state.js` 里 `VIEWS` 既是视图名又是 CSS
  选择器，拼错了不报错、只会让布局静默塌掉，所以归约时要挡一道。徽标（会话数 / 当前模型 /
  技能数 / MCP 已连接比）编码的是后台状态，别把它退化成纯装饰。
- **通知栏（`#notices`）必须待在侧栏之外**，在 `.app` 网格的第二行通栏（`grid-row: 2;
  grid-column: 1 / -1`，空的时 `display:none` 让这一行塌掉）。它早先是侧栏底部的一条，
  而侧栏在三个设置视图下都是 `display:none`，于是「MCP 开关接不上」这种**恰好发生在设置页
  上**的报错会死在引发它的那一页，一个字都看不到 —— 那正是把通道改成 `{ok:false, reason}`
  要解决的问题，白修了。别改成浮层：通知不自动消失也没有关闭按钮，浮层会常驻盖住输入框
  （底部正是输入框），要盖住什么才能看见，得先想清楚。`tests/unit.mjs` 末尾有一条结构断言
  钉着「它不在 `<aside class="sidebar">` 里」。
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
- **模型 / 技能 / MCP 三个设置页共用 `project/info` 这一份快照**（`session-manager.ts`
  的 `projectInfo`），按**会话**取 —— 技能与 MCP 都挂在项目运行时上，而运行时是开会话
  时才建出来的。切换会话要先把它清成 `null`，否则会拿上一个项目的配置顶上。
  设置页在 `app.js` 里**按指纹增量重建**（同 `renderModal` 那套），没有这道判断的话
  流式输出期间每一帧都会重画整块，「默认模型」输入框当场失焦。**反过来也有坑**：MCP
  开关失败时服务器状态没变、指纹就不变，光重拉会判定「无变化」直接返回，开关停在用户
  刚拨过去的那一侧 —— 正是这次要修的那个谎，所以失败路径要显式作废指纹。
- **展示文案不要在这里另造**：MCP 开销提示走 `src/runtime/mcp-cost.ts` 的
  `infoText` / `warnText`（纯文本、不含 ANSI，CLI 与桌面端共用），技能空态抄
  `repl.ts` 里 `/skills` 那句。两处各写一套的话，改了阈值或口径没人会想起来去对齐另一边。

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

`npm run mock` 起假服务端，另开一个终端 `npm run desktop`。布局是一条窄导航条加三栏：
导航条（会话 / 模型 / 技能 / MCP，每项带实时徽标）、左栏会话列表（按项目分组，状态点是
空闲 / 运行中 / 等待授权）、中栏对话、右栏改动文件与待办。最底下还有一行通栏的通知栏，
没通知时整行塌掉。灰阶是浅色暖调，赤陶 accent 沿用了原来暗色版的家族（白底上压深了一档）。
斜杠命令不做成输入框 —— `/model` 和 `/mode` 是中栏顶栏的控件，`/compact` 自动触发。

```
desktop/                    薄壳，纯 JS，不在 tsconfig 的 rootDir 覆盖内
  main.js                   建窗口 / 注册 IPC / webContents → EventSink
  preload.cjs               contextBridge 暴露 window.clauda（必须 CJS）
  renderer/
    index.html  style.css   四列骨架（导航条 + 三栏 + 底部通知行），靠 data-view 切列数
    state.js                纯归约 reduce(state, action)，单测直接 import
    markdown.js             最小 markdown → HTML（先转义再套标签）
    app.js                  DOM 绑定 + 流式增量更新
src/runtime/                全部逻辑，不依赖 Electron，被 tsc 和测试覆盖
  tools-assembly.ts         工具装配配方（CLI 与桌面端同源，否则两边会漂）
  mcp-cost.ts               MCP token 占比提示（纯文本，ANSI 颜色留给 CLI 包）
  ipc-view.ts               IpcView implements View
  permission-bridge.ts      授权 Promise 桥：requestId 防陈旧回复、denyAll 兜底
  session-manager.ts        Map<sessionId, Session> + Map<cwd, Project>（引用计数）
  project.ts                createProjectRuntime：按 cwd 建 config / provider / MCP
  desktop-app.ts            channel 分发层（无 Electron），main.js 只是它的薄适配
  persist.ts                落盘，CLI 与桌面端共用
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

`tests/renderer-dom.mjs` 是一层够用的假 DOM，让 `unit.mjs` 能在 Node 里把 `app.js`
真跑一遍（`renderStream` / `paint` / `renderModal`）。**它不是浏览器实现的替代品**：
布局、样式、真实事件派发一概不管，开窗口看这一步省不掉。它只保证「该画的都画了」——
这一条纯逻辑单测盯不到，而漏画的症状（切走再切回来前面全是空白）看着像对话丢了，
不像渲染漏了。写这层的断言时**别只断言节点个数** —— 出 bug 时个数照样对，只是内容是空的。

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
- **读文件一律按 UTF-8**（`CLAUDA.md`、`SKILL.md` 都一样），只有 stdin 走管道时有 GB18030
  兜底。用户在本机用记事本存成 ANSI 就会读成乱码。要不要给文件读也加编码探测是个
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
