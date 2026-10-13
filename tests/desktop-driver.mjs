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
import { createMockServer } from './mock-server.mjs'

const PORT = Number(process.env.DESK_PORT ?? 8918)
const dist = new URL('../dist/', import.meta.url).href

/** 一张真的 1×1 PNG。附件那条路要么读到真字节、要么什么都没验到，所以现编一个 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-home-'))
// 会话的 cwd 必须是个临时目录：write_file 会真落盘，写进仓库根目录就污染工作区了
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-proj-'))
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'deskdemo' }), 'utf8')
// 预先放一份项目配置，用来验「写回时只动 provider 里被指定的键」：
//   - `${CLAUDA_API_KEY}` 是**原文**，写回后必须还是原文（展开了就成明文密钥落盘）
//   - `timeoutMs` 是 provider 里不该被碰的键，`mcpServers` 在 provider 之外
// 空对象 `mcpServers` 不会真的起服务器，所以下面的「MCP 列表为空」那条不受影响
fs.mkdirSync(path.join(projectDir, '.clauda'), { recursive: true })
fs.writeFileSync(
  path.join(projectDir, '.clauda', 'config.json'),
  JSON.stringify({ provider: { apiKey: '${CLAUDA_API_KEY}', timeoutMs: 20000 }, mcpServers: {} }, null, 2) + '\n',
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
  projectInfo: null,
  mcpToggle: null,
  badResume: null,
  badOpen: null,
  strayFile: null,
  setDefaultModel: null,
  openedAfterModel: null,
  configOnDisk: null,
  setVendor: null,
  configAfterVendor: null,
  projectInfoAfterVendor: null,
  openedAfterVendor: null,
  badVendor: null,
  configAfterBadVendor: null,
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

  out.initialProjects = await app.handle('project/list')

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
    a: await app.handle('session/state', { sessionId: a.session.id }),
    b: await app.handle('session/state', { sessionId: b.session.id }),
  }
  out.opened = { a: a.session, b: b.session }

  // 设置页（模型 / 技能 / MCP）唯一的数据源。这条通道要是坏了，三个页面一起空白
  out.projectInfo = await app.handle('project/info', { sessionId: a.session.id })

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
  out.resumedState = await app.handle('session/state', { sessionId: a.session.id })

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

  // 切厂商：**地址与模型一次写完**。只换地址的话，当前会话会拿着旧模型名去问新端点，
  // 换来的只是个费解的 404。
  //
  // 必须排在读 `configOnDisk` 之后：提前切会改掉 `provider.model`，
  // 上面那条「新会话拿到了新的默认模型 = desk-model-2」就变成 deepseek-chat 了
  const configFile = path.join(projectDir, '.clauda', 'config.json')
  out.setVendor = await app.handle('project/set-vendor', { cwd: projectDir, vendorKey: 'deepseek' })
  out.configAfterVendor = fs.readFileSync(configFile, 'utf8')
  // 设置页读的就是这条：它回来的 `vendorKey` 必须与新地址一致，否则界面会显示旧厂商
  out.projectInfoAfterVendor = await app.handle('project/info', { sessionId: c.session.id })
  const d = await app.handle('session/open', { cwd: projectDir })
  out.openedAfterVendor = d.ok ? d.session : null
  if (d.ok) out.sessionIds.push(d.session.id)

  // 未知厂商必须在 channel 层就被挡住：`setVendor` 只接受已解析的 preset，
  // 于是不存在「写一个界面没提供过的地址」这条路径
  out.badVendor = await app.handle('project/set-vendor', { cwd: projectDir, vendorKey: 'nope' })
  out.configAfterBadVendor = fs.readFileSync(configFile, 'utf8')

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
