/**
 * 渲染进程：DOM 绑定 + 增量更新。
 *
 * 这里**不做任何判断**，只干两件事：把 IPC 事件翻成 action 丢给 `state.js` 的
 * `reduce`，再把新 state 画出来。所有「什么时候该显示什么」都在 state.js 里，
 * 那边有单测；这个文件只能靠人工看窗口，所以刻意写得越薄越好。
 *
 * 唯一一处 `innerHTML` 是助手消息 —— 内容必须先过 `markdown.js` 的转义。
 * 其余一律 `textContent`，工具结果和报错里可能有模型输出，不能当 HTML 塞。
 */
import { markdown } from './markdown.js'
import { changedFiles, createState, reduce, streamPlan, todoItems } from './state.js'

const els = {
  newSession: document.getElementById('new-session'),
  pickProject: document.getElementById('pick-project'),
  projectPath: document.getElementById('project-path'),
  sessionList: document.getElementById('session-list'),
  notices: document.getElementById('notices'),
  chatTitle: document.getElementById('chat-title'),
  modelInput: document.getElementById('model-input'),
  modeSelect: document.getElementById('mode-select'),
  contextFill: document.getElementById('context-fill'),
  stream: document.getElementById('stream'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  abort: document.getElementById('abort'),
  changedFiles: document.getElementById('changed-files'),
  todos: document.getElementById('todos'),
  modalHost: document.getElementById('modal-host'),
}

const STATUS_LABEL = { running: '进行中', ok: '完成', error: '失败', done: '已结束' }

let state = createState()
/** 当前选中的项目目录。新会话开在这里 */
let cwd = ''

// ------------------------------------------------------------------ 基础设施

function invoke(channel, payload) {
  return window.clauda.invoke(channel, payload)
}

function dispatch(action) {
  state = reduce(state, action)
  render()
}

function activeSession() {
  return state.activeId ? state.sessions[state.activeId] : null
}

function notice(level, text) {
  dispatch({ type: 'app-notice', level, text })
}

// ------------------------------------------------------------------ 数据同步

async function refreshProjects() {
  const res = await invoke('project/list')
  if (res.ok) dispatch({ type: 'projects', projects: res.projects })
}

async function refreshHistory(projectCwd) {
  const res = await invoke('session/list', { cwd: projectCwd })
  if (res.ok) dispatch({ type: 'history', cwd: projectCwd, sessions: res.sessions })
}

/** 一轮结束、切模型/模式之后调：刷新右栏、上下文条、侧边栏的历史列表 */
async function refreshSession(sessionId) {
  const session = state.sessions[sessionId]
  if (!session) return
  const res = await invoke('session/state', { sessionId })
  if (res.ok) dispatch({ type: 'session-state', sessionId, session: res.session })
  await refreshHistory(session.cwd)
  await refreshProjects()
}

async function openNewSession() {
  if (!cwd) {
    notice('warn', '先选一个项目目录')
    return
  }
  const res = await invoke('session/open', { cwd })
  if (!res.ok) {
    notice('error', res.reason)
    return
  }
  dispatch({ type: 'session-opened', session: res.session })
}

async function openHistory(id) {
  const res = await invoke('session/resume', { cwd, id })
  if (!res.ok) {
    notice('error', res.reason)
    return
  }
  dispatch({ type: 'session-opened', session: res.session })
  dispatch({ type: 'messages-restored', sessionId: res.session.id, messages: res.messages })
}

// ------------------------------------------------------------------ 事件入口

function applyEvent(sessionId, event) {
  // 项目级警告（MCP 连不上之类）不带会话，直接进通知栏
  if (event.type === 'app-notice') {
    notice(event.level, event.msg)
    return
  }

  dispatch({ ...event, sessionId })

  // 状态回到 idle 就说明这一轮彻底结束了，这时去要一次权威快照
  if (event.type === 'session-status' && event.status === 'idle') void refreshSession(sessionId)
}

// ------------------------------------------------------------------ 渲染

function render() {
  renderSidebar()
  renderTopbar()
  renderStream()
  renderPanel()
  renderModal()
  renderNotices()
}

function renderSidebar() {
  els.projectPath.textContent = cwd || '（还没选项目）'

  const known = new Set(state.order)
  const history = (state.history[cwd] ?? []).filter((s) => !known.has(s.id))

  const blocks = []
  blocks.push(group('进行中', state.order.map((id) => sessionRow(state.sessions[id]))))
  if (history.length > 0) blocks.push(group('历史', history.map(historyRow)))

  els.sessionList.replaceChildren(...blocks)
}

function group(label, rows) {
  const box = document.createElement('div')
  box.className = 'group'
  const head = document.createElement('div')
  head.className = 'group-head'
  head.textContent = label
  box.append(head, ...rows)
  return box
}

function sessionRow(session) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = `session-row${session.id === state.activeId ? ' active' : ''}`

  const text = document.createElement('span')
  text.className = 'session-title'
  const first = session.items.find((i) => i.kind === 'user')
  text.textContent = first ? first.text.slice(0, 48) : '新会话'

  const dot = document.createElement('span')
  // 等授权时侧边栏要能看出来，否则用户切到别的会话就再也想不起这件事了
  dot.className = `dot ${session.pending ? 'waiting' : session.status}`
  dot.title = session.pending ? '等待授权' : session.status === 'running' ? '运行中' : '空闲'

  row.append(text, dot)
  row.addEventListener('click', () => dispatch({ type: 'select', id: session.id }))
  return row
}

function historyRow(summary) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'session-row history'
  const text = document.createElement('span')
  text.className = 'session-title'
  text.textContent = summary.title
  const time = document.createElement('span')
  time.className = 'session-time'
  time.textContent = String(summary.updatedAt ?? '').slice(5, 16).replace('T', ' ')
  row.append(text, time)
  row.addEventListener('click', () => void openHistory(summary.id))
  return row
}

function renderTopbar() {
  const session = activeSession()
  const off = !session

  els.chatTitle.textContent = session ? session.cwd : '还没有打开的会话'
  // 输入框正在编辑时不要回写，否则光标会跳
  if (session && document.activeElement !== els.modelInput) els.modelInput.value = session.model
  if (session) els.modeSelect.value = session.mode
  els.contextFill.style.width = `${Math.min(100, Math.round((session?.contextRatio ?? 0) * 100))}%`

  els.modelInput.disabled = off
  els.modeSelect.disabled = off
  els.input.disabled = off
  els.abort.hidden = !(session && session.status === 'running')
}

/**
 * 消息流是**增量**画的：全量重绘会在流式输出时整块闪。
 * 条目只会追加、且只有最后一条会被就地改写（增量、工具收尾都是在改尾巴），
 * 所以补上新增的、把最后一条重画一遍就够了。
 *
 * 「哪几个节点要画」由 `streamPlan` 判（在 state.js 里，有单测）。漏画新建节点的
 * 症状是「切走再切回来前面全是空白」，看着像对话丢了，在这儿现推很容易推错。
 */
let streamKey = null
let streamNodes = []
/** 已经画过的节点数。和 `streamNodes.length` 分开是因为删节点发生在画之前 */
let painted = 0

function renderStream() {
  const session = activeSession()
  const key = session ? `${session.id}#${session.openSeq}` : null
  if (key !== streamKey) {
    els.stream.replaceChildren()
    streamNodes = []
    painted = 0
    streamKey = key
  }
  if (!session) return

  // 用户往上翻了就别再把他拽回底部
  const pinned = els.stream.scrollHeight - els.stream.scrollTop - els.stream.clientHeight < 60

  const items = session.items
  while (streamNodes.length < items.length) {
    const node = document.createElement('div')
    els.stream.append(node)
    streamNodes.push(node)
  }
  while (streamNodes.length > items.length) {
    streamNodes.pop()
    els.stream.lastElementChild?.remove()
  }

  for (const index of streamPlan(painted, items.length)) paint(streamNodes[index], items[index])
  painted = items.length

  if (pinned) els.stream.scrollTop = els.stream.scrollHeight
}

function paint(node, item) {
  node.className = `entry ${item.kind}`

  if (item.kind === 'user') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    // 用户自己打的字不当 markdown，原样显示
    bubble.textContent = item.text
    node.replaceChildren(bubble)
    return
  }

  if (item.kind === 'assistant') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (item.streaming) bubble.classList.add('streaming')
    // 全文件唯一一处 innerHTML：内容先过 markdown.js 的转义
    bubble.innerHTML = markdown(item.text)
    node.replaceChildren(bubble)
    return
  }

  if (item.kind === 'tool') {
    node.replaceChildren(toolCard(item))
    return
  }

  const line = document.createElement('div')
  line.className = `notice ${item.level}`
  line.textContent = item.text
  node.replaceChildren(line)
}

function toolCard(item) {
  const card = document.createElement('div')
  card.className = `card ${item.status}`

  const head = document.createElement('div')
  head.className = 'card-head'

  const name = document.createElement('span')
  name.className = 'card-name'
  name.textContent = item.name

  const summary = document.createElement('span')
  summary.className = 'card-summary'
  summary.textContent = item.summary

  const status = document.createElement('span')
  status.className = 'card-status'
  status.textContent =
    item.status === 'ok' && item.elapsedMs ? `${STATUS_LABEL.ok} ${item.elapsedMs}ms` : STATUS_LABEL[item.status]

  head.append(name, summary, status)

  const body = document.createElement('pre')
  body.className = 'card-body'
  body.textContent = item.result || item.output

  card.append(head, body)
  return card
}

function renderPanel() {
  const session = activeSession()

  els.changedFiles.replaceChildren(
    ...(session ? changedFiles(session) : []).map((file) => listItem(file, 'file')),
  )
  els.todos.replaceChildren(
    ...(session ? todoItems(session) : []).map((todo) => listItem(todo.content, `todo ${todo.status}`)),
  )
}

function listItem(text, className) {
  const li = document.createElement('li')
  li.className = className
  li.textContent = text
  return li
}

function renderNotices() {
  els.notices.replaceChildren(
    ...state.notices.slice(-4).map((n) => {
      const div = document.createElement('div')
      div.className = `notice-line ${n.level}`
      div.textContent = n.text
      return div
    }),
  )
}

/**
 * 授权弹窗。`dataset` 比对是为了**不要每次 render 都重建** ——
 * 重建会把焦点和用户已经按了一半的手感一起抖掉。
 */
function renderModal() {
  const session = activeSession()
  const pending = session?.pending
  if (!pending) {
    els.modalHost.hidden = true
    els.modalHost.replaceChildren()
    delete els.modalHost.dataset.key
    return
  }

  const key = `${session.id}:${pending.requestId}`
  els.modalHost.hidden = false
  if (els.modalHost.dataset.key === key) return
  els.modalHost.dataset.key = key

  const box = document.createElement('div')
  box.className = 'modal'

  const title = document.createElement('h3')
  title.textContent = '需要授权'

  const label = document.createElement('p')
  label.className = 'modal-label'
  label.textContent = pending.label

  const detail = document.createElement('p')
  detail.className = 'modal-detail'
  detail.textContent = pending.detail || ''

  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  actions.append(
    modalButton('拒绝', 'danger', () => reply('deny')),
    modalButton('允许', '', () => reply('allow')),
    modalButton('本次会话总是允许', 'ghost', () => reply('allow-session')),
  )

  box.append(title, label, detail, actions)
  els.modalHost.replaceChildren(box)
}

function modalButton(text, className, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = text
  button.addEventListener('click', onClick)
  return button
}

async function reply(decision) {
  const session = activeSession()
  if (!session?.pending) return
  const { requestId } = session.pending
  // 先关弹窗再发请求：等 IPC 回来才关的话，点击到消失之间用户会以为没点上
  dispatch({ type: 'permission-replied', sessionId: session.id, requestId })
  await invoke('permission/reply', { sessionId: session.id, requestId, decision })
}

// ------------------------------------------------------------------ 交互绑定

els.newSession.addEventListener('click', () => void openNewSession())

els.pickProject.addEventListener('click', async () => {
  const dir = await window.clauda.pickDirectory()
  if (!dir) return
  cwd = dir
  await refreshHistory(dir)
  render()
})

els.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void submit()
})

els.input.addEventListener('keydown', (event) => {
  // Enter 发送、Shift+Enter 换行 —— 输入法组合中的 Enter 不能当发送
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
})

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(200, els.input.scrollHeight)}px`
})

els.abort.addEventListener('click', async () => {
  const session = activeSession()
  if (session) await invoke('session/abort', { sessionId: session.id })
})

els.modelInput.addEventListener('change', async () => {
  const session = activeSession()
  const model = els.modelInput.value.trim()
  if (!session || !model) return
  // 系统提示词里写着当前模型名，改完得让主进程重建提示词，再拉一次快照
  await invoke('session/set-model', { sessionId: session.id, model })
  await refreshSession(session.id)
})

els.modeSelect.addEventListener('change', async () => {
  const session = activeSession()
  if (!session) return
  await invoke('session/set-mode', { sessionId: session.id, mode: els.modeSelect.value })
  await refreshSession(session.id)
})

async function submit() {
  const session = activeSession()
  const text = els.input.value.trim()
  if (!session || !text) return

  els.input.value = ''
  els.input.style.height = 'auto'
  dispatch({ type: 'user-send', sessionId: session.id, text })

  // 这条会一直等到整轮结束。中途的流式输出靠事件推过来
  const res = await invoke('session/send', { sessionId: session.id, text })
  if (!res.ok) dispatch({ type: 'error', sessionId: session.id, msg: res.reason })
}

// ------------------------------------------------------------------ 启动

async function boot() {
  if (!window.clauda) {
    notice('error', '没有跑在 Electron 里：window.clauda 不存在')
    render()
    return
  }
  window.clauda.onEvent(applyEvent)

  await refreshProjects()
  if (state.projects.length > 0) {
    cwd = state.projects[0].cwd
    await refreshHistory(cwd)
  }
  render()

  // 第一次打开时什么项目都没有，直接弹目录选择，省得用户对着一堆禁用控件猜
  if (!cwd) await els.pickProject.click()
}

void boot()
