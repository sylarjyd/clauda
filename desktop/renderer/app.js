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
  app: document.getElementById('app'),

  // 左导航条
  navSessions: document.getElementById('nav-sessions'),
  navModel: document.getElementById('nav-model'),
  navSkills: document.getElementById('nav-skills'),
  navMcp: document.getElementById('nav-mcp'),
  badgeSessions: document.getElementById('badge-sessions'),
  badgeModel: document.getElementById('badge-model'),
  badgeSkills: document.getElementById('badge-skills'),
  badgeMcp: document.getElementById('badge-mcp'),
  railProject: document.getElementById('rail-project'),

  // 会话视图
  viewSessions: document.getElementById('view-sessions'),
  // 设置视图（模型 / 技能 / MCP 三个页面共用）
  viewSettings: document.getElementById('view-settings'),
  settingsTitle: document.getElementById('settings-title'),
  settingsSub: document.getElementById('settings-sub'),
  settingsBody: document.getElementById('settings-body'),

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

/** MCP 服务器状态的中文。措辞与 CLI 的 `/mcp` 保持一致 */
const MCP_STATE = { connected: '已连接', failed: '失败', disabled: '未启用' }

/**
 * 三个设置页的标题与说明。说明里那几句不是装饰 —— 它们解释了「这个数从哪来、
 * 改了会影响什么」，是这几页唯一能防止误操作的东西。
 */
const SETTINGS_META = {
  model: {
    title: '模型配置',
    sub: '当前项目解析后的生效配置。厂商与接口地址是**项目级**的，改完立刻对本项目的所有会话生效（切厂商会连默认模型一起换成该厂商的）；「默认模型」只决定之后新建的会话用哪个，当前会话的模型在中栏顶栏上改。',
  },
  skills: {
    title: '技能',
    sub: '从 ~/.clauda/skills 与沿途各级 .clauda/skills 发现。离当前项目越近的同名技能优先。',
  },
  mcp: {
    title: 'MCP 服务器',
    sub: '在 config.json 的 mcpServers 里配置。这里的开关只在本次运行内有效，不会写回配置文件。',
  },
}

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

/**
 * 拉设置页要的那份快照（生效配置 / 技能 / MCP）。
 *
 * 跟着会话走：技能与 MCP 都挂在项目运行时上，而项目运行时是开会话时才建出来的。
 * 没有会话就清空，让设置页显示空态而不是上一轮的残留。
 */
async function refreshProjectInfo(sessionId) {
  if (!sessionId) {
    dispatch({ type: 'project-info', info: null })
    return
  }
  const res = await invoke('project/info', { sessionId })
  dispatch({ type: 'project-info', info: res.ok ? res.info : null })
}

/** 一轮结束、切模型/模式之后调：刷新右栏、上下文条、侧边栏的历史列表 */
async function refreshSession(sessionId) {
  const session = state.sessions[sessionId]
  if (!session) return
  const res = await invoke('session/state', { sessionId })
  if (res.ok) dispatch({ type: 'session-state', sessionId, session: res.session })
  await refreshHistory(session.cwd)
  await refreshProjects()
  // 顺手刷导航条徽标。这里是内存里的现成数据，不贵
  await refreshProjectInfo(sessionId)
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
  await refreshProjectInfo(res.session.id)
}

async function openHistory(id) {
  const res = await invoke('session/resume', { cwd, id })
  if (!res.ok) {
    notice('error', res.reason)
    return
  }
  dispatch({ type: 'session-opened', session: res.session })
  dispatch({ type: 'messages-restored', sessionId: res.session.id, messages: res.messages })
  await refreshProjectInfo(res.session.id)
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
  renderRail()
  renderView()
  renderSidebar()
  renderTopbar()
  renderStream()
  renderPanel()
  renderModal()
  renderNotices()
}

/**
 * 导航条。每一项的徽标都是**实时状态**，不是装饰：
 * 会话数 / 当前模型 / 技能数 / MCP 已连接比。
 *
 * 只写 `className` 和 `textContent`，不用 `setAttribute` —— `tests/renderer-dom.mjs`
 * 的假 DOM 只有 dataset 和 classList。
 */
function renderRail() {
  const session = activeSession()
  const project = state.project

  els.railProject.textContent = cwd ? lastSegment(cwd) : '未选项目'
  els.railProject.title = cwd || '还没选项目目录'

  paintNav(els.navSessions, els.badgeSessions, 'sessions', String(state.order.length), '进行中的会话')
  paintNav(els.navModel, els.badgeModel, 'model', session?.model ?? '', '当前会话使用的模型')
  paintNav(
    els.navSkills,
    els.badgeSkills,
    'skills',
    project ? String(project.skills.length) : '',
    '当前项目发现的技能',
  )
  paintNav(els.navMcp, els.badgeMcp, 'mcp', mcpBadge(project), '已连接 / 已配置的 MCP 服务器')
}

function paintNav(button, badge, view, text, hint) {
  button.className = `rail-item${state.view === view ? ' is-current' : ''}`
  button.title = text ? `${hint}：${text}` : hint
  badge.textContent = text
}

function mcpBadge(project) {
  if (!project) return ''
  const servers = project.mcp ?? []
  if (servers.length === 0) return '0'
  const connected = servers.filter((s) => s.state === 'connected').length
  return `${connected}/${servers.length}`
}

/** 只取路径最后一段。Windows 上两种分隔符都可能出现 */
function lastSegment(p) {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function renderView() {
  const sessions = state.view === 'sessions'
  els.viewSessions.hidden = !sessions
  els.viewSettings.hidden = sessions
  els.app.dataset.view = state.view
  if (!sessions) renderSettings()
}

/**
 * 设置页是**按 key 增量重建**的，同 `renderModal` 那套。少了这道判断，
 * 流式输出期间每一帧都会把整块重画一遍，「默认模型」输入框会当场失焦。
 */
let settingsKey = null

function renderSettings() {
  const meta = SETTINGS_META[state.view]
  if (!meta) return
  const project = state.project

  if (!project) {
    settingsKey = null
    els.settingsTitle.textContent = meta.title
    els.settingsSub.textContent = meta.sub
    els.settingsBody.replaceChildren(
      emptyBlock('还没有打开的会话。技能与 MCP 挂在项目的运行时上，先在左栏开一个会话再回来看。'),
    )
    return
  }

  // baseUrl 必须并进指纹：切厂商改的就是它，漏了就变成「点完厂商页面纹丝不动」
  const key = [
    state.view,
    project.cwd,
    project.provider.baseUrl,
    project.provider.model,
    mcpFingerprint(project),
  ].join('|')
  els.settingsTitle.textContent = meta.title
  els.settingsSub.textContent = meta.sub
  if (key === settingsKey) return
  settingsKey = key

  if (state.view === 'model') els.settingsBody.replaceChildren(...modelSections(project))
  else if (state.view === 'skills') els.settingsBody.replaceChildren(...skillsBlock(project))
  else els.settingsBody.replaceChildren(...mcpBlocks(project))
}

/** 只要服务器的状态变了就得重画（开关、连接失败、工具数变化） */
function mcpFingerprint(project) {
  return (project.mcp ?? []).map((s) => `${s.name}:${s.state}:${s.toolCount}`).join(',')
}

// ------------------------------------------------------------ 模型配置页

function modelSections(project) {
  const { provider, context, permissions } = project
  const preset = vendorOf(project)

  return [
    section('供应商', [
      row('厂商', vendorSelect(project)),
      row('接口地址', editBaseUrl(provider)),
      row('密钥', provider.apiKeyHint ? mono(provider.apiKeyHint) : dim('没有可用的密钥')),
      row('密钥来源', keySource(preset)),
      row('默认模型', editModel(provider.model, preset ? preset.models : [])),
    ]),
    section('推理', [
      row('温度', mono(String(provider.temperature))),
      row('最大输出', mono(`${provider.maxTokens} token`)),
    ]),
    section('上下文', [
      row('窗口大小', mono(`${context.window} token`)),
      row('自动压缩', mono(context.autoCompact ? `开启（占用超过 ${context.compactThreshold} 时触发）` : '关闭')),
      row('单轮步数上限', mono(String(context.maxSteps))),
    ]),
    section('权限（项目默认）', [
      row('模式', mono(permissions.mode)),
      row('允许规则', tags(permissions.allow)),
      row('拒绝规则', tags(permissions.deny)),
    ]),
    section('配置文件', [
      row('路径', mono(project.configFile)),
      row('优先级', dim('默认值 < 环境变量（含 .env）< 全局 config.json < 项目 config.json < 命令行参数')),
    ]),
  ]
}

/**
 * 当前厂商。**主进程按 baseUrl 推导好 key 才下发**（renderer 走 `app://`，
 * import 不到 `dist/provider/vendors.js`），这里只按 key 查表、不自己判 ——
 * 两边各写一套判据，迟早互相矛盾。
 */
function vendorOf(project) {
  return (project.vendors ?? []).find((v) => v.key === project.provider.vendorKey) ?? null
}

/** 厂商选择器。选了就**立刻写盘**（地址 + 模型原子写入），没有二次确认 */
function vendorSelect(project) {
  const box = document.createElement('div')
  box.className = 'vendor-pick'

  const select = document.createElement('select')
  select.setAttribute('aria-label', '厂商')
  for (const vendor of project.vendors ?? []) {
    const option = document.createElement('option')
    option.value = vendor.key
    option.textContent = vendor.label
    select.append(option)
  }
  // 「自定义」排最后，兜住手填的地址（各家的区域变体、公司自建网关）
  const custom = document.createElement('option')
  custom.value = '__custom__'
  custom.textContent = '自定义（自己填接口地址）'
  select.append(custom)
  // **全部 append 完再设 value**：顺序反了选项还不存在，真浏览器里相当于没选中
  select.value = project.provider.vendorKey
  select.addEventListener('change', () => void saveVendor(project, select.value))
  box.append(select)

  // 各家的坑（豆包要 /api/coding/v3、智谱是 /v4…）由预置表出，界面只负责摆位置
  const preset = vendorOf(project)
  if (preset?.note) box.append(dim(preset.note))
  return box
}

function editBaseUrl(provider) {
  return editLine('接口地址', provider.baseUrl, '存为接口地址', '写回项目配置文件，立刻对本项目的所有会话生效', saveBaseUrl)
}

function editModel(current, models) {
  const box = document.createElement('div')
  box.append(
    editLine('默认模型', current, '存为默认', '写回项目配置文件，只影响之后新建的会话', saveDefaultModel),
  )
  // 候选挂在编辑行**下面**（外层多包一个 div，别塞进 `.set-edit` —— 那是个 flex 行，
  // 多一个孩子会把候选挤到输入框同一行上）
  const input = box.children[0].children[0]
  if (models.length > 0) box.append(modelTags(models, input))
  return box
}

/**
 * 输入框 + 「存为…」按钮。`children[0]` 是 input、`children[1]` 是按钮，**顺序是契约**，
 * 测试按这个形状取；多一个孩子得挂在外面（见 `editModel`）。
 */
function editLine(label, value, action, hint, save) {
  const wrap = document.createElement('div')
  wrap.className = 'set-edit'

  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.value = value
  input.setAttribute('aria-label', label)

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = action
  button.title = hint
  button.addEventListener('click', () => void save(input))

  wrap.append(input, button)
  return wrap
}

/**
 * 候选模型名，点一下填进输入框 —— **不写盘**，写盘是「存为默认」的活。
 * 不复用 `tags()`：那个是权限页的只读标签，别把点击行为加给所有 `.tag`。
 */
function modelTags(models, input) {
  const box = document.createElement('div')
  box.className = 'tag-pick'
  for (const model of models) {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = model
    tag.title = '点一下填进输入框（还要点「存为默认」才写盘）'
    tag.addEventListener('click', () => {
      input.value = model
    })
    box.append(tag)
  }
  return box
}

/**
 * 「密钥来源」只能是真话：`loadConfig` 认哪个变量，这里就得说哪个。
 * 说不出真话的后果不是难看，是用户照着设了变量、然后对着 401 不知道哪儿错了。
 */
function keySource(preset) {
  if (!preset) return dim('未识别厂商：密钥按 CLAUDA_API_KEY / OPENAI_API_KEY 读取')
  if (!preset.envKey) return dim('不需要密钥')
  return mono(`${preset.envKey}（在 .env 或环境变量里设）`)
}

async function saveVendor(project, key) {
  // 「自定义」没有可写的地址：留着用户手填的那一份，什么都不发
  if (key === '__custom__') return
  const res = await invoke('project/set-vendor', { cwd: project.cwd, vendorKey: key })
  if (!res.ok) {
    notice('error', `切换厂商失败：${res.reason}`)
    // 失败时地址没变，指纹也就不变 —— 作废缓存强制重建，否则选择器停在新那一项上
    // 而实际还是旧端点（和 MCP 开关那个谎同一个坑）
    settingsKey = null
    await refreshProjectInfo(activeSession()?.id)
    return
  }
  const label = (project.vendors ?? []).find((v) => v.key === key)?.label ?? key
  notice('info', `已切到 ${label}，接口地址与模型一起写入了 ${res.file}`)
  await refreshProjectInfo(activeSession()?.id)
  // 会话的模型被一起换掉了，顶栏和导航徽标得跟着走
  const session = activeSession()
  if (session) await refreshSession(session.id)
}

async function saveBaseUrl(input) {
  const projectCwd = state.project?.cwd
  const baseUrl = input.value.trim()
  if (!projectCwd) {
    notice('warn', '先选一个项目目录')
    return
  }
  if (!baseUrl) {
    notice('warn', '接口地址不能为空')
    return
  }
  const res = await invoke('project/set-base-url', { cwd: projectCwd, baseUrl })
  if (!res.ok) {
    notice('error', `接口地址没写进去：${res.reason}`)
    return
  }
  notice('info', `接口地址已写入 ${res.file}，立刻对本项目的会话生效`)
  await refreshProjectInfo(activeSession()?.id)
}

async function saveDefaultModel(input) {
  const model = input.value.trim()
  if (!cwd) {
    notice('warn', '先选一个项目目录')
    return
  }
  if (!model) {
    notice('warn', '模型名不能为空')
    return
  }
  const res = await invoke('project/set-default-model', { cwd, model })
  if (!res.ok) {
    notice('error', `默认模型没写进去：${res.reason}`)
    return
  }
  notice('info', `默认模型已写入 ${res.file}，只影响之后新建的会话`)
  await refreshProjectInfo(activeSession()?.id)
}

// ------------------------------------------------------------ 技能页

function skillsBlock(project) {
  const skills = project.skills ?? []
  if (skills.length === 0) {
    return [emptyBlock('没有发现技能。在 .clauda/skills/<名字>/SKILL.md 或 ~/.clauda/skills/<名字>/SKILL.md 放一份即可。')]
  }

  const list = document.createElement('div')
  list.className = 'set-rows'
  for (const skill of skills) {
    const row = document.createElement('div')
    row.className = 'skill-row'

    const name = document.createElement('div')
    name.className = 'skill-name'
    name.textContent = `/${skill.name}`

    const desc = document.createElement('div')
    desc.className = 'skill-desc'
    desc.textContent = skill.description || '（没有写描述）'

    const file = document.createElement('div')
    file.className = 'skill-file'
    file.textContent = skill.file

    row.append(name, desc, file)
    list.append(row)
  }
  return [list]
}

// ------------------------------------------------------------ MCP 页

function mcpBlocks(project) {
  const servers = project.mcp ?? []
  if (servers.length === 0) {
    return [emptyBlock('没有配置 MCP 服务器。在 config.json 的 mcpServers 里加一个即可（格式见 README）。')]
  }

  const list = document.createElement('div')
  list.className = 'set-rows'
  list.append(...servers.map(mcpRow))

  const blocks = [list]
  // 这两句的措辞由 `mcpCostNotice` 统一出（src/runtime/mcp-cost.ts），
  // 桌面端只负责摆位置，别在这里另写一套
  if (project.mcpCost?.infoText) blocks.push(footNote(project.mcpCost.infoText, false))
  if (project.mcpCost?.warnText) blocks.push(footNote(project.mcpCost.warnText, true))
  return blocks
}

function mcpRow(server) {
  const row = document.createElement('div')
  row.className = 'mcp-row'
  // 认得出这一行是哪台服务器。测试靠它精确定位到某一行，不然只能按下标猜
  row.dataset.name = server.name

  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.className = 'switch'
  toggle.checked = server.state === 'connected'
  toggle.setAttribute('aria-label', `${server.name}：${MCP_STATE[server.state] ?? server.state}`)
  toggle.addEventListener('change', () => void toggleMcp(server.name, toggle.checked))

  const main = document.createElement('div')
  const name = document.createElement('div')
  name.className = 'mcp-name'
  name.textContent = server.name
  const meta = document.createElement('div')
  meta.className = 'mcp-meta'
  meta.textContent = `${server.transport} · 工具 ${server.toolCount}`
  main.append(name, meta)

  const status = document.createElement('span')
  status.className = `mcp-state ${server.state}`
  status.textContent = MCP_STATE[server.state] ?? server.state

  row.append(toggle, main, status)

  // 失败原因铺满一整行。挤在状态那列里会被截断，而用户正是靠它判断哪儿配错了
  if (server.error) {
    const err = document.createElement('pre')
    err.className = 'mcp-error'
    err.textContent = server.error
    row.append(err)
  }
  return row
}

async function toggleMcp(name, enabled) {
  if (!cwd) return
  const res = await invoke('mcp/set-enabled', { cwd, name, enabled })
  if (res.ok) {
    notice('info', `已${enabled ? '接入' : '摘除'} MCP 服务器 ${name}`)
  } else {
    // 失败必须说出来。早先这条通道无条件返回 ok，界面会显示「已接入」而工具一个没多
    notice('error', `${enabled ? '接入' : '摘除'} ${name} 失败：${res.reason}`)
    // **失败时服务器的状态没变，指纹也就不变**，光重拉的话 `renderSettings` 会
    // 按指纹判定「没变化」直接返回，开关就停在用户刚拨过去的那一侧 ——
    // 显示「已接入」而实际没接上，正是这次要修的那个谎。作废掉缓存强制重建
    settingsKey = null
  }
  // 成功失败都要重拉：开关已经被用户拨过去了，界面得回到真实状态
  await refreshProjectInfo(activeSession()?.id)
  const session = activeSession()
  if (session) await refreshSession(session.id)
}

// ------------------------------------------------------------ 设置页零件

function section(title, rows) {
  const box = document.createElement('section')
  box.className = 'set-section'
  const head = document.createElement('h2')
  head.textContent = title
  const list = document.createElement('div')
  list.className = 'set-rows'
  list.append(...rows)
  box.append(head, list)
  return box
}

function row(key, valueNode) {
  const line = document.createElement('div')
  line.className = 'set-row'
  const k = document.createElement('div')
  k.className = 'set-key'
  k.textContent = key
  const v = document.createElement('div')
  v.className = 'set-val'
  v.append(valueNode)
  line.append(k, v)
  return line
}

function mono(text) {
  return span(text, 'mono')
}

function dim(text) {
  return span(text, 'dim')
}

function span(text, className) {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

function tags(values) {
  const box = document.createElement('div')
  if (!values || values.length === 0) {
    box.append(dim('（空）'))
    return box
  }
  for (const value of values) {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = value
    box.append(tag)
  }
  return box
}

function footNote(text, warn) {
  const p = document.createElement('p')
  p.className = `mcp-foot${warn ? ' warn' : ''}`
  p.textContent = text
  return p
}

/** 空态是「指方向」不是「发情绪」：说清为什么空、下一步做什么 */
function emptyBlock(text) {
  const p = document.createElement('p')
  p.className = 'settings-empty'
  p.textContent = text
  return p
}

// ------------------------------------------------------------ 会话视图

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

for (const [button, view] of [
  [els.navSessions, 'sessions'],
  [els.navModel, 'model'],
  [els.navSkills, 'skills'],
  [els.navMcp, 'mcp'],
]) {
  button.addEventListener('click', () => {
    if (state.view === view) return
    dispatch({ type: 'view', view })
    // 进设置页时重拉一次：徽标是每轮刷的，但用户点进来的这一刻要保证是新的
    if (view !== 'sessions') void refreshProjectInfo(state.activeId)
  })
}

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
