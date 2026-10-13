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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-home-'))
// 会话的 cwd 必须是个临时目录：write_file 会真落盘，写进仓库根目录就污染工作区了
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-desk-proj-'))
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'deskdemo' }), 'utf8')

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
  history: null,
  closed: null,
  resumed: null,
  resumedState: null,
  afterQuit: null,
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

  // 轮次跑完要落盘，否则关掉窗口这一轮就没了；侧边栏的「历史会话」也正是读这份文件
  out.history = await app.handle('session/list', { cwd: projectDir })

  // 从历史里重新打开：先关掉当前那个（同一个 id 不能同时开着两份），再接回来
  out.closed = await app.handle('session/close', { sessionId: a.session.id })
  out.resumed = await app.handle('session/resume', { cwd: projectDir, id: a.session.id })
  out.resumedState = await app.handle('session/state', { sessionId: a.session.id })

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
  if (event.type === 'assistant-delta') out.deltas[sessionId] = (out.deltas[sessionId] ?? '') + event.text
  if (event.type === 'tool-start') {
    out.toolStarts.push({ sessionId, name: event.name, summary: event.summary })
  }
}
out.statuses = Object.fromEntries(statusTimeline)
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
