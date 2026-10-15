/**
 * 桌面端驱动：走 `desktop/main.js` **完全相同的那条代码路径**（`dist/runtime/desktop-app.js`
 * 的 channel 分发），只是把 renderer 换成一个脚本化的假消费者 —— 收到授权请求就自动
 * 点「允许」。跑完把结果以 JSON 打到 stdout，由 `tests/e2e.mjs` 断言。
 *
 * 这是整个桌面端改动里最有价值的一条：它证明「桌面端没有一行逻辑活在测试够不着的地方」。
 * 窗口、preload、DOM 那些只能人工看的薄壳之外，全部行为都在这里被跑过一遍。
 *
 * 放在 e2e 而不是 unit：CLAUDA.md 记过「进程内跑完一次 HTTP 再立刻 process.exit 会在
 * Windows 上撞 libuv 的 handle 断言」，而 e2e 本来就是跨进程跑 HTTP 的。
 *
 * 用自己 mkdtemp 出来的 home，而不是共享的 TMP_HOME —— 那条 home 里不能有 `mcpServers`
 * （CLAUDA.md），而且这个用例会往 home 里写会话文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockServer } from './mock-server.mjs'

const PORT = Number(process.env.DESK_PORT ?? 8918)
const dist = new URL('../dist/', import.meta.url).href
/** 仓库根。`mcp/add` 那条路要起一个**真的**子进程，只能拿仓库里那份 mock 当目标 */
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 一张真的 1×1 PNG。附件那条路要么读到真字节、要么什么都没验到，所以现编一个 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-home-'))
// 会话的 cwd 必须是个临时目录：write_file 会真落盘，写进仓库根目录就污染工作区了
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-proj-'))
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'deskdemo' }), 'utf8')
// 预先放一份项目配置，用来验「写回时只动被指定的那个键」：
//   - `${CLAUDA_API_KEY}` 是**原文**，写回后必须还是原文（展开了就成明文密钥落盘）
//   - `provider` 段里只剩传输旋钮（`timeoutMs`），端点字段住在档案里 —— 这正是
//     这次改动之后的磁盘形状，写回时**不许**把旋钮一起搬进档案、也不许碰 `mcpServers`
// 空对象 `mcpServers` 不会真的起服务器，所以下面的「MCP 列表为空」那条不受影响
fs.mkdirSync(path.join(projectDir, '.clauda'), { recursive: true })
fs.writeFileSync(
  path.join(projectDir, '.clauda', 'config.json'),
  JSON.stringify(
    {
      profiles: {
        default: { baseUrl: `http://localhost:${PORT}/v1`, apiKey: '${CLAUDA_API_KEY}', model: 'desk-model' },
      },
      activeProvider: 'default',
      provider: { timeoutMs: 20000 },
      mcpServers: {},
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

// 必须在 import dist 之前设好：claudaHome() 读的就是这个变量
process.env.CLAUDA_HOME = home
process.env.CLAUDA_BASE_URL = `http://localhost:${PORT}/v1`
process.env.CLAUDA_API_KEY = 'mock'
// 特意用一个非默认的模型名：中栏顶栏的模型选择器读的就是这个字段，
// 断言它对得上才能证明配置真的一路传到了会话快照里
process.env.CLAUDA_MODEL = 'desk-model'

const out = {
  ok: false,
  error: null,
  warnings: [],
  sessionIds: [],
  initialProjects: null,
  send: {},
  noteWritten: false,
  noteContent: null,
  opened: {},
  tools: {},
  projectInfoNoSession: null,
  projectInfo: null,
  mcpToggle: null,
  badResume: null,
  badOpen: null,
  strayFile: null,
  setDefaultModel: null,
  openedAfterModel: null,
  configOnDisk: null,
  addProfile: null,
  configAfterAdd: null,
  projectInfoAfterAdd: null,
  setVendor: null,
  configAfterVendor: null,
  projectInfoAfterVendor: null,
  openedAfterVendor: null,
  badVendor: null,
  configAfterBadVendor: null,
  removeActive: null,
  configAfterRemoveActive: null,
  skillAdd: null,
  skillFile: null,
  projectInfoAfterSkill: null,
  stateAfterSkill: null,
  skillAddGlobal: null,
  globalSkillFile: null,
  badSkill: null,
  escapedSkill: null,
  skillRemove: null,
  skillGone: null,
  skillRemoveMissing: null,
  projectInfoAfterSkillRemove: null,
  skillDisable: null,
  skillDisableFiles: null,
  projectInfoAfterSkillDisable: null,
  stateAfterSkillDisable: null,
  skillFileAfterDisable: null,
  skillDisableProject: null,
  skillDisableProjectFiles: null,
  skillEnable: null,
  skillEnableFileContents: null,
  projectInfoAfterSkillEnable: null,
  stateAfterSkillEnable: null,
  skillDisableMissing: null,
  mcpAdd: null,
  configAfterMcpAdd: null,
  projectInfoAfterMcpAdd: null,
  mcpToolsGet: null,
  mcpToolsSet: null,
  configAfterMcpTools: null,
  projectInfoAfterMcpTools: null,
  mcpToolsMissing: null,
  mcpToolsBadShape: null,
  mcpToolsClear: null,
  configAfterMcpToolsClear: null,
  badMcp: null,
  configAfterBadMcp: null,
  mcpRemove: null,
  configAfterMcpRemove: null,
  projectInfoAfterMcpRemove: null,
  agentAdd: null,
  configBeforeAgentAdd: null,
  configAfterAgentAdd: null,
  agentFile: null,
  agentGet: null,
  projectInfoAfterAgentAdd: null,
  badAgent: null,
  setDefaultAgent: null,
  configAfterDefaultAgent: null,
  projectInfoAfterDefaultAgent: null,
  openNoAgent: null,
  openWithAgent: null,
  openMissingAgent: null,
  agentSend: null,
  agentSessionOnDisk: null,
  agentRemove: null,
  agentDirGone: null,
  agentGetMissing: null,
  projectInfoAfterAgentRemove: null,
  agentSessionAfterRemove: null,
  history: null,
  closed: null,
  resumed: null,
  resumedState: null,
  afterQuit: null,
  attachIngest: null,
  fileIngest: null,
  attachSend: null,
  attachSeen: null,
  attachOnDisk: null,
  attachResumed: null,
  shotBytes: null,
  /**
   * 「并发那两个会话」的 id。`deltas` / `statuses` 只统计它们 —— 附件那一段
   * 也会吐增量和状态，不划清的话「增量没有串到别的会话」这条断言会开始数附件会话的账。
   */
  coreSessionIds: [],
  quitMs: null,
  elapsedMs: null,
  deltas: {},
  statuses: {},
  permissions: [],
  toolStarts: [],
  eventSessionIds: [],
  straySessionIds: [],
}

const server = createMockServer()
await new Promise((r) => server.listen(PORT, r))

const events = []
const statusTimeline = new Map()
/** 假 renderer 记录下来的授权请求，用来断言「弹窗弹给了对的那个会话」 */
const permissionRequests = []

function noteStatus(sessionId, status) {
  const list = statusTimeline.get(sessionId) ?? []
  list.push(status)
  statusTimeline.set(sessionId, list)
}

const t0 = Date.now()
try {
  const { DesktopApp } = await import(`${dist}runtime/desktop-app.js`)
  const { createProjectRuntime } = await import(`${dist}runtime/project.js`)

  let app
  const sink = {
    send(sessionId, event) {
      events.push({ sessionId, event })
      if (event.type === 'session-status') noteStatus(sessionId, event.status)
      if (event.type !== 'permission-request') return

      permissionRequests.push({
        sessionId,
        requestId: event.requestId,
        label: event.label,
        detail: event.detail,
      })
      // 真 renderer 的等价动作：先渲染出弹窗，用户点了「允许」再回。这里直接点允许。
      // 用 queueMicrotask 而不是同步调用，免得在 sink 的栈上重入 handle
      queueMicrotask(() => {
        void app.handle('permission/reply', {
          sessionId,
          requestId: event.requestId,
          decision: 'allow',
        })
      })
    },
  }

  app = new DesktopApp({
    version: '0.0.0-test',
    sink,
    openProject: (cwd) =>
      createProjectRuntime({
        cwd,
        version: '0.0.0-test',
        onWarn: (msg) => out.warnings.push(msg),
      }),
  })

  /**
   * 取一份**过完 IPC 的**快照。Electron 的 `ipcMain.handle` 会把返回值结构化克隆一份给
   * renderer，这里 `app.handle` 是直接调用 —— 拿到的和主进程里是同一个对象，项目快照里的
   * `skills` 干脆就是注册表自己那个数组。不克隆的话，后面「再把技能打开」会连前面存下的
   * 快照一起改掉，断言看到的是**最终**状态：按中间状态写的会红（`disabled === true` 那一条
   * 就是这么红的），按最终状态写的却可能因为**中间那一步压根没生效**而假绿。
   */
  const snapshot = async (channel, payload) => structuredClone(await app.handle(channel, payload))

  out.initialProjects = await app.handle('project/list')

  // **一个会话都没开**的时候就得能拿到设置页的快照。技能与 MCP 挂在项目运行时上，
  // 而配技能和 MCP 正是开第一个会话之前想做的事 —— 这条通道早先按 sessionId 取，
  // 那一刻三个页面只能显示「还没有打开的会话」
  out.projectInfoNoSession = await snapshot('project/info', { cwd: projectDir })

  // 同一项目开两个会话：顺带验证 project 是按 cwd 复用（引用计数）而不是各起一份
  const a = await app.handle('session/open', { cwd: projectDir })
  const b = await app.handle('session/open', { cwd: projectDir })
  if (!a.ok || !b.ok) throw new Error(`session/open 失败：${JSON.stringify({ a, b })}`)
  out.sessionIds = [a.session.id, b.session.id]
  out.coreSessionIds = [...out.sessionIds]

  // 两个会话同时跑：A 读、B 写（写会弹授权）。并发发出去，各自 await
  const [sendA, sendB] = await Promise.all([
    app.handle('session/send', { sessionId: a.session.id, text: '项目叫什么' }),
    app.handle('session/send', { sessionId: b.session.id, text: '写个文件吧' }),
  ])
  out.send = { a: sendA, b: sendB }

  const notePath = path.join(projectDir, 'note.txt')
  out.noteWritten = fs.existsSync(notePath)
  out.noteContent = out.noteWritten ? fs.readFileSync(notePath, 'utf8') : null

  // 右栏（待办 / 改动文件）和中栏顶栏（模型、模式、上下文条）靠这个刷新
  out.tools = {
    a: await snapshot('session/state', { sessionId: a.session.id }),
    b: await snapshot('session/state', { sessionId: b.session.id }),
  }
  out.opened = { a: a.session, b: b.session }

  // 设置页（模型 / 技能 / MCP）唯一的数据源。这条通道要是坏了，三个页面一起空白
  out.projectInfo = await snapshot('project/info', { cwd: projectDir })

  // 故意用一个没配置过的名字：`McpManager.setEnabled` 会抛，channel 层必须翻成
  // `{ok:false, reason}`。这条通道早先是无条件 `{ok:true}` 的，界面显示「已接入」
  // 而工具一个没多 —— 这是那次的回归点
  out.mcpToggle = await app.handle('mcp/set-enabled', { cwd: projectDir, name: 'nope', enabled: true })

  // 会话 id 会拼进文件路径，而且一路流到写路径（`persist.ts` 用同一个 id 续写）。
  // 这两个参数是从 renderer 的 IPC 载荷直接来的，边界上必须挡掉 ——
  // 挡不住的话 `id: '../../x'` 就是一次任意路径写
  out.badResume = await app.handle('session/resume', { cwd: projectDir, id: '../../被穿越出来的' })
  out.badOpen = await app.handle('session/open', { cwd: projectDir, id: '../被穿越出来的' })
  // 穿越要是生效了，落到 home 下的就是这个文件（真实路径，别拿假想的去查）
  out.strayFile = [path.join(home, '被穿越出来的.json'), path.join(home, 'projects', '被穿越出来的.json')].filter(
    (f) => fs.existsSync(f),
  )

  // 轮次跑完要落盘，否则关掉窗口这一轮就没了；侧边栏的「历史会话」也正是读这份文件
  out.history = await app.handle('session/list', { cwd: projectDir })

  // 从历史里重新打开：先关掉当前那个（同一个 id 不能同时开着两份），再接回来
  out.closed = await app.handle('session/close', { sessionId: a.session.id })
  out.resumed = await app.handle('session/resume', { cwd: projectDir, id: a.session.id })
  out.resumedState = await snapshot('session/state', { sessionId: a.session.id })

  // 改「默认模型」：写回项目配置文件，并且只影响**之后**新建的会话。
  // 必须排在 `session/resume` 之后 —— 恢复会话走的是 `structuredClone(project.config)`，
  // 提前改掉的话上面那条「恢复出来还是 desk-model」会跟着变成新模型，测的就不是恢复逻辑了
  out.setDefaultModel = await app.handle('project/set-default-model', {
    cwd: projectDir,
    model: 'desk-model-2',
  })
  const c = await app.handle('session/open', { cwd: projectDir })
  out.openedAfterModel = c.ok ? c.session : null
  if (c.ok) out.sessionIds.push(c.session.id)
  out.configOnDisk = fs.readFileSync(path.join(projectDir, '.clauda', 'config.json'), 'utf8')

  // ---- 附件：真造一张 PNG，走「ingest 读字节 → send 带上去 → 落盘 → 恢复」整条路
  //
  // **必须排在下面那段「切厂商」之前**：切完厂商之后 provider 真的会往新地址发请求，
  // 那是 api.deepseek.com —— 这个用例会变成一次真联网（实测撞回 401）。
  // e2e 一律不能出网。
  //
  // 用会话 c（前面开出来那个）而不是新开一个：`e2e.mjs` 里有一串断言盯着
  // 「开出了几个会话」「哪几个会话吐过增量」，新开一个会把它们一起带偏。
  //
  // 顺序照着 renderer 来：渲染层拿不到 fs，所以它是先 `attachment/ingest` 拿回
  // 归一化结果（图片在这一步变成 data URL），再把那份描述符交给 `session/send`。
  // 这里刻意不复刻「只传 path」，那会让 `sanitizeAttachments` 的图片分支永远不被走到。
  const shotPath = path.join(projectDir, 'shot.png')
  fs.writeFileSync(shotPath, Buffer.from(PNG_1X1, 'base64'))
  out.shotBytes = fs.statSync(shotPath).size
  out.attachIngest = await app.handle('attachment/ingest', {
    items: [{ path: shotPath, name: 'shot.png', mime: 'image/png' }],
  })
  // 非图片只带路径、不读内容 —— 这条和上面那条是 `UserAttachment` 的两个分支
  out.fileIngest = await app.handle('attachment/ingest', {
    items: [{ path: path.join(projectDir, 'package.json') }],
  })
  const ingested = out.attachIngest?.attachments ?? []
  // 文案里**不能出现「写」**：mock 服务端是按最后一条用户消息里的「写」决定返回
  // write_file 还是 read_file 的，一带「写」就会多弹一次授权框，把上面
  // 「写操作弹了授权框」那条断言（length === 1）撞坏
  out.attachSend = await app.handle('session/send', {
    sessionId: c.session.id,
    text: '看看这张图',
    attachments: ingested,
  })
  // 立刻取：后面还有若干轮请求会往 seen 里追加，晚了拿到的就不是这一轮了
  out.attachSeen = server.seen.at(-1) ?? null

  const slug = fs.readdirSync(path.join(home, 'projects'))[0]
  const sessionFile = path.join(home, 'projects', slug, `${c.session.id}.json`)
  out.attachOnDisk = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null

  // 关掉再从历史里接回来 —— 这正是「关掉窗口重开、点回该会话」那条路。恢复回来的
  // 消息里要是没有图片，界面上那个会话就只剩一句话，用户会以为图丢了
  await app.handle('session/close', { sessionId: c.session.id })
  out.attachResumed = await app.handle('session/resume', { cwd: projectDir, id: c.session.id })

  // 加一份厂商档案：**添加 ≠ 切过去**。地址与模型一起落在**新那份档案**上，当前那份
  // 一个字不动 —— 顺手换掉当前的话，「同时配好几家」就不成立了（配 B 之前得先把 B
  // 变成当前）。
  //
  // 必须排在读 `configOnDisk` 之后：提前动当前那份的 model，
  // 上面那条「新会话拿到了新的默认模型 = desk-model-2」就变成 deepseek-chat 了
  const configFile = path.join(projectDir, '.clauda', 'config.json')
  out.addProfile = await app.handle('project/add-profile', { cwd: projectDir, vendorKey: 'deepseek' })
  out.configAfterAdd = fs.readFileSync(configFile, 'utf8')
  // 设置页读的就是这条：新那份得在列表里、且**不**是「当前使用」那一份
  out.projectInfoAfterAdd = await snapshot('project/info', { cwd: projectDir })

  // 显式切过去 —— 这是唯一会换厂商的动作
  out.setVendor = await app.handle('project/set-active-provider', { cwd: projectDir, profileKey: 'deepseek' })
  out.configAfterVendor = fs.readFileSync(configFile, 'utf8')
  // 设置页读的就是这条：它回来的 `vendorKey` 必须与新地址一致，否则界面会显示旧厂商
  out.projectInfoAfterVendor = await snapshot('project/info', { cwd: projectDir })
  const d = await app.handle('session/open', { cwd: projectDir })
  out.openedAfterVendor = d.ok ? d.session : null
  if (d.ok) out.sessionIds.push(d.session.id)

  // 未知档案必须在 channel 层就被挡住：不存在「写一个界面没提供过的地址」这条路径
  out.badVendor = await app.handle('project/set-active-provider', { cwd: projectDir, profileKey: 'nope' })
  out.configAfterBadVendor = fs.readFileSync(configFile, 'utf8')

  // 当前使用那份删不掉：删了 `activeProvider` 就指向一个不存在的名字，配置会静默
  // 退回内置默认值（OpenAI + gpt-4o-mini）—— 那是「什么都没干，请求却换了一家」
  out.removeActive = await app.handle('project/remove-profile', { cwd: projectDir, profileKey: 'deepseek' })
  out.configAfterRemoveActive = fs.readFileSync(configFile, 'utf8')

  // ---- 技能与 MCP 的增删：设置页那两个表单和对话里那四个工具最终都走这四条通道
  //
  // **必须排在最末**：上面每一条快照断言（`out.tools`、`configOnDisk`、项目快照里
  // 「零技能 / 零 MCP」那两条）都是在它们之前取好的，插到中间就会把那些一起带偏。
  const skillFile = path.join(projectDir, '.clauda', 'skills', 'weekly-report', 'SKILL.md')
  out.skillAdd = await app.handle('skill/add', {
    cwd: projectDir,
    scope: 'project',
    name: 'weekly-report',
    description: '把一周的提交汇总成周报',
    body: '按仓库分组，逐条列出改动。',
  })
  // 断言盯的是**磁盘上的文件**：通道回一个路径不代表文件真写出来了
  out.skillFile = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : null
  out.projectInfoAfterSkill = await snapshot('project/info', { cwd: projectDir })
  // 立刻生效那句得能验收：同一批会话的工具集与提示词都要跟上（`refreshProjectTools`），
  // 否则「对话里加完当场能用」是空话
  out.stateAfterSkill = await snapshot('session/state', { sessionId: b.session.id })

  // 全局那份落在 CLAUDA_HOME 下，和项目那份是**两个根** —— 这条才证明 scope 真的分流了
  out.skillAddGlobal = await app.handle('skill/add', {
    cwd: projectDir,
    scope: 'global',
    name: 'house-style',
    description: '写东西时遵守的口气',
    body: '短句。',
  })
  out.globalSkillFile = fs.existsSync(path.join(home, 'skills', 'house-style', 'SKILL.md'))
  // 名字不合规必须当场拒掉，且磁盘上不留痕 —— 静默改名会让界面上的名字和目录名对不上，
  // 那是最难查的一类问题（错误里得能看出是哪条规则）
  out.badSkill = await app.handle('skill/add', {
    cwd: projectDir,
    scope: 'project',
    name: '../逃出技能根',
    description: 'x',
    body: 'x',
  })
  out.escapedSkill = fs
    .readdirSync(path.join(projectDir, '.clauda', 'skills'))
    .filter((n) => n !== 'weekly-report')

  out.skillRemove = await app.handle('skill/remove', { cwd: projectDir, name: 'weekly-report' })
  out.skillGone = !fs.existsSync(skillFile)
  // 删一个不存在的：得报「没有」，不能静默成功（界面上那行会留在原地）
  out.skillRemoveMissing = await app.handle('skill/remove', { cwd: projectDir, name: 'weekly-report' })
  out.projectInfoAfterSkillRemove = await snapshot('project/info', { cwd: projectDir })

  // 技能开关：关掉之后**当场**从工具集里消失，`SKILL.md` 一个字节不动。
  // 挑这个时刻验是因为此刻只剩 `house-style` 一个技能 —— 关掉它之后 `skill` 工具本身
  // 也该从集合里摘掉（零技能不挂那份 schema），这是「关到底」唯一看得见的证据
  const globalConfig = path.join(home, 'config.json')
  out.skillDisable = await app.handle('skill/set-disabled', {
    cwd: projectDir,
    name: 'house-style',
    disabled: true,
    scope: 'global',
  })
  out.skillDisableFiles = [globalConfig, configFile].map((f) => fs.readFileSync(f, 'utf8'))
  out.projectInfoAfterSkillDisable = await snapshot('project/info', { cwd: projectDir })
  out.stateAfterSkillDisable = await snapshot('session/state', { sessionId: b.session.id })
  out.skillFileAfterDisable = fs.existsSync(path.join(home, 'skills', 'house-style', 'SKILL.md'))
  // 再关一次，这回落到**项目**那份上：禁用名单在两份配置之间是并集，所以两次之后
  // 两份文件里都有这个名字 —— 下面「打开」那一下要能**两份一起清**，靠的就是这个前置状态
  out.skillDisableProject = await app.handle('skill/set-disabled', {
    cwd: projectDir,
    name: 'house-style',
    disabled: true,
    scope: 'project',
  })
  out.skillDisableProjectFiles = [globalConfig, configFile].map((f) => fs.readFileSync(f, 'utf8'))
  out.skillEnable = await app.handle('skill/set-disabled', {
    cwd: projectDir,
    name: 'house-style',
    disabled: false,
    scope: 'project',
  })
  out.skillEnableFileContents = [globalConfig, configFile].map((f) => fs.readFileSync(f, 'utf8'))
  out.projectInfoAfterSkillEnable = await snapshot('project/info', { cwd: projectDir })
  out.stateAfterSkillEnable = await snapshot('session/state', { sessionId: b.session.id })
  // 名字不对：得抛。不认名字的话开关能关掉一个不存在的技能，配置里就多一条永不生效的记录
  out.skillDisableMissing = await app.handle('skill/set-disabled', {
    cwd: projectDir,
    name: 'nope',
    disabled: true,
    scope: 'global',
  })

  // MCP：真起一个子进程（`tests/mock-mcp.mjs`，两个工具），连上、看快照、再删掉。
  // 这条是「设置页加完就能用」唯一的证据 —— 状态是 `connected`、工具数是真数出来的
  out.mcpAdd = await app.handle('mcp/add', {
    cwd: projectDir,
    scope: 'project',
    name: 'desk-mock',
    config: { command: process.execPath, args: [path.join(PROJECT, 'tests', 'mock-mcp.mjs')] },
  })
  out.configAfterMcpAdd = fs.readFileSync(configFile, 'utf8')
  out.projectInfoAfterMcpAdd = await snapshot('project/info', { cwd: projectDir })

  // 连不上的服务器：`addServer` 会抛，通道层翻成 `{ok:false, reason}`。配置**是**写下去了
  // （那是用户能在 MCP 页里删掉的状态），所以下面那条断言盯的是「项目里那几条一字未动」
  // 工具白名单：同一台真服务器上验两条通道。`mcp/tools/set` 只该改配置里的 `tools`
  // （`writeMcpServer` 是整条替换，用它会连 command/args 一起抹掉），而且**当场**换掉
  // 这台接进来的工具 —— 快照里那句 `工具 1/2` 就是证据：分母还是 2，说明子进程没重连
  out.mcpToolsGet = await app.handle('mcp/tools/get', { cwd: projectDir, name: 'desk-mock' })
  out.mcpToolsSet = await app.handle('mcp/tools/set', { cwd: projectDir, name: 'desk-mock', tools: ['echo'] })
  out.configAfterMcpTools = fs.readFileSync(configFile, 'utf8')
  out.projectInfoAfterMcpTools = await snapshot('project/info', { cwd: projectDir })
  // 名字对不上：得说「没找到写在哪份文件里」，而不是空手返回成功（界面会以为改上了）
  out.mcpToolsMissing = await app.handle('mcp/tools/set', { cwd: projectDir, name: 'nope', tools: ['x'] })
  // 形状不对：数组或 `null` 之外的都挡掉 —— 让一个字符串落进配置会把整份文件读废
  out.mcpToolsBadShape = await app.handle('mcp/tools/set', { cwd: projectDir, name: 'desk-mock', tools: 'echo' })
  // `null` 是「不要白名单了」（全接），界面全勾上发的就是它
  out.mcpToolsClear = await app.handle('mcp/tools/set', { cwd: projectDir, name: 'desk-mock', tools: null })
  out.configAfterMcpToolsClear = fs.readFileSync(configFile, 'utf8')

  out.badMcp = await app.handle('mcp/add', {
    cwd: projectDir,
    scope: 'project',
    name: 'bad-mock',
    // `timeoutMs` 压到 3 秒：这条路的失败要快。真起不来的子进程本该立刻报错，
    // 万一 SDK 把 spawn 的 error 吞了，也是卡在连接超时而不是默认那 15 秒 ——
    // 最后那条「退出不卡死（<30 秒）」的断言不该被这一条拖长
    config: { command: path.join(projectDir, '没有这个命令'), args: [], timeoutMs: 3000 },
  })
  out.configAfterBadMcp = fs.readFileSync(configFile, 'utf8')

  out.mcpRemove = await app.handle('mcp/remove', { cwd: projectDir, name: 'desk-mock' })
  out.configAfterMcpRemove = fs.readFileSync(configFile, 'utf8')
  out.projectInfoAfterMcpRemove = await snapshot('project/info', { cwd: projectDir })
  // 顺手把连不上的那条也删掉，好让最后那条「mcpServers 回到空」成立
  await app.handle('mcp/remove', { cwd: projectDir, name: 'bad-mock' })

  // ---- 智能体：设置页那套表单与「开新会话时绑定」最终都走这四条通道
  //
  // **位置**：排在技能 / MCP 之后（那两块动的是同一份配置文件，而上面每一条快照断言
  // 都是在它们之前取好的），仍然在 `app/quit` 之前 —— 与上面那条排序约束同一个理由。
  //
  // 这份是「只多了一个键」那条断言的基线。`agent/add` 写的是 AGENT.md、**一个字都不该动
  // config.json**，所以从这里到 `set-default-agent` 之间磁盘上应当完全没有变化
  out.configBeforeAgentAdd = fs.readFileSync(configFile, 'utf8')
  const agentFile = path.join(projectDir, '.clauda', 'agents', 'code-review', 'AGENT.md')
  out.agentAdd = await app.handle('agent/add', {
    cwd: projectDir,
    scope: 'project',
    name: 'code-review',
    description: '按严重程度审查改动',
    body: '你是一名严格的代码审查员。先说结论，再按「必须改 / 建议改」两档列问题。',
    // 档案只写**名字**：智能体文件要能提交进 git，端点与密钥一个字都不许抄进来
    profile: 'default',
    model: 'agent-model',
    // 0 是有效配置：`writeAgent` 用 `!== undefined` 判断，丢了这行就是「温度设置不生效」
    temperature: 0,
    permission: 'default',
    tools: ['read_file', 'grep'],
    questions: ['这次改动有什么风险', '跑测试要装什么，怎么装？'],
  })
  // 断言盯的是**磁盘上的文件**：通道回一个路径不代表文件真写出来了，也不代表 frontmatter
  // 真是那个形状（旧路径 / 少了 `tools:` 那一行，光看返回值都发现不了）
  out.agentFile = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : null
  // `project/info` 那份**刻意不带正文**，编辑表单要正文只能走这条
  out.agentGet = await app.handle('agent/get', { cwd: projectDir, name: 'code-review' })
  // 写智能体**不该动配置**：它落的是 AGENT.md，配置那几段（档案 / MCP / 权限）一个字都不许变
  out.configAfterAgentAdd = fs.readFileSync(configFile, 'utf8')
  out.projectInfoAfterAgentAdd = await snapshot('project/info', { cwd: projectDir })

  // 名字不合规当场拒掉，且磁盘上不留痕 —— 静默改名会让界面上的名字和目录名对不上。
  // 这同时是路径穿越（`../`）那道闸门在智能体这条路上的复验
  out.badAgent = await app.handle('agent/add', {
    cwd: projectDir,
    scope: 'project',
    name: '../逃出智能体根',
    description: 'x',
    body: 'x',
  })

  // 标「本项目默认」：**只写 config.json 的一个键**，其余键一字未动、`${VAR}` 仍是占位符
  out.setDefaultAgent = await app.handle('project/set-default-agent', { cwd: projectDir, name: 'code-review' })
  out.configAfterDefaultAgent = fs.readFileSync(configFile, 'utf8')
  out.projectInfoAfterDefaultAgent = await snapshot('project/info', { cwd: projectDir })

  // 开新会话。**主进程没有「没给名字就套默认」这条魔法** —— 「套默认」只发生在界面那一格
  // 下拉框的初始值里（渲染层总发一个具体值进来）。所以下面两条必须不一样：
  // 空串 = 明确不要智能体，一条没绑过的会话不该因为项目有默认就悄悄变成它
  out.openNoAgent = await app.handle('session/open', { cwd: projectDir, agent: '' })
  // 这条路才是「＋ 新会话」在默认项上按下去时走的：界面把这个名字一起发过来
  out.openWithAgent = await app.handle('session/open', { cwd: projectDir, agent: 'code-review' })
  // 名字是存在的但注册表里查不到：**不抛**，按「没有智能体」装配 + 一条给界面看的警告
  // （一个被删掉的智能体不该让会话打不开，自动恢复那条路尤其）
  out.openMissingAgent = await app.handle('session/open', { cwd: projectDir, agent: '已经删掉的那个' })
  // 这三条也记进 `sessionIds`：`straySessionIds`（「有没有事件来自驱动没开过的会话」）
  // 是拿它当白名单的，漏记就会被当成一次泄漏，正是那条断言要抓的东西被自己撞响
  for (const r of [out.openNoAgent, out.openWithAgent, out.openMissingAgent]) {
    if (r.ok) out.sessionIds.push(r.session.id)
  }

  // 说一句话好让它落盘（只有系统提示词时**不写文件**）。文案里不能带「写」：mock 服务端按
  // 这个字决定返回 write_file 还是 read_file，带「写」就会多弹一次授权框
  out.agentSend = await app.handle('session/send', {
    sessionId: out.openWithAgent.session.id,
    text: '看看这段改动',
  })
  const agentSessionFile = path.join(home, 'projects', slug, `${out.openWithAgent.session.id}.json`)
  out.agentSessionOnDisk = fs.existsSync(agentSessionFile)
    ? fs.readFileSync(agentSessionFile, 'utf8')
    : null

  // 删：**整个目录**都得消失（不是只删 AGENT.md），文件名也一并回收。
  // 入参是名字、路径由主进程从注册表查 —— 界面拿不到也不该拼路径
  out.agentRemove = await app.handle('agent/remove', { cwd: projectDir, name: 'code-review' })
  out.agentDirGone = !fs.existsSync(path.dirname(agentFile))
  // 再 get 一次：**必须报「没有」而不是静默成功**（静默成功会让界面留着一个空表单）
  out.agentGetMissing = await app.handle('agent/get', { cwd: projectDir, name: 'code-review' })
  out.projectInfoAfterAgentRemove = await snapshot('project/info', { cwd: projectDir })
  // 而先前那条绑过它的老会话照样能打开、提示词还是它那份 —— 配方冻在会话里，
  // 不依赖那个目录还在。这是「冻结」而不是「恢复时按名字重查」最直接的正面证据
  out.agentSessionAfterRemove = await app.handle('session/resume', {
    cwd: projectDir,
    id: out.openWithAgent.session.id,
  })

  // 删除会话：文件从 home 下真的没了，历史列表里也不再出现。
  // 拿这条下手最省事 —— 上面 `agentSessionOnDisk` 已经证实它落过盘，此刻又正开着，
  // 顺带验了「删除前先把活会话关掉」。穿越 id 跟 `session/resume` 一样要被挡在边界上
  const delId = out.openWithAgent.session.id
  const delFile = path.join(home, 'projects', slug, `${delId}.json`)
  out.deleteId = delId
  out.deleteBeforeExists = fs.existsSync(delFile)
  out.deleteRes = await app.handle('session/delete', { cwd: projectDir, id: delId })
  out.deleteFileGone = !fs.existsSync(delFile)
  out.deleteList = await app.handle('session/list', { cwd: projectDir })
  out.badDelete = await app.handle('session/delete', { cwd: projectDir, id: '../../被穿越出来的' })
  out.badDeleteStray = [path.join(home, '被穿越出来的.json')].filter((f) => fs.existsSync(f))

  const tQuit = Date.now()
  await app.handle('app/quit')
  out.quitMs = Date.now() - tQuit

  // 退出之后会话必须真的没了：还活着就说明 disposeAll 只关了 MCP，没清会话。
  // 用 B 的 id 而不是 A 的 —— A 刚被恢复过，还开着
  out.afterQuit = await app.handle('session/send', { sessionId: b.session.id, text: '还在吗' })
  out.ok = true
} catch (err) {
  out.error = err?.stack ?? String(err)
}
out.elapsedMs = Date.now() - t0

for (const { sessionId, event } of events) {
  // 增量与状态只记并发那两个会话（见 coreSessionIds 的注释）
  if (out.coreSessionIds.includes(sessionId)) {
    if (event.type === 'assistant-delta') out.deltas[sessionId] = (out.deltas[sessionId] ?? '') + event.text
  }
  if (event.type === 'tool-start') {
    out.toolStarts.push({ sessionId, name: event.name, summary: event.summary })
  }
}
out.statuses = Object.fromEntries(
  [...statusTimeline].filter(([sessionId]) => out.coreSessionIds.includes(sessionId)),
)
out.permissions = permissionRequests
out.eventSessionIds = [...new Set(events.map((e) => e.sessionId))]
const known = new Set(out.sessionIds)
out.straySessionIds = out.eventSessionIds.filter((id) => !known.has(id))

process.stdout.write(JSON.stringify(out) + '\n')

server.close()
server.closeAllConnections?.()
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(projectDir, { recursive: true, force: true })
process.exit(0)
