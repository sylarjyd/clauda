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
import {
  attachmentPayload,
  changedFiles,
  createState,
  MAX_IMAGE_BYTES,
  reduce,
  streamPlan,
  todoItems,
} from './state.js'

const els = {
  app: document.getElementById('app'),

  // 左导航条
  navSessions: document.getElementById('nav-sessions'),
  navAgents: document.getElementById('nav-agents'),
  navModel: document.getElementById('nav-model'),
  navSkills: document.getElementById('nav-skills'),
  navMcp: document.getElementById('nav-mcp'),
  // 「设置」那一个按钮，和它底下收着的四项。按钮自己不切视图，只翻分组
  navSettings: document.getElementById('nav-settings'),
  settingsGroup: document.getElementById('settings-group'),
  // 点开「设置」时让位的两块。用 id 而不是 `querySelector('.browse')`：
  // 假 DOM（tests/renderer-dom.mjs）只实现了 getElementById
  rail: document.getElementById('rail'),
  browse: document.getElementById('browse'),
  badgeSessions: document.getElementById('badge-sessions'),
  badgeAgents: document.getElementById('badge-agents'),
  badgeModel: document.getElementById('badge-model'),
  badgeSkills: document.getElementById('badge-skills'),
  badgeMcp: document.getElementById('badge-mcp'),

  // 会话视图
  viewSessions: document.getElementById('view-sessions'),
  // 设置视图（智能体 / 模型 / 技能 / MCP 四个页面共用）
  viewSettings: document.getElementById('view-settings'),
  settingsTitle: document.getElementById('settings-title'),
  settingsSub: document.getElementById('settings-sub'),
  settingsBody: document.getElementById('settings-body'),

  newSession: document.getElementById('new-session'),
  newSessionAgent: document.getElementById('new-session-agent'),
  pickProject: document.getElementById('pick-project'),
  projectPath: document.getElementById('project-path'),
  sessionList: document.getElementById('session-list'),
  notices: document.getElementById('notices'),
  chatTitle: document.getElementById('chat-title'),
  chatAgent: document.getElementById('chat-agent'),
  modelInput: document.getElementById('model-input'),
  modeSelect: document.getElementById('mode-select'),
  contextFill: document.getElementById('context-fill'),
  stream: document.getElementById('stream'),
  emptyQuestions: document.getElementById('empty-questions'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  attachList: document.getElementById('attach-list'),
  attach: document.getElementById('attach'),
  dropHint: document.getElementById('drop-hint'),
  abort: document.getElementById('abort'),
  changedFiles: document.getElementById('changed-files'),
  todos: document.getElementById('todos'),
  modalHost: document.getElementById('modal-host'),
}

const STATUS_LABEL = { running: '进行中', ok: '完成', error: '失败', done: '已结束' }

/** MCP 服务器状态的中文。措辞与 CLI 的 `/mcp` 保持一致 */
const MCP_STATE = { connected: '已连接', failed: '失败', disabled: '未启用' }

/**
 * 四个设置页的标题与说明。说明里那几句不是装饰 —— 它们解释了「这个数从哪来、
 * 改了会影响什么」，是这几页唯一能防止误操作的东西。
 */
const SETTINGS_META = {
  agents: {
    title: '智能体',
    // 「只影响之后新建的会话」这件事必须在用户动手之前说 —— 它是这一页唯一一处
    // 和技能/MCP 那两页**相反**的行为，不讲清就会被当成 bug
    sub: '一整套「你是谁 + 用哪个模型 + 能用哪些工具和技能 + 什么权限 + 开口问什么」的配方，存在 .clauda/agents/<名字>/AGENT.md。左栏点一个来编辑，开新会话时在左栏「＋ 新会话」上面挑一个（设置页里能标一个本项目默认）。改一个智能体只影响之后新建的会话 —— 已经开着的会话在创建那一刻就把配方钉住了，和「模型 / 端点只对新会话生效」是同一条理由。',
  },
  model: {
    title: '模型配置',
    sub: '同一个项目可以同时存好几家厂商的档案：左栏点一份来编辑，右栏改它的参数，徽标标出正在用的是哪一份。这里改的只对之后新建的会话生效 —— 已经开着的会话，端点和模型在创建那一刻就定下来了；当前会话的模型在中栏顶栏上改。',
  },
  skills: {
    title: '技能',
    sub: '从 ~/.clauda/skills 与沿途各级 .clauda/skills 发现。离当前项目越近的同名技能优先。新增的技能立刻生效，当前会话就能用。',
  },
  mcp: {
    // 左栏和页标题都叫「工具」：用户在这页上装的是「能让 agent 干活的东西」，
    // 页内正文才保留「MCP 服务器」——一个服务器会带出很多个工具，
    // 正文里丢掉这个名字会让「服务器连不上」和「工具没接上」分不清
    title: '工具',
    sub: '由 MCP 服务器提供，存在 config.json 的 mcpServers 里，新增和删除都会写回配置文件。每行那个开关只在本次运行内有效，不动配置文件。',
  },
}

let state = createState()

/**
 * 上次待在哪个设置页，供底部的「设置」回跳。
 *
 * **纯界面状态**，不进 reducer —— 它同样和会话、项目都没关系，关掉窗口忘掉即可。
 * 默认落在智能体：它排在最前面，也是设置里最常改的一项。
 */
let lastSettingsView = 'agents'
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
 * **跟着项目目录走，不跟着会话走**：技能与 MCP 挂在项目运行时上，而配它们正是开第一个
 * 会话之前想做的事。主进程会按 cwd 把运行时建起来（幂等，见 `ensureProject`），
 * 所以这里只要有个目录就该拉，没目录才清空。
 */
async function refreshProjectInfo() {
  if (!cwd) {
    dispatch({ type: 'project-info', info: null })
    return
  }
  const res = await invoke('project/info', { cwd })
  dispatch({ type: 'project-info', info: res.ok ? res.info : null })
}

/**
 * `agentWarning` **只在第一次看见时**弹一次通知。
 *
 * `session/state` 是高频的（每轮结束、切模型、切模式之后都拉一次），每来一次快照就
 * 弹一次会把通知栏刷满同一条，而那条通知本身说的是一个**不会变**的事实。
 * 按会话 id 记，切走再切回来也不再弹 —— 用户已经看过一次了。
 */
const warnedAgentSessions = new Set()

function noteAgentWarning(sessionId) {
  const session = state.sessions[sessionId]
  if (!session?.agentWarning || warnedAgentSessions.has(sessionId)) return
  warnedAgentSessions.add(sessionId)
  notice('warn', session.agentWarning)
}

/** 一轮结束、切模型/模式之后调：刷新右栏、上下文条、侧边栏的历史列表 */
async function refreshSession(sessionId) {
  const session = state.sessions[sessionId]
  if (!session) return
  const res = await invoke('session/state', { sessionId })
  if (res.ok) {
    dispatch({ type: 'session-state', sessionId, session: res.session })
    noteAgentWarning(sessionId)
  }
  await refreshHistory(session.cwd)
  await refreshProjects()
  // 顺手刷导航条徽标。这里是内存里的现成数据，不贵
  await refreshProjectInfo()
}

/**
 * 把中栏换回对话。
 *
 * 「点一行会话」本质上是「我要看它」，而左栏那块会话浏览区现在是**五个视图下都常驻**
 * 的（见 style.css），所以在设置页上点它必须能把中栏换回来 —— 不然就正好复现它当初
 * 被收起时那个毛病：一块看得见、点下去没反应的区域。
 *
 * `＋新会话` 走的是同一条：造一个新的出来，当然是给你看的。
 */
function showSessions() {
  if (state.view !== 'sessions') dispatch({ type: 'view', view: 'sessions' })
}

async function openNewSession() {
  if (!cwd) {
    notice('warn', '先选一个项目目录')
    return
  }
  // **总是带 `agent`，且带的是具体字符串**（没选就是空串）。空串是「明确不要智能体」，
  // 和「没给这个键」在主进程那边是两条路 —— 后者会去套**当下的**项目默认，
  // 那正是「用户什么都没点、行为却变了」的来源
  const agent = els.newSessionAgent.value ?? ''
  const res = await invoke('session/open', { cwd, agent })
  if (!res.ok) {
    notice('error', res.reason)
    return
  }
  showSessions()
  dispatch({ type: 'session-opened', session: res.session })
  noteAgentWarning(res.session.id)
  await refreshProjectInfo()
}

async function openHistory(id) {
  const res = await invoke('session/resume', { cwd, id })
  if (!res.ok) {
    notice('error', res.reason)
    return
  }
  showSessions()
  dispatch({ type: 'session-opened', session: res.session })
  dispatch({ type: 'messages-restored', sessionId: res.session.id, messages: res.messages })
  noteAgentWarning(res.session.id)
  await refreshProjectInfo()
}

// ------------------------------------------------------------------ 事件入口

/**
 * IPC 事件入口。
 *
 * **这里不接项目级诊断。** MCP 连不上之类的消息由主进程的 `onWarn` 直接打控制台
 * （`desktop/main.js`），从不往窗口推 —— 底部那条通知栏只放「你刚做了什么」，
 * 掺进子进程的原始报错就是刷屏。失败本身在「工具」页上看得见。
 *
 * 通知栏里那些成功/失败提示走的是另一条路：渲染层自己的 `notice()`。
 */
function applyEvent(sessionId, event) {
  dispatch({ ...event, sessionId })

  // 快照是 `agentWarning` 唯一的来路。它也是高频的，去重那一步在 `noteAgentWarning` 里
  if (event.type === 'session-state') noteAgentWarning(sessionId)

  // 状态回到 idle 就说明这一轮彻底结束了，这时去要一次权威快照
  if (event.type === 'session-status' && event.status === 'idle') void refreshSession(sessionId)
}

// ------------------------------------------------------------------ 渲染

function render() {
  renderRail()
  renderView()
  renderSidebar()
  renderNewSessionAgent()
  renderTopbar()
  renderAttachments()
  renderStream()
  renderEmptyQuestions()
  renderPanel()
  renderModal()
  renderNotices()
}

/**
 * 左栏顶部的导航条。每一项的徽标都是**实时状态**，不是装饰：
 * 会话数 / 当前模型 / 技能数 / 智能体数 / MCP 已连接比。
 *
 * 只写 `className` 和 `textContent`，不用 `setAttribute` —— `tests/renderer-dom.mjs`
 * 的假 DOM 只有 dataset 和 classList。
 */
function renderRail() {
  const session = activeSession()
  const project = state.project

  paintNav(els.navSessions, els.badgeSessions, 'sessions', String(state.order.length), '进行中的会话')
  // 智能体这一格给的是**当前项目有多少个**，不是「这个会话绑了谁」—— 后者是
  // 中栏顶栏 `#chat-agent` 的活。同项目两个会话可以绑不同的智能体，一个格子装不下两件事
  paintNav(
    els.navAgents,
    els.badgeAgents,
    'agents',
    project ? String((project.agents ?? []).length) : '',
    '当前项目发现的智能体',
  )
  paintNav(els.navModel, els.badgeModel, 'model', session?.model ?? '', '当前会话使用的模型')
  paintNav(
    els.navSkills,
    els.badgeSkills,
    'skills',
    project ? String(project.skills.length) : '',
    '当前项目发现的技能',
  )
  paintNav(els.navMcp, els.badgeMcp, 'mcp', mcpBadge(project), '已连接 / 已配置的 MCP 服务器')

  // 「设置」那一格：四个设置页里任意一个开着就算「当前」。它自己没有徽标 —— 底下四项
  // 各有一个，硬拼成一个数只会是谁也读不懂的四个数字挤在一起。
  //
  // 展开态写在 `aria-expanded` 上而不是 class 上：CSS 那个小三角靠它翻方向，
  // 而 `className` 这一格要留给 `is-current`。
  const inSettings = state.view !== 'sessions'
  els.navSettings.className = `rail-item${inSettings ? ' is-current' : ''}`
  els.navSettings.setAttribute('aria-expanded', inSettings ? 'true' : 'false')

  // 点开「设置」= 左栏**整个换内容**：会话那一格和会话列表一起让位，四项接替到最上面
  // （用户的原话是「点击设置 隐藏会话相关内容」）。
  //
  // 三块都从 `inSettings` 这**一个**布尔推出来，不留第二个标志 —— 否则迟早出现
  // 「分组收着、视图却在技能页」那种左边一片空白的组合。
  els.settingsGroup.hidden = !inSettings
  els.rail.hidden = inSettings
  els.browse.hidden = inSettings
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

/**
 * 左栏**选中**要编辑的那份档案，以及正在等第二次确认的删除。
 *
 * 两个都是**纯界面状态**：「选中」不是「当前使用」（后者在主进程那边，只有点
 * 「设为当前使用的厂商」才变），删除的两步确认也只是为了让不可逆的动作慢一格。
 */
let selectedProfile = null
let pendingRemove = null

/**
 * 技能 / MCP 两个新增表单的展开态，以及各行等待第二次确认的删除。
 *
 * 表单里**已经打进去的字也存这儿**，但**绝不进 `settingsKey` 指纹**。两件事要分开看：
 * 存下来是为了指纹因别的原因变了（比如另一台 MCP 连上了）重画时能把内容填回去；
 * 而一旦进了指纹，就变成「打一个字重画一次」—— 每次 `replaceChildren` 都会把输入框
 * 连焦点一起抖掉，那正是这套增量重绘存在的理由（见 `renderSettings` 上面那段）。
 *
 * 两个删除是**独立的两步确认**，不复用 `pendingRemove`：那一个存的是厂商档案的 key，
 * 和一个技能名/服务器名撞在一起时，A 页的确认框会跑到 B 页上去。
 */
const skillForm = { open: false, scope: 'global', name: '', description: '', body: '' }
const mcpForm = {
  open: false,
  scope: 'project',
  type: 'stdio',
  name: '',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
}
let pendingSkillRemove = null
let pendingMcpRemove = null

/** 换项目、或者项目运行时还没就绪时，把两个表单和两处待删一起归位 */
function resetSettingsForms() {
  skillForm.open = false
  skillForm.name = ''
  skillForm.description = ''
  skillForm.body = ''
  mcpForm.open = false
  mcpForm.name = ''
  mcpForm.command = ''
  mcpForm.args = ''
  mcpForm.env = ''
  mcpForm.url = ''
  mcpForm.headers = ''
  // 智能体草稿也一起归位：留着的话「范围=本项目」指向的已经是另一个项目了，
  // 而那个待确认的删除指向的是上一个项目里的智能体
  resetAgentDraft()
  agentDraft.loaded = 0
  pendingSkillRemove = null
  pendingMcpRemove = null
  pendingAgentRemove = null
}

function renderSettings() {
  const meta = SETTINGS_META[state.view]
  if (!meta) return
  const project = state.project

  if (!project) {
    settingsKey = null
    selectedProfile = null
    pendingRemove = null
    resetSettingsForms()
    els.settingsTitle.textContent = meta.title
    els.settingsSub.textContent = meta.sub
    els.settingsBody.replaceChildren(
      emptyBlock(
        cwd
          ? '项目运行时还没就绪，稍后再点进来看看。'
          : '先在左栏选一个项目目录 —— 技能与 MCP 都挂在项目上。',
      ),
    )
    return
  }

  // 选中那份落回真实存在的档案上：删掉、或者换了项目之后，`selectedProfile` 可能指向
  // 一个已经没有的名字。写回解析结果，指纹才是稳定的
  selectedProfile = selectedProfileOf(project)?.key ?? null

  // 档案的每一份都要并进指纹（key/地址/模型/密钥提示任何一个变了都得重画），
  // 选中的哪一份也要 —— 点了左栏不重画的话，右栏看起来纹丝不动，像点了个没用的东西
  const key = [
    state.view,
    project.cwd,
    project.activeProvider,
    selectedProfile,
    pendingRemove,
    (project.profiles ?? [])
      .map((p) => `${p.key}:${p.baseUrl}:${p.model}:${p.apiKeyHint}`)
      .join(','),
    mcpFingerprint(project),
    // 技能列表原先**不在指纹里**：加完一个技能不会重画，列表看起来纹丝不动。
    // 只并名字和路径 —— 描述和正文改了也该重画，但那两样只有从磁盘重读时才变
    (project.skills ?? []).map((s) => `${s.name}:${s.file}`).join(','),
    // 智能体那份同理，外加 `isDefault`（点「设为默认」必须当场看见）和 `problem`
    // （档案删了之后那句降级提示得浮出来）
    (project.agents ?? []).map((a) => `${a.name}:${a.isDefault}:${a.problem}`).join(','),
    // 两个表单的**展开态**和两处待删。表单里正在输入的值不在这儿，理由见
    // `skillForm` 那段注释
    skillForm.open ? 'sf' : '',
    mcpForm.open ? 'mf' : '',
    pendingSkillRemove ?? '',
    pendingMcpRemove ?? '',
    // 智能体草稿只并这个**序号**：每读进一份（或清成一份空的）加一，于是换编辑对象
    // 会重画，而打字不会。草稿里那些会变的字段绝不进指纹，理由见 `agentDraft` 注释
    `ad${agentDraft.loaded}`,
    pendingAgentRemove ?? '',
  ].join('|')
  els.settingsTitle.textContent = meta.title
  els.settingsSub.textContent = meta.sub
  if (key === settingsKey) return
  settingsKey = key

  if (state.view === 'agents') els.settingsBody.replaceChildren(...agentBlocks(project))
  else if (state.view === 'model') els.settingsBody.replaceChildren(...modelSections(project))
  else if (state.view === 'skills') els.settingsBody.replaceChildren(...skillsBlock(project))
  else els.settingsBody.replaceChildren(...mcpBlocks(project))
}

/** 只要服务器的状态变了就得重画（开关、连接失败、工具数变化） */
function mcpFingerprint(project) {
  return (project.mcp ?? []).map((s) => `${s.name}:${s.state}:${s.toolCount}`).join(',')
}

// ------------------------------------------------------------ 模型配置页

function modelSections(project) {
  const { context, permissions } = project

  return [
    // 温度 / 最大输出不算独立一节：它们和地址、密钥一样是**某一份档案**的属性，
    // 单列出去之后「这份档案的温度」和「那份档案的温度」就分不出来了
    section('供应商', [vendorPane(project)]),
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
 * 「供应商」那一整块：**左栏列出所有档案，右栏是选中那份的参数**。
 *
 * 一个下拉框回答不了多厂商下的三个问题 —— 我配过哪几家、现在用哪家、正在改哪家。
 * 左栏把「有哪些」画出来，徽标标出「当前使用」，高亮标出「正在改」。
 */
function vendorPane(project) {
  const profiles = project.profiles ?? []
  const selected = selectedProfileOf(project)
  const preset = selected ? presetOf(project, selected) : null

  const list = document.createElement('div')
  list.className = 'vendor-list'
  for (const profile of profiles) list.append(vendorRow(profile, profile.key === selected?.key))
  list.append(vendorAdd(project))

  const config = document.createElement('div')
  config.className = 'vendor-config'
  if (selected) config.append(...vendorRows(project, selected, preset))

  const pane = document.createElement('div')
  pane.className = 'vendor-pane'
  pane.append(list, config)
  return pane
}

/**
 * 左栏一行。`dataset.key` 是**给测试用的把手**（按它精确点到某一份，不用按下标猜），
 * 也让「这一行是哪份档案」在 DOM 上看得见。
 */
function vendorRow(profile, isSelected) {
  const row = document.createElement('button')
  row.type = 'button'
  // 借 `rail-item` 的观感（同样的 flex 布局、hover、圆角），但**不用 `is-current`** ——
  // 那个在左导航里是「当前视图」，这里的「选中」是另一回事
  row.className = `rail-item vendor-row${isSelected ? ' is-selected' : ''}`
  row.dataset.key = profile.key
  row.title = profile.baseUrl || '（还没填接口地址）'

  const name = document.createElement('span')
  name.className = 'rail-label'
  name.textContent = profile.label

  // 徽标位只放状态，不占第二行
  const badge = document.createElement('span')
  badge.className = `rail-badge${profile.isActive ? ' is-active' : ''}`
  badge.textContent = profile.isActive ? '当前使用' : profile.baseUrl ? '' : '未填地址'

  row.append(name, badge)
  row.addEventListener('click', () => {
    // 换编辑目标 = 上一次的删除念头作废（那是个两步确认，见 `removeButton`）
    selectedProfile = profile.key
    pendingRemove = null
    render()
  })
  return row
}

/**
 * 「+ 添加厂商」。**这是一个命令，不是一个状态** —— 选完立刻归位到「+ 添加厂商」那一项，
 * 失败时也不会停在刚选的那一项上装作已经加上了。
 *
 * 只列**还没有的**预置厂商：已经配过的那家该去左栏点它，而不是再添一份重名的。
 */
function vendorAdd(project) {
  const box = document.createElement('div')
  box.className = 'vendor-add'

  const select = document.createElement('select')
  select.setAttribute('aria-label', '添加厂商')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '+ 添加厂商'
  select.append(none)

  for (const vendor of project.vendors ?? []) {
    if ((project.profiles ?? []).some((p) => p.key === vendor.key)) continue
    const option = document.createElement('option')
    option.value = vendor.key
    option.textContent = vendor.label
    select.append(option)
  }
  // 「自定义」排最后，兜住各家的区域变体、公司自建网关。它的地址留空，由用户自己填 ——
  // 预先塞一个内置默认地址就成了「静默指向 OpenAI」
  const custom = document.createElement('option')
  custom.value = '__custom__'
  custom.textContent = '自定义（自己填接口地址）'
  select.append(custom)

  select.value = ''
  select.addEventListener('change', () => {
    const chosen = select.value
    select.value = ''
    void addProfile(project, chosen)
  })
  box.append(select)
  return box
}

function vendorRows(project, profile, preset) {
  return [
    row(
      '接口地址',
      editLine('接口地址', profile.baseUrl, '存为接口地址', '写回项目配置文件，只影响之后新建的会话', (input) =>
        saveBaseUrl(project, profile, input),
      ),
    ),
    row('密钥', profile.apiKeyHint ? mono(profile.apiKeyHint) : dim('没有可用的密钥')),
    row('密钥来源', keySource(preset)),
    row('默认模型', editModel(project, profile, preset ? preset.models : [])),
    row('温度', mono(String(profile.temperature))),
    row('最大输出', mono(`${profile.maxTokens} token`)),
    // 各家的坑（豆包要 /api/coding/v3、智谱是 /v4…）由预置表出，界面只负责摆位置
    ...(preset?.note ? [noteLine(preset.note)] : []),
    actionsRow(project, profile),
  ]
}

/**
 * 一个以按钮为值的「行」。不是 `.set-row`：那是个 132px + 1fr 的两列网格，按钮不需要
 * 左边那一列，硬套上去反而要写一堆 `grid-column` 覆盖。
 */
function actionsRow(project, profile) {
  const box = document.createElement('div')
  box.className = 'vendor-actions'

  const activate = document.createElement('button')
  activate.type = 'button'
  activate.textContent = '设为当前使用的厂商'
  activate.disabled = profile.isActive || !profile.baseUrl || !profile.model
  activate.title = profile.isActive
    ? '已经是当前使用的厂商了'
    : !profile.baseUrl || !profile.model
      ? '先填好接口地址和默认模型'
      : '之后新开的会话会用它说话；已经开着的会话不受影响'
  activate.addEventListener('click', () => void activateProfile(project, profile))
  box.append(activate)

  box.append(
    pendingRemove === profile.key
      ? confirmRemove(project, profile)
      : removeButton(project, profile),
  )
  return box
}

function removeButton(project, profile) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'danger'
  button.textContent = '删除'
  // 当前使用的那份**删不了**：删了 activeProvider 就指向一个不存在的名字，配置会静默
  // 退回内置默认值。按钮留着但禁用，原因写在 title 上 —— 干脆不画的话，用户会以为坏了
  button.disabled = profile.isActive
  button.title = profile.isActive
    ? '当前使用的厂商不能删，先切到别家'
    : `从 config.json 里删掉「${profile.key}」这份档案`
  button.addEventListener('click', () => {
    pendingRemove = profile.key
    render()
  })
  return button
}

/**
 * 删除的**第二步**。删一份档案是个不可逆的动作，所以要按两下：第一下把按钮换成这一对，
 * 第二下才真的删。
 *
 * 用两步而不是弹窗：枪就架在这一行上，弹窗反而要把视线从「我要删的是哪一份」移开。
 * 「取消」必须和「确认删除」一样显眼 —— 只留一个红按钮的话，第二下就成了必答题。
 */
function confirmRemove(project, profile) {
  const box = document.createElement('span')
  box.className = 'vendor-confirm'

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'danger'
  yes.textContent = `确认删除「${profile.label}」`
  yes.addEventListener('click', () => void removeProfile(project, profile))

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'ghost'
  no.textContent = '取消'
  no.addEventListener('click', () => {
    pendingRemove = null
    render()
  })

  box.append(yes, no)
  return box
}

function noteLine(text) {
  const p = document.createElement('p')
  p.className = 'vendor-note'
  p.textContent = text
  return p
}

/**
 * 左栏该高亮哪一份：上次选的那份（还在就沿用它）> 当前使用那份 > 第一份。
 *
 * 后两个兜底不是可有可无的：删掉一份、或者切到另一个项目之后，「上次选的那份」很可能
 * 已经不存在了 —— 不兜的话右栏会整块空掉，而文件里明明有档案。
 */
function selectedProfileOf(project) {
  const profiles = project.profiles ?? []
  return (
    profiles.find((p) => p.key === selectedProfile) ??
    profiles.find((p) => p.isActive) ??
    profiles[0] ??
    null
  )
}

/**
 * 选中的那份档案的厂商预置。**主进程按 baseUrl 推导好 key 才下发**（renderer 走
 * `app://`，import 不到 `dist/provider/vendors.js`），这里只按 key 查表、不自己判 ——
 * 两边各写一套判据，迟早互相矛盾。
 */
function presetOf(project, profile) {
  return (project.vendors ?? []).find((v) => v.key === profile.vendorKey) ?? null
}

function editModel(project, profile, models) {
  const box = document.createElement('div')
  box.append(
    editLine('默认模型', profile.model, '存为默认', '写回项目配置文件，只影响之后新建的会话', (input) =>
      saveModel(project, profile, input),
    ),
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

/**
 * 把「接口地址 / 默认模型」写进**选中的那份档案**（不是「当前生效那份」——多厂商下
 * 这两者经常不是一回事）。
 *
 * 活会话不动（配置冻结）：它们的端点和模型冻在创建那一刻，所以写完既不用刷会话，
 * 也不用动顶栏和徽标 —— 那两处显示的是**当前会话**，本来就没变。
 */
async function saveBaseUrl(project, profile, input) {
  const baseUrl = input.value.trim()
  if (!baseUrl) {
    notice('warn', '接口地址不能为空')
    return
  }
  const res = await invoke('project/set-base-url', {
    cwd: project.cwd,
    baseUrl,
    profileKey: profile.key,
  })
  if (!res.ok) {
    notice('error', `接口地址没写进去：${res.reason}`)
    return
  }
  await savedNotice(`已把「${profile.label}」的接口地址写入 ${res.file}`)
}

async function saveModel(project, profile, input) {
  const model = input.value.trim()
  if (!model) {
    notice('warn', '模型名不能为空')
    return
  }
  const res = await invoke('project/set-default-model', {
    cwd: project.cwd,
    model,
    profileKey: profile.key,
  })
  if (!res.ok) {
    notice('error', `默认模型没写进去：${res.reason}`)
    return
  }
  await savedNotice(`已把「${profile.label}」的默认模型写入 ${res.file}`)
}

/** 添加一份档案。**添加 ≠ 切过去** —— 用户还得把它配好、再点「设为当前使用的厂商」 */
async function addProfile(project, vendorKey) {
  if (!vendorKey) return
  const res = await invoke('project/add-profile', { cwd: project.cwd, vendorKey })
  if (!res.ok) {
    notice('error', `添加厂商失败：${res.reason}`)
    return
  }
  // 新加的那份直接选中：用户接下来要做的就是填它的地址
  selectedProfile = res.key
  const label = (project.vendors ?? []).find((v) => v.key === vendorKey)?.label ?? '自定义'
  notice('info', `已添加「${label}」档案，填好参数再点「设为当前使用的厂商」才会用上`)
  await refreshProjectInfo(activeSession()?.id)
}

async function activateProfile(project, profile) {
  const res = await invoke('project/set-active-provider', { cwd: project.cwd, profileKey: profile.key })
  if (!res.ok) {
    // 失败时快照没变、指纹也不变，界面照旧停在「设为当前使用」上 —— 那正是真实状态，
    // 不需要像 MCP 开关那样作废缓存（那边是用户已经把手拨过去了）
    notice('error', `没能切到「${profile.label}」：${res.reason}`)
    return
  }
  notice('info', `已切到「${profile.label}」，之后新建的会话用它说话；正在跑的会话不受影响`)
  await refreshProjectInfo(activeSession()?.id)
}

async function removeProfile(project, profile) {
  const res = await invoke('project/remove-profile', { cwd: project.cwd, profileKey: profile.key })
  pendingRemove = null
  if (!res.ok) {
    notice('error', `没能删掉「${profile.label}」：${res.reason}`)
    return
  }
  // 删掉的那份可能正是选中的那份，让它落回「当前使用」那份上
  if (selectedProfile === profile.key) selectedProfile = null
  notice('info', `已从 ${res.file} 里删掉档案「${profile.key}」`)
  await refreshProjectInfo(activeSession()?.id)
}

/** 写完一句提示，并重拉快照。三处写盘都收在这一句里，省得漏掉哪一处不刷新 */
async function savedNotice(text) {
  notice('info', `${text}，只影响之后新建的会话`)
  await refreshProjectInfo(activeSession()?.id)
}

// ------------------------------------------------------------ 智能体页

/**
 * 正在编辑的智能体草稿。版式照模型页的**左选右配**（`.vendor-pane`）：字段太多
 * （名字/描述/档案/模型/温度/权限三件/工具/技能/常见问题/系统提示词），技能页那种
 * 内联表单排不下。
 *
 * `loaded` 是**每次把一份智能体读进草稿、或者清成一份空记录时自增的序号**，它进指纹
 * （`renderSettings` 里那一行），而草稿里那些**会变的字段绝不进指纹** —— 和技能表单
 * 同一条铁律（见 `skillForm` 那段注释）：一旦进了指纹就变成「打一个字重画一次」，
 * 每个 `replaceChildren` 都会把输入框连焦点一起抖掉。
 *
 * `origin` 是「这份草稿是从哪个智能体读来的」，空串 = 新写一份。它管两件事：
 * 左栏哪一行高亮、右栏要不要给删除按钮 —— 名字那一栏用户随时会改，不能拿它当身份。
 *
 * `loaded === 0` 表示**还没选任何一份**：右栏那时只显示一句指路的话。
 */
const agentDraft = {
  loaded: 0,
  origin: '',
  scope: 'project',
  name: '',
  description: '',
  profile: '',
  model: '',
  temperature: '',
  permission: '',
  allow: '',
  deny: '',
  tools: '',
  skills: '',
  questions: '',
  body: '',
}

/**
 * 正在等第二次确认的删除。**独立于 `pendingRemove` / `pendingSkillRemove` /
 * `pendingMcpRemove`**，理由同 `app.js` 里那段：串了的话 A 页的确认框会跑到 B 页上。
 */
let pendingAgentRemove = null

/** 草稿清成一份空记录（「+ 新增智能体」，以及换项目时归位） */
function resetAgentDraft() {
  agentDraft.origin = ''
  agentDraft.scope = 'project'
  agentDraft.name = ''
  agentDraft.description = ''
  agentDraft.profile = ''
  agentDraft.model = ''
  agentDraft.temperature = ''
  agentDraft.permission = ''
  agentDraft.allow = ''
  agentDraft.deny = ''
  agentDraft.tools = ''
  agentDraft.skills = ''
  agentDraft.questions = ''
  agentDraft.body = ''
}

function agentBlocks(project) {
  const agents = project.agents ?? []

  const list = document.createElement('div')
  list.className = 'vendor-list'
  for (const agent of agents) list.append(agentRow(agent))
  list.append(agentAdd())

  const config = document.createElement('div')
  config.className = 'vendor-config agent-config'
  config.append(...agentForm(project))

  const pane = document.createElement('div')
  pane.className = 'vendor-pane'
  pane.append(list, config)
  return [pane]
}

/**
 * 左栏一行。外面包一个 div 是因为「设为默认」那个按钮不能嵌进 `.rail-item` 里面
 * （`<button>` 里套 `<button>`），而**选中把手必须是那个 button 本身** ——
 * `dataset.name` 和测试钉的都是它。
 */
function agentRow(agent) {
  const box = document.createElement('div')
  box.className = 'agent-row'

  const pick = document.createElement('button')
  pick.type = 'button'
  pick.className = `rail-item vendor-row${agentDraft.loaded > 0 && agentDraft.origin === agent.name ? ' is-selected' : ''}`
  pick.dataset.name = agent.name
  pick.title = agent.file

  const name = document.createElement('span')
  name.className = 'rail-label'
  name.textContent = agent.name

  const badge = document.createElement('span')
  badge.className = `rail-badge${agent.isDefault ? ' is-active' : ''}`
  badge.textContent = agent.isDefault ? '默认' : ''

  pick.append(name, badge)
  pick.addEventListener('click', () => void loadAgent(agent.name))
  box.append(pick)

  if (agent.description) box.append(agentLine(agent.description, 'agent-desc'))
  // 降级提示（「档案 x 找不到，用的是 y」）。**必须摆在脸上** —— 不能让用户自己发现
  // 自己配的档案没了，那时他正对着一个「明明配了 DeepSeek 却在跑 Kimi」的会话查
  if (agent.problem) box.append(agentLine(agent.problem, 'agent-problem'))
  if (!agent.isDefault) box.append(agentDefaultButton(agent))
  return box
}

function agentLine(text, className) {
  const p = document.createElement('div')
  p.className = className
  p.textContent = text
  return p
}

/**
 * 「设为默认」。**只在不是默认的那几行上出现** —— 已经默认的那行不画，比画一个
 * 禁用的按钮干净（没有「点了没反应」那一下）。
 */
function agentDefaultButton(agent) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'agent-default'
  button.textContent = '设为默认'
  button.title = '之后新建的会话默认用它；已经开着的会话不受影响'
  button.addEventListener('click', () => void makeDefaultAgent(agent.name))
  return button
}

/** 左栏底下那个「+ 新增智能体」。**是命令不是状态**：点完清空草稿，不留半份 */
function agentAdd() {
  const box = document.createElement('div')
  box.className = 'vendor-add'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'agent-add'
  button.textContent = '+ 新增智能体'
  button.title = '清空右栏，写一份新的'
  button.addEventListener('click', () => {
    resetAgentDraft()
    pendingAgentRemove = null
    agentDraft.loaded += 1
    render()
  })

  box.append(button)
  return box
}

/** 把一份智能体读进草稿。**正文只能走 `agent/get`** —— `project/info` 那份刻意不带正文 */
async function loadAgent(name) {
  const res = await invoke('agent/get', { cwd, name })
  if (!res.ok) {
    notice('error', res.reason ?? `读不到智能体「${name}」`)
    return
  }
  const agent = res.agent ?? {}
  agentDraft.origin = agent.name ?? name
  agentDraft.scope = agent.scope ?? 'project'
  agentDraft.name = agent.name ?? ''
  agentDraft.description = agent.description ?? ''
  agentDraft.profile = agent.profile ?? ''
  agentDraft.model = agent.model ?? ''
  // `undefined` 是「没写这个键」，要和 `0` 分清 —— 折成 `0` 会把档案的温度钉死
  agentDraft.temperature = agent.temperature === undefined ? '' : String(agent.temperature)
  agentDraft.permission = agent.permission ?? ''
  agentDraft.allow = joinList(agent.allow)
  agentDraft.deny = joinList(agent.deny)
  agentDraft.tools = joinList(agent.tools)
  agentDraft.skills = joinList(agent.skills)
  // 常见问题一行一条，比塞 `|` 好敲
  agentDraft.questions = (agent.questions ?? []).join('\n')
  agentDraft.body = agent.body ?? ''
  pendingAgentRemove = null
  agentDraft.loaded += 1
  render()
}

function agentForm(project) {
  if (agentDraft.loaded === 0) {
    return [emptyBlock('左边点一个智能体来编辑，或者点「+ 新增智能体」写一份新的。')]
  }

  const name = formInput('名字', agentDraft.name, '小写字母 / 数字 / 连字符，如 code-review')
  const description = formInput('描述', agentDraft.description, '一句话说清它是干什么的')
  const scope = formSelect(
    '范围',
    [
      ['project', '本项目（<项目>/.clauda/agents，可以提交进 git）'],
      ['global', '全局（~/.clauda/agents，所有项目都能用）'],
    ],
    agentDraft.scope,
  )

  // 档案那一栏：**只出名字，不出端点** —— 智能体文件是要能提交进 git、发给别人的。
  // 选中的那份如果已经不在了（档案被删），补一个显式选项让这个值能原样来回一趟
  const profiles = project.profiles ?? []
  const keys = profiles.map((p) => p.key)
  const profileOptions = [
    ['', '（用项目当前使用的那份）'],
    ...profiles.map((p) => [p.key, p.isActive ? `${p.key}（当前使用）` : p.key]),
  ]
  if (agentDraft.profile && !keys.includes(agentDraft.profile)) {
    profileOptions.push([agentDraft.profile, `${agentDraft.profile}（找不到这份档案）`])
  }
  const profile = formSelect('厂商档案', profileOptions, agentDraft.profile)

  const model = formInput('模型', agentDraft.model, '留空 = 用那份档案的模型')
  const temperature = formInput('温度', agentDraft.temperature, '留空 = 用那份档案的温度；写 0 就是 0')
  const permission = formSelect(
    '权限模式',
    [
      ['', '（用项目配置的）'],
      ['default', 'default（写文件、跑命令要问）'],
      ['auto', 'auto（不问直接干）'],
      ['plan', 'plan（只读，不改东西）'],
    ],
    agentDraft.permission,
  )
  const allow = formInput('免问规则', agentDraft.allow, '逗号分隔，如 write_file, Bash(npm test:*)')
  const deny = formInput('禁用规则', agentDraft.deny, '逗号分隔，如 Bash(rm:*)')
  const tools = formInput(
    '工具白名单',
    agentDraft.tools,
    '逗号分隔。留空 = 全部可用；写了 = 只要这些（连 skill_write / mcp_add / memory_* 一起管）',
  )
  const skills = formInput('技能白名单', agentDraft.skills, '逗号分隔。留空 = 全部')
  const questions = formArea(
    '常见问题',
    agentDraft.questions,
    '一行一条。新会话还没有消息时列在中栏，点一条就当作发出去（问题里别写 |，那是文件格式的分隔符）',
  )
  const body = formArea(
    '系统提示词',
    agentDraft.body,
    'AGENT.md 的正文。它会插在基础人格之后、项目记忆之前（别写「## 项目记忆」「## 会话配置」这两个标题）',
  )

  // 打字的内容回写进模块状态，重画时能填回去；**不进指纹**，理由见 `agentDraft` 注释
  name.addEventListener('input', () => (agentDraft.name = name.value))
  description.addEventListener('input', () => (agentDraft.description = description.value))
  scope.addEventListener('change', () => (agentDraft.scope = scope.value))
  profile.addEventListener('change', () => (agentDraft.profile = profile.value))
  model.addEventListener('input', () => (agentDraft.model = model.value))
  temperature.addEventListener('input', () => (agentDraft.temperature = temperature.value))
  permission.addEventListener('change', () => (agentDraft.permission = permission.value))
  allow.addEventListener('input', () => (agentDraft.allow = allow.value))
  deny.addEventListener('input', () => (agentDraft.deny = deny.value))
  tools.addEventListener('input', () => (agentDraft.tools = tools.value))
  skills.addEventListener('input', () => (agentDraft.skills = skills.value))
  questions.addEventListener('input', () => (agentDraft.questions = questions.value))
  body.addEventListener('input', () => (agentDraft.body = body.value))

  const form = {
    name,
    description,
    scope,
    profile,
    model,
    temperature,
    permission,
    allow,
    deny,
    tools,
    skills,
    questions,
    body,
  }
  return [
    field('名字', name, '改名字会另写一份新的（同名才是覆盖），旧的那份要自己删'),
    field('描述', description),
    field('范围', scope),
    field('厂商档案', profile, '智能体只记档案的名字，端点和密钥仍旧只留在 config.json 一处'),
    field('模型', model),
    field('温度', temperature),
    field('权限模式', permission, '这是「新建会话时」的默认值，不是把顶栏那个旋钮锁死'),
    field('免问规则', allow),
    field('禁用规则', deny),
    field('工具白名单', tools, '和「免问 / 禁用」是两件事：这里是「在不在手上」，那边是「要不要问」'),
    field('技能白名单', skills),
    field('常见问题', questions),
    field('系统提示词', body),
    ...agentActions(project),
  ]
}

/**
 * 右栏最底下那两件：保存 / 取消，以及（只在编辑既有的那一份时）删除。
 *
 * 删除**不放进 `formActions` 里** —— 那个是「保存 + 取消」的一对，多塞一个红按钮会把
 * 「第二下才是删除」的两步确认读成三选一。单独一行，和保存隔开。
 */
function agentActions(project) {
  const out = [
    formActions('保存智能体', () => void saveAgent(project), () => {
      agentDraft.loaded = 0
      agentDraft.origin = ''
      pendingAgentRemove = null
      render()
    }),
  ]

  // 新写一份的时候没有「旧的那份」可删，整行不画
  if ((project.agents ?? []).some((a) => a.name === agentDraft.origin)) {
    const box = document.createElement('div')
    box.className = 'vendor-actions'
    box.append(
      pendingAgentRemove === agentDraft.origin
        ? confirmPair(
            `确认删除「${agentDraft.origin}」`,
            () => void removeAgentNamed(project, agentDraft.origin),
            () => {
              pendingAgentRemove = null
              render()
            },
          )
        : agentRemoveButton(agentDraft.origin),
    )
    out.push(box)
  }
  return out
}

function agentRemoveButton(name) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'danger'
  button.textContent = '删除'
  button.title = `删掉「${name}」所在的整个目录`
  button.addEventListener('click', () => {
    pendingAgentRemove = name
    pendingSkillRemove = null
    pendingMcpRemove = null
    render()
  })
  return button
}

async function removeAgentNamed(project, name) {
  const res = await invoke('agent/remove', { cwd: project.cwd, name })
  pendingAgentRemove = null
  if (!res.ok) {
    notice('error', `没能删掉智能体「${name}」：${res.reason}`)
    // 失败时列表没变、指纹也不变，光重拉的话界面会停在「确认删除」上 —— 用户容易
    // 以为没点上，再点一次。作废缓存强制回到正常态（同 `removeSkill` 那条教训）
    settingsKey = null
    await refreshProjectInfo()
    return
  }
  // 删掉的正是在编辑的那一份：草稿作废，回到「还没选」
  agentDraft.loaded = 0
  agentDraft.origin = ''
  notice('info', `已删掉智能体「${name}」（${res.dir}）。已经绑着它的老会话照样能打开`)
  await refreshProjectInfo()
}

async function makeDefaultAgent(name) {
  const res = await invoke('project/set-default-agent', { cwd, name })
  if (!res.ok) {
    notice('error', `没能把「${name}」设成默认：${res.reason}`)
    return
  }
  notice('info', `已把「${name}」设为本项目默认，之后新建的会话默认用它；正在跑的会话不受影响`)
  await refreshProjectInfo()
}

/** 逗号分隔的标识符列表 → 数组。整体为空给 `undefined`（= 文件里不写这个键 = 不限制） */
function splitList(text) {
  const out = String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return out.length > 0 ? out : undefined
}

/** 数组 → 逗号分隔的一行。读回草稿时用 */
function joinList(values) {
  return (values ?? []).join(', ')
}

/**
 * 温度那一栏。空 = 用档案的值（`undefined`，文件里不写这个键）；否则必须是个有限数字。
 *
 * **不能用 `Number(text)` 直接兜**：`Number('')` 是 `0`，而 `0` 是个有效温度 ——
 * 空栏会被悄悄写成「温度 0」，看上去还挺合理，最难查的一类。
 */
function temperatureOrUndef(text) {
  const raw = String(text).trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`温度「${raw}」不是数字`)
  return value
}

async function saveAgent(project) {
  const name = agentDraft.name.trim()
  if (!name) {
    notice('warn', '智能体名不能为空')
    return
  }

  // 本地能拦下的格式错误先拦（名字不合规、温度不是数字），省一趟 IPC。
  // 后端还有一份更严的 —— 那份的报错要跑完 IPC 才拿得到
  let temperature
  try {
    temperature = temperatureOrUndef(agentDraft.temperature)
  } catch (e) {
    notice('warn', e.message)
    return
  }

  const res = await invoke('agent/add', {
    cwd: project.cwd,
    scope: agentDraft.scope,
    name,
    description: agentDraft.description.trim(),
    body: agentDraft.body,
    // 空串一律交给主进程落成 `undefined`（= 文件里不写这个键 = 沿用项目当前那份）
    profile: agentDraft.profile,
    model: agentDraft.model.trim(),
    temperature,
    permission: agentDraft.permission,
    // 三个列表**发数组**：`,` 和 `|` 是文件格式的事，归 writeAgent 管
    allow: splitList(agentDraft.allow),
    deny: splitList(agentDraft.deny),
    tools: splitList(agentDraft.tools),
    skills: splitList(agentDraft.skills),
    questions: lines(agentDraft.questions),
  })
  if (!res.ok) {
    notice('error', `智能体没写进去：${res.reason}`)
    return
  }
  // 存完就把它当成「正在编辑的那一份」：接着再点保存才是覆盖同一份，而不是又写一份
  agentDraft.origin = name
  agentDraft.loaded += 1
  notice('info', `已${res.created ? '新建' : '保存'}智能体「${name}」，写在 ${res.file}`)
  await refreshProjectInfo()
}

// ------------------------------------------------------------ 技能页

function skillsBlock(project) {
  const skills = project.skills ?? []
  const blocks = []

  if (skills.length === 0) {
    blocks.push(
      emptyBlock(
        '没有发现技能。可以在下面新增一个，也可以自己往 .clauda/skills/<名字>/SKILL.md 或 ~/.clauda/skills/<名字>/SKILL.md 放一份。',
      ),
    )
  } else {
    const list = document.createElement('div')
    list.className = 'set-rows'
    for (const skill of skills) list.append(skillRow(skill))
    blocks.push(list)
  }

  // 空态时也要有新增入口 —— 一个技能都没有的时候，恰恰是最想加一个的时候
  blocks.push(skillFormBlock(project))
  return blocks
}

/**
 * 一行技能。`dataset.name` 是给测试和「这一行是哪个技能」用的把手，同 `.vendor-row` 的
 * `dataset.key`。
 */
function skillRow(skill) {
  const row = document.createElement('div')
  row.className = 'skill-row'
  row.dataset.name = skill.name

  const text = document.createElement('div')
  text.className = 'skill-text'

  const name = document.createElement('div')
  name.className = 'skill-name'
  name.textContent = `/${skill.name}`

  const desc = document.createElement('div')
  desc.className = 'skill-desc'
  desc.textContent = skill.description || '（没有写描述）'

  const file = document.createElement('div')
  file.className = 'skill-file'
  file.textContent = skill.file

  text.append(name, desc, file)
  row.append(text)
  row.append(
    pendingSkillRemove === skill.name ? skillRemoveConfirm(skill) : skillRemoveButton(skill),
  )
  return row
}

function skillRemoveButton(skill) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'form-del'
  button.textContent = '删除'
  button.title = `删掉 ${skill.file} 所在的整个目录`
  button.addEventListener('click', () => {
    // 同一时刻只留一处待删，免得两个确认框一起亮着
    pendingSkillRemove = skill.name
    pendingMcpRemove = null
    render()
  })
  return button
}

function skillRemoveConfirm(skill) {
  return confirmPair(`确认删除「${skill.name}」`, () => void removeSkill(skill), () => {
    pendingSkillRemove = null
    render()
  })
}

async function removeSkill(skill) {
  const res = await invoke('skill/remove', { cwd, name: skill.name })
  pendingSkillRemove = null
  if (!res.ok) {
    notice('error', `没能删掉技能「${skill.name}」：${res.reason}`)
    // 失败时列表没变、指纹也不变，光重拉的话界面会停在「确认删除」上 ——
    // 用户容易以为没点上，再点一次。作废缓存强制回到正常态
    settingsKey = null
    await refreshProjectInfo()
    return
  }
  notice('info', `已删掉技能「${skill.name}」（${res.dir}）`)
  await refreshProjectInfo()
}

/**
 * 「+ 新增技能」。展开的那块**不是弹窗**：全仓唯一那个 `renderModal` 是授权专用的。
 * 项目自己的取向也是内联两步确认（见 `confirmRemove` 上面那段注释）。
 */
function skillFormBlock(project) {
  if (!skillForm.open) {
    return section('新增技能', [
      formTrigger('+ 新增技能', '写一份 SKILL.md。保存后立刻生效，不用重启', () => {
        skillForm.open = true
        render()
      }),
    ])
  }

  const name = formInput('技能名', skillForm.name, '小写字母 / 数字 / 连字符，如 weekly-report')
  const description = formInput('说明', skillForm.description, '一句话说清什么时候该用它')
  const body = formArea('正文', skillForm.body, '技能正文：步骤、命令、注意事项')
  const scope = formSelect(
    '范围',
    [
      ['global', '全局（~/.clauda/skills，配一次所有项目都能用）'],
      ['project', '本项目（<项目>/.clauda/skills）'],
    ],
    skillForm.scope,
  )

  // 打字的内容回写进模块状态，重画时能填回去；**不进指纹**，理由见 `skillForm` 注释
  name.addEventListener('input', () => (skillForm.name = name.value))
  description.addEventListener('input', () => (skillForm.description = description.value))
  body.addEventListener('input', () => (skillForm.body = body.value))
  scope.addEventListener('change', () => (skillForm.scope = scope.value))

  const form = { name, description, body, scope }
  return section('新增技能', [
    field('技能名', name),
    field('说明', description, '系统提示词里只放这一句，正文等用到了才载入'),
    field('正文', body),
    field('范围', scope),
    formActions(
      '保存技能',
      () => void addSkill(project, form),
      () => {
        skillForm.open = false
        render()
      },
    ),
  ])
}

async function addSkill(project, form) {
  const name = form.name.value.trim()
  if (!name) {
    notice('warn', '技能名不能为空')
    return
  }
  const res = await invoke('skill/add', {
    cwd: project.cwd,
    scope: form.scope.value,
    name,
    description: form.description.value,
    body: form.body.value,
  })
  if (!res.ok) {
    // 失败时报出主进程那句话就够（「名字不合法」「已经有一个同名的技能」都在里面），
    // 表单留着不收：用户改一个字就能重试，收掉就得重打一遍
    notice('error', `技能没写进去：${res.reason}`)
    return
  }
  skillForm.open = false
  skillForm.name = ''
  skillForm.description = ''
  skillForm.body = ''
  notice('info', `已新增技能「${name}」，写在 ${res.file}。当前会话立刻能用`)
  await refreshProjectInfo()
}

// ------------------------------------------------------------ MCP 页

function mcpBlocks(project) {
  const servers = project.mcp ?? []
  const blocks = []

  if (servers.length === 0) {
    blocks.push(
      emptyBlock('没有配置 MCP 服务器。可以在下面新增一个，也可以自己往 config.json 的 mcpServers 里加（格式见 README）。'),
    )
  } else {
    const list = document.createElement('div')
    list.className = 'set-rows'
    list.append(...servers.map(mcpRow))
    blocks.push(list)
  }

  blocks.push(mcpFormBlock(project))
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

  // **删除按钮只能往后追加**：`children[0]` 是开关，这个子节点顺序是测试钉住的契约
  row.append(
    pendingMcpRemove === server.name
      ? mcpRemoveConfirm(server)
      : mcpRemoveButton(server),
  )

  // 失败原因铺满一整行。挤在状态那列里会被截断，而用户正是靠它判断哪儿配错了。
  // 放在删除按钮**之后**（它那条 `grid-column: 1/-1` 会另起一行，不挤着按钮）
  if (server.error) {
    const err = document.createElement('pre')
    err.className = 'mcp-error'
    err.textContent = server.error
    row.append(err)
  }
  return row
}

function mcpRemoveButton(server) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'form-del'
  button.textContent = '删除'
  button.title = `断开「${server.name}」并从配置文件里删掉它`
  button.addEventListener('click', () => {
    pendingMcpRemove = server.name
    pendingSkillRemove = null
    render()
  })
  return button
}

function mcpRemoveConfirm(server) {
  return confirmPair(`确认删除「${server.name}」`, () => void removeMcp(server), () => {
    pendingMcpRemove = null
    render()
  })
}

async function removeMcp(server) {
  const res = await invoke('mcp/remove', { cwd, name: server.name })
  pendingMcpRemove = null
  if (!res.ok) {
    notice('error', `没能删掉「${server.name}」：${res.reason}`)
    // 同 `toggleMcp` 那条教训：失败时快照没变、指纹也不变，不作废缓存的话
    // 界面会停在「确认删除」上，像没点上
    settingsKey = null
    await refreshProjectInfo()
    return
  }
  notice('info', `已移除 MCP 服务器「${server.name}」（${res.file || '运行时临时加的'}）`)
  await refreshProjectInfo()
  const session = activeSession()
  if (session) await refreshSession(session.id)
}

/**
 * 「+ 新增 MCP 服务器」。
 *
 * 范围**默认「本项目」**，和技能表单默认全局相反：一条 MCP 配置意味着「起一个子进程、
 * 把你的命令一直跑着」，写进全局会波及每一个项目 —— 那比一个技能大得多的一步，
 * 不该是默认值。agent 那侧的 `mcp_add` 也是同样的默认。
 */
function mcpFormBlock(project) {
  if (!mcpForm.open) {
    return section('新增 MCP 服务器', [
      formTrigger('+ 新增 MCP 服务器', '写进配置文件并当场连上（会起一个子进程）', () => {
        mcpForm.open = true
        render()
      }),
    ])
  }

  const name = formInput('服务器名', mcpForm.name, '配置里的 key，如 filesystem')
  const type = formSelect(
    '类型',
    [
      ['stdio', 'stdio（本地命令）'],
      ['http', 'http（远程端点）'],
    ],
    mcpForm.type,
  )
  const command = formInput('命令', mcpForm.command, '如 npx、node、uvx')
  const args = formArea('参数', mcpForm.args, '一行一个，如\n-y\n@modelcontextprotocol/server-filesystem')
  const env = formArea('环境变量', mcpForm.env, '一行一个 KEY=VALUE。密钥写成 ${VAR}，别贴明文')
  const url = formInput('URL', mcpForm.url, 'https://example.com/mcp')
  const headers = formArea('请求头', mcpForm.headers, '一行一个 Key: Value。密钥同样建议写成 ${VAR}')
  const scope = formSelect(
    '范围',
    [
      ['project', '本项目（<项目>/config.json）'],
      ['global', '全局（~/.clauda/config.json，所有项目都能用）'],
    ],
    mcpForm.scope,
  )

  name.addEventListener('input', () => (mcpForm.name = name.value))
  command.addEventListener('input', () => (mcpForm.command = command.value))
  args.addEventListener('input', () => (mcpForm.args = args.value))
  env.addEventListener('input', () => (mcpForm.env = env.value))
  url.addEventListener('input', () => (mcpForm.url = url.value))
  headers.addEventListener('input', () => (mcpForm.headers = headers.value))
  scope.addEventListener('change', () => (mcpForm.scope = scope.value))

  // 用不上的字段**藏掉**，不是留着让人填错：填了 url 又填了 command 的话，
  // 后端只能二选一 —— 与其猜，不如根本不给填的机会
  const stdioFields = fieldGroup([field('命令', command), field('参数', args), field('环境变量', env)])
  const httpFields = fieldGroup([field('URL', url), field('请求头', headers)])
  const sync = () => {
    const http = type.value === 'http'
    stdioFields.hidden = http
    httpFields.hidden = !http
  }
  type.addEventListener('change', () => {
    mcpForm.type = type.value
    sync()
  })
  sync()

  const form = { name, type, command, args, env, url, headers, scope }
  return section('新增 MCP 服务器', [
    field('服务器名', name),
    field('类型', type),
    stdioFields,
    httpFields,
    field('范围', scope),
    formActions(
      '保存并连接',
      () => void addMcp(project, form),
      () => {
        mcpForm.open = false
        render()
      },
    ),
  ])
}

async function addMcp(project, form) {
  const name = form.name.value.trim()
  if (!name) {
    notice('warn', '服务器名不能为空')
    return
  }

  // 这里能抛的是**格式**错误（空地址、URL 没填、KEY=VALUE 不合法）。后端还有一份
  // 更严的校验，但那份的报错要跑一趟 IPC 才拿得到，能在本地拦下的就当场说
  let config
  try {
    config =
      form.type.value === 'http'
        ? { type: 'http', url: required(form.url, 'URL'), headers: pairLines(form.headers.value) }
        : {
            type: 'stdio',
            command: required(form.command, '命令'),
            args: lines(form.args.value),
            env: pairLines(form.env.value),
          }
  } catch (e) {
    notice('warn', e.message)
    return
  }

  const res = await invoke('mcp/add', {
    cwd: project.cwd,
    scope: form.scope.value,
    name,
    config,
  })
  if (!res.ok) {
    notice('error', `MCP 服务器没加上：${res.reason}`)
    return
  }
  mcpForm.open = false
  mcpForm.name = ''
  mcpForm.command = ''
  mcpForm.args = ''
  mcpForm.env = ''
  mcpForm.url = ''
  mcpForm.headers = ''
  notice('info', `已接入 MCP 服务器「${name}」，写在 ${res.file}。它的工具现在就能用`)
  await refreshProjectInfo()
  const session = activeSession()
  if (session) await refreshSession(session.id)
}

function required(input, label) {
  const value = input.value.trim()
  if (!value) throw new Error(`${label}不能为空`)
  return value
}

/** 一行一个，空行丢掉。参数里有空格，所以不按空格分 */
function lines(text) {
  const out = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return out.length > 0 ? out : undefined
}

/** 「一行一个 KEY=VALUE」→ 对象。`=` 之后允许再有 `=`（值里带等号很常见） */
function pairLines(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) throw new Error(`「${trimmed}」不是 KEY=VALUE 的形式`)
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
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
  await refreshProjectInfo()
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

// ------------------------------------------------------- 设置页里的内联表单

/**
 * 表单里的一行：标签**在上**、控件占满一行。
 *
 * 不复用 `row()`：那是 `.set-row` 的 `132px + 1fr` 两列网格，标签和值挤在同一行，
 * 而且值那一列有固定的收窄行为 —— 正文那个 textarea 塞进去只剩一条缝。
 */
function field(label, control, hint) {
  const box = document.createElement('label')
  box.className = 'form-field'

  const caption = document.createElement('span')
  caption.className = 'form-label'
  caption.textContent = label

  box.append(caption, control)
  if (hint) {
    const note = document.createElement('span')
    note.className = 'form-hint'
    note.textContent = hint
    box.append(note)
  }
  return box
}

/**
 * 一组可以整体藏起来的字段（stdio / http 二选一那两块）。
 *
 * 单独包一层是因为 `hidden` 要在**这一组**上生效 —— 挨个藏 `.form-field` 的话，
 * 每个都得记着哪些属于哪一组，加一个字段就会漏。
 */
function fieldGroup(fields) {
  const box = document.createElement('div')
  box.className = 'form-group'
  box.append(...fields)
  return box
}

function formInput(label, value, placeholder) {
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.value = value ?? ''
  input.placeholder = placeholder ?? ''
  input.setAttribute('aria-label', label)
  return input
}

function formArea(label, value, placeholder) {
  const area = document.createElement('textarea')
  area.rows = 3
  area.spellcheck = false
  area.value = value ?? ''
  area.placeholder = placeholder ?? ''
  area.setAttribute('aria-label', label)
  return area
}

function formSelect(label, options, value) {
  const select = document.createElement('select')
  select.setAttribute('aria-label', label)
  for (const [key, text] of options) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = text
    select.append(option)
  }
  select.value = value
  return select
}

/** 收起状态下的那一个「+ 新增…」。它是个命令，不是状态，所以不做成 toggle */
function formTrigger(text, hint, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'form-open'
  button.textContent = text
  button.title = hint
  button.addEventListener('click', onClick)
  return button
}

function formActions(saveText, onSave, onCancel) {
  const box = document.createElement('div')
  box.className = 'form-actions'

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = saveText
  save.addEventListener('click', onSave)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'ghost'
  cancel.textContent = '取消'
  cancel.addEventListener('click', onCancel)

  box.append(save, cancel)
  return box
}

/**
 * 两步确认里「第二步」的那一对按钮。
 *
 * **「取消」必须和「确认」一样显眼**：只留一个红按钮的话，第二下就成了必答题，
 * 「按两下」也就退化成「按一下」了（同 `confirmRemove` 那段注释）。
 */
function confirmPair(yesText, onYes, onNo) {
  const box = document.createElement('span')
  box.className = 'vendor-confirm'

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.className = 'danger'
  yes.textContent = yesText
  yes.addEventListener('click', onYes)

  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'ghost'
  no.textContent = '取消'
  no.addEventListener('click', onNo)

  box.append(yes, no)
  return box
}

// ------------------------------------------------------------ 会话视图

function renderSidebar() {
  els.projectPath.textContent = cwd || '（还没选项目）'

  const known = new Set(state.order)
  const history = (state.history[cwd] ?? []).filter((s) => !known.has(s.id))

  const blocks = []
  blocks.push(group('进行中', state.order.map((id) => sessionRow(state.sessions[id]))))
  if (history.length > 0) blocks.push(group('历史会话', history.map(historyRow)))

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
  row.addEventListener('click', () => {
    showSessions()
    dispatch({ type: 'select', id: session.id })
    // 设置页看的是**项目**。点开另一个项目里的会话时，当前目录与项目信息一起跟过去 ——
    // 不跟的话「模型 / 技能 / MCP」会一直显示着上一个项目的样子
    if (session.cwd && session.cwd !== cwd) {
      cwd = session.cwd
      void refreshHistory(cwd)
      void refreshProjectInfo()
    }
  })
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

/**
 * 「新会话用哪个智能体」那一格。
 *
 * **选项只在名单真的变了的时候重画**：`render()` 每帧都跑（流式输出期间一秒好几次），
 * 无条件重建 `replaceChildren` 会把用户刚在下拉框里挑好的那一项抖回默认。
 *
 * 挑中的那一项**尽量留住**：名单没变就沿用用户当下选的；那一项没了（智能体被删了、
 * 或者换了项目）才落回本项目默认，再不行落到「（不用智能体）」。
 */
let newSessionAgentKey = null

function renderNewSessionAgent() {
  const project = state.project
  const agents = project?.agents ?? []
  const names = agents.map((a) => a.name)
  const key = `${project?.cwd ?? ''}|${names.join(',')}|${project?.defaultAgent ?? ''}`
  if (key === newSessionAgentKey) return
  newSessionAgentKey = key

  const previous = els.newSessionAgent.value
  const available = new Set(names)
  const pick = available.has(previous)
    ? previous
    : available.has(project?.defaultAgent ?? '')
      ? project.defaultAgent
      : ''
  els.newSessionAgent.replaceChildren(
    ...[['', '（不用智能体）'], ...agents.map((a) => [a.name, a.isDefault ? `${a.name}（本项目默认）` : a.name])].map(
      ([value, text]) => {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        return option
      },
    ),
  )
  els.newSessionAgent.value = pick
}

function renderTopbar() {
  const session = activeSession()
  const off = !session

  els.chatTitle.textContent = session ? session.cwd : '还没有打开的会话'
  // 这个会话绑的智能体。取自 `SessionInfo`，**不是**项目默认那个 —— 同项目两个会话
  // 可以绑着两个不同的智能体，顶栏必须显示「这一个会话」的那个
  els.chatAgent.hidden = !session?.agentName
  els.chatAgent.textContent = session?.agentName ? `智能体 ${session.agentName}` : ''
  // 输入框正在编辑时不要回写，否则光标会跳
  if (session && document.activeElement !== els.modelInput) els.modelInput.value = session.model
  if (session) els.modeSelect.value = session.mode
  els.contextFill.style.width = `${Math.min(100, Math.round((session?.contextRatio ?? 0) * 100))}%`

  els.modelInput.disabled = off
  els.modeSelect.disabled = off
  els.input.disabled = off
  els.attach.disabled = off
  els.abort.hidden = !(session && session.status === 'running')
}

// ------------------------------------------------------------ 附件

/** 和 `src/util/text.ts` 的 `formatBytes` 同一套口径。renderer 拿不到 dist，只能抄一份 */
function fileSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 待发附件那一条。空列表时整条 `hidden`，`.composer` 靠它占的那行也就跟着收起来。
 *
 * 缩略图用 `<img>` + data URL：CSP 的 `img-src` 放行了 `data:`，而这些字节是
 * **主进程读出来的**（`attachment/ingest` 的返回），不是用户敲进来的内容。
 */
function renderAttachments() {
  const list = state.attachments
  if (list.length === 0) {
    els.attachList.hidden = true
    els.attachList.replaceChildren()
    return
  }
  els.attachList.hidden = false

  els.attachList.replaceChildren(
    ...list.map((att, index) => {
      const chip = document.createElement('div')
      chip.className = 'attach-chip'

      if (att.kind === 'image' && att.dataUrl) {
        const thumb = document.createElement('img')
        thumb.src = att.dataUrl
        thumb.alt = att.name
        chip.append(thumb)
      } else {
        const glyph = document.createElement('span')
        glyph.className = 'attach-glyph'
        glyph.textContent = '📄'
        chip.append(glyph)
      }

      const label = document.createElement('span')
      label.className = 'attach-name'
      label.textContent = att.name
      label.title = att.path || att.name

      const size = document.createElement('span')
      size.className = 'attach-size'
      size.textContent = fileSize(att.bytes)

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'remove'
      remove.textContent = '×'
      remove.title = '移除'
      remove.setAttribute('aria-label', `移除 ${att.name}`)
      remove.addEventListener('click', () => dispatch({ type: 'detach', index }))

      chip.append(label, size, remove)
      return chip
    }),
  )
}

/**
 * 拖进来 / 粘上来的 File 们 → 原始描述符。
 *
 * `pathForFile` 是**同步**的，且对**没有磁盘来源**的 File 返回空串 —— 截图工具和
 * 浏览器里复制的图片都是这一类，这时只能由渲染层自己读成 data URL 兜底（它本来拿不到
 * fs，这是唯一一处渲染层碰字节的地方）。
 */
async function collectFromFiles(files) {
  const items = []
  for (const file of files ?? []) {
    const filePath = window.clauda.pathForFile(file)
    if (filePath) {
      items.push({ path: filePath, name: file.name, mime: file.type })
      continue
    }
    if (typeof file.type === 'string' && file.type.startsWith('image/')) {
      // 先判大小再编码：不然一张 50MB 的图会先在渲染进程里转一遍 base64，界面直接卡住
      if (file.size > MAX_IMAGE_BYTES) {
        notice('warn', `${file.name || '这张图片'}太大（${fileSize(file.size)}），上限 4 MB`)
        continue
      }
      try {
        const dataUrl = await readAsDataUrl(file)
        items.push({ dataUrl, name: file.name || '剪贴板图片', mime: file.type })
      } catch {
        notice('error', `${file.name || '这张图片'}读不出来`)
      }
      continue
    }
    notice('warn', `${file.name || '这个文件'}没有磁盘路径，先另存到磁盘再拖进来`)
  }
  return items
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * 三条入口（拖拽 / 粘贴 / 选文件）的最后一段。字节在主进程读，被拒的原因在这里报出来
 * —— 用户拖了一个 8MB 的图，得当场知道为什么 chip 没出现。
 */
async function ingestItems(items) {
  if (!items || items.length === 0) return
  const res = await invoke('attachment/ingest', { items })
  if (!res.ok) {
    notice('error', res.reason ?? '附件读不进来')
    return
  }
  for (const reason of res.rejected ?? []) notice('warn', reason)
  if ((res.attachments ?? []).length > 0) {
    dispatch({ type: 'attach', attachments: res.attachments })
  }
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

/**
 * 新会话空态：智能体配好的常见问题，点一条就当作发出去。
 *
 * 三个显示条件：有活动会话 + 这条会话**一条消息都还没有** + 问题非空。问题取自
 * **这份会话冻结的** `AgentSpec`（`SessionInfo.agentQuestions`），**不是**回头按名字去
 * `ProjectInfo.agents` 现查 —— 那会把新会话刚冻结下来的东西又变回活的：改一个智能体的
 * 常见问题，老会话的空态跟着变。
 *
 * 同 `renderNewSessionAgent`：只在内容真的变了的时候重画。这里是按钮不是输入框，但
 * 流式期间每帧重建一遍也是白费；更重要的是点击到 `submit` 之间那一帧的重建会让
 * 按钮「闪」一下。
 */
let questionsKey = null

function renderEmptyQuestions() {
  const session = activeSession()
  const questions =
    session && session.items.length === 0 && !session.pending ? session.agentQuestions ?? [] : []
  const key = questions.join('\u0000')

  if (questions.length === 0) {
    if (els.emptyQuestions.hidden) return
    els.emptyQuestions.hidden = true
    els.emptyQuestions.replaceChildren()
    questionsKey = null
    return
  }
  if (key === questionsKey && !els.emptyQuestions.hidden) return
  questionsKey = key
  els.emptyQuestions.hidden = false

  const head = document.createElement('div')
  head.className = 'empty-questions-head'
  head.textContent = session.agentName ? `${session.agentName} 常问到：` : '试试这样问：'

  els.emptyQuestions.replaceChildren(
    head,
    ...questions.map((text) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'empty-question'
      button.textContent = text
      // 点一条就当成打进去、发出去。**不经过输入框** —— 塞进 `#input` 再 `submit()`
      // 的话，用户会看到自己「没打的字」出现在输入框里闪过一下
      button.addEventListener('click', () => void submit(text))
      return button
    }),
  )
}

function paint(node, item) {
  node.className = `entry ${item.kind}`

  if (item.kind === 'user') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    // 用户自己打的字不当 markdown，原样显示。先写字再插图 —— textContent 会把
    // 已有的子节点整批换掉，顺序反了图就没了
    if (item.text) bubble.textContent = item.text
    for (const url of item.images ?? []) {
      const img = document.createElement('img')
      img.className = 'bubble-img'
      img.src = url
      img.alt = '附件图片'
      bubble.append(img)
    }
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

// 「设置」现在是个**换内容**的开关：点一下左栏从会话换成设置四项，再点一下换回去。
//
// 它不记得「具体哪一页」，那是 `lastSettingsView` 的事 —— 从模型页点回来，再点出去，
// 还落在模型页，比每次都跳回智能体顺手。
//
// 从设置回会话这一下必须由它承担：会话那一格这时是 `hidden` 的，它是唯一的路。
els.navSettings.addEventListener('click', () => {
  const toSettings = state.view === 'sessions'
  dispatch({ type: 'view', view: toSettings ? lastSettingsView : 'sessions' })
  if (toSettings) void refreshProjectInfo()
})

for (const [button, view] of [
  [els.navSessions, 'sessions'],
  [els.navAgents, 'agents'],
  [els.navModel, 'model'],
  [els.navSkills, 'skills'],
  [els.navMcp, 'mcp'],
]) {
  button.addEventListener('click', () => {
    // 记下这一页，供底部「设置」下次回跳
    if (view !== 'sessions') lastSettingsView = view
    if (state.view === view) return
    dispatch({ type: 'view', view })
    // 进设置页时重拉一次：徽标是每轮刷的，但用户点进来的这一刻要保证是新的
    if (view !== 'sessions') void refreshProjectInfo()
  })
}

els.newSession.addEventListener('click', () => void openNewSession())

els.pickProject.addEventListener('click', async () => {
  const dir = await window.clauda.pickDirectory()
  if (!dir) return
  cwd = dir
  // 换了项目，设置页看到的必须是新项目的技能 / MCP / 档案。主进程那边同时会把
  // 上一个项目的运行时放下（没人用就销毁）
  //
  // 两个表单和两处待删也要归位：留着的话，「范围=本项目」的意思已经换成了另一个
  // 项目，而那个待确认的删除指向的是上一个项目里的东西
  resetSettingsForms()
  await refreshHistory(dir)
  await refreshProjectInfo()
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

// 随内容长高。这个 200 和 style.css 里 `.composer textarea` 的 `max-height` 是同一个数，
// 改一处要改两处 —— 最小高度（三行）那边只由 CSS 的 `min-height` 兜着，这里不必管
els.input.addEventListener('input', () => {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(200, els.input.scrollHeight)}px`
})

/**
 * 拖拽。**挂在 `els.app` 上，不能挂 `window`**：`tests/renderer-dom.mjs` 的假 DOM
 * 没有 `window.addEventListener`，而这里的监听是在模块顶层注册的 —— 挂 window 上
 * 整份渲染层单测当场跑不起来。
 *
 * `dragenter` / `dragleave` 会在子元素之间反复触发（鼠标每跨过一次边界就来一轮），
 * 所以用一个进入计数器。不计数的话遮罩会在拖动过程中疯狂闪烁。
 */
let dragDepth = 0

/** 只接管**文件**。不判这一下的话，把选中的一段文字拖进输入框也会被吃掉 */
function draggingFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

els.app.addEventListener('dragenter', (event) => {
  if (!draggingFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  els.dropHint.hidden = false
})

els.app.addEventListener('dragover', (event) => {
  // **必须 preventDefault**：不调的话浏览器认为这里不接受放置，drop 事件根本不会来。
  // 这是拖拽最容易写成「看着对但什么都不发生」的一处
  if (!draggingFiles(event)) return
  event.preventDefault()
})

els.app.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) els.dropHint.hidden = true
})

els.app.addEventListener('drop', (event) => {
  dragDepth = 0
  els.dropHint.hidden = true
  if (!draggingFiles(event)) return
  event.preventDefault()
  void collectFromFiles(event.dataTransfer?.files).then(ingestItems)
})

els.input.addEventListener('paste', (event) => {
  const files = event.clipboardData?.files
  // 剪贴板里没有文件就不干预 —— 那是正常粘一段文字
  if (!files || files.length === 0) return
  // 有文件就必须拦：不拦的话 Chromium 会把文件名当纯文本插进 textarea
  event.preventDefault()
  void collectFromFiles(files).then(ingestItems)
})

els.attach.addEventListener('click', async () => {
  const paths = await window.clauda.pickFiles()
  if (!paths || paths.length === 0) return
  // 只报路径，文件名由主进程按 path.basename 定 —— 渲染层没有 path 模块，
  // 自己切分隔符迟早会在某个平台或某个奇怪的文件名上出错
  await ingestItems(paths.map((path) => ({ path })))
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

/**
 * 发一条消息出去。
 *
 * `preset` 是空态里点常见问题时**代替输入框**的那个字串。给了它就不去读也不清空
 * `#input`（用户可能正在里面打字，点一下常见问题不该把那段字吃掉）。
 */
async function submit(preset) {
  const session = activeSession()
  const fromInput = preset === undefined
  const text = (fromInput ? els.input.value : String(preset ?? '')).trim()
  const attachments = state.attachments
  // **光有附件、一个字没打也要能发**。这一条不加的话，「只丢一张图给模型看」
  // 这个最常见的用法会静默什么都不发生（旧代码在这里靠 `!text` 提前返回）
  if (!session || (!text && attachments.length === 0)) return

  const images = attachments.filter((a) => a.kind === 'image').map((a) => a.dataUrl)
  if (fromInput) {
    els.input.value = ''
    els.input.style.height = 'auto'
  }
  dispatch({ type: 'user-send', sessionId: session.id, text, images })

  // 这条会一直等到整轮结束。中途的流式输出靠事件推过来
  const res = await invoke('session/send', {
    sessionId: session.id,
    text,
    attachments: attachmentPayload(attachments),
  })
  if (!res.ok) {
    // 失败时**保留附件**：清空 + 报错会让用户白拖一遍
    dispatch({ type: 'error', sessionId: session.id, msg: res.reason })
    return
  }
  dispatch({ type: 'clear-attachments' })
  if (res.dropped) notice('warn', `有 ${res.dropped} 个附件不合规，没有随这条消息发出去`)
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
    // **一个会话都还没开**就把项目快照拉回来：技能 / MCP / 模型三页和左栏徽标都靠它。
    // 主进程会顺手把项目运行时建起来（幂等），这正是「没会话也能配」的那一步
    await refreshProjectInfo()
  }
  render()

  // 第一次打开时什么项目都没有，直接弹目录选择，省得用户对着一堆禁用控件猜
  if (!cwd) await els.pickProject.click()
}

void boot()
