/**
 * 渲染层的全部状态逻辑，**纯函数、不碰 DOM**。
 *
 * 单独拆出来是为了能被 `tests/unit.mjs` 直接 import 来测 —— `app.js` 那层 DOM 绑定
 * 只能靠人工看窗口，但它背后的每一条判断都在这里被判过了。所以这个文件里
 * **一行 `document` 都不许有**，import 期碰了 DOM 单测当场就炸。
 *
 * 消息流用「条目」数组而不是「消息」数组：助手的一段话、一张工具卡片、一条报错
 * 在界面上是三种不同的东西，硬塞进同一种结构的话渲染层还得再判一次类型。
 */

/** 通知栏上限。它只会被读最近几条，不封顶的话开一整天窗口能攒出几万条 */
const MAX_NOTICES = 50

export function createState() {
  return {
    /** `project/list` 的结果，按项目分组的历史会话 */
    projects: [],
    /** cwd -> `session/list` 的结果 */
    history: {},
    sessions: {},
    /** 侧边栏的展示顺序。`sessions` 是对象，顺序只能另外存 */
    order: [],
    activeId: null,
    /** 项目级通知（MCP 连不上之类）。它们不属于任何会话，只能挂在这一层 */
    notices: [],
    /** 打开过多少次会话。只用来给 `openSeq` 发号，不参与任何判断 */
    opens: 0,
  }
}

/** 会话快照的字段与缺省值。打开会话和 `session-state` 回填**必须共用这一份** */
const SESSION_DEFAULTS = {
  cwd: '',
  title: '',
  model: '',
  mode: 'default',
  tools: [],
  todos: [],
  contextTokens: 0,
  contextRatio: 0,
}
const SESSION_FIELDS = Object.keys(SESSION_DEFAULTS)

const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

function newSession(info, openSeq) {
  const session = {
    id: info.id,
    status: 'idle',
    thinking: null,
    items: [],
    /** 待决的授权弹窗。存整个请求，弹窗关掉之前要一直显示着 */
    pending: null,
    /**
     * 这是第几次打开这个 id。渲染层靠它决定要不要把整个消息流推倒重画 ——
     * 「关掉 A 再从历史里点开 A」复用同一个 id，只看 id 的话会把新恢复的历史
     * 画进上一次那些残留的 DOM 节点里。
     */
    openSeq,
  }
  for (const key of SESSION_FIELDS) session[key] = info[key] ?? SESSION_DEFAULTS[key]
  return session
}

export function reduce(state, action) {
  switch (action.type) {
    case 'projects':
      return { ...state, projects: action.projects ?? [] }
    case 'history':
      return { ...state, history: { ...state.history, [action.cwd]: action.sessions ?? [] } }
    case 'select':
      return { ...state, activeId: action.id }
    case 'session-opened':
      return openSession(state, action.session)
    case 'app-notice':
      return { ...state, notices: [...state.notices, { level: action.level, text: action.text }].slice(-MAX_NOTICES) }
    default:
      return routeToSession(state, action)
  }
}

function openSession(state, info) {
  const opens = state.opens + 1
  const session = newSession(info, opens)
  // 同一个 id 再打开一次（关掉又从历史里点回来）不能排两条 —— 重复项在侧边栏里
  // 会渲染成两个一模一样的条目，点哪个都「没反应」（其实是切到了同一个会话）
  const order = state.order.includes(session.id) ? state.order : [...state.order, session.id]
  return {
    ...state,
    opens,
    sessions: { ...state.sessions, [session.id]: session },
    order,
    activeId: session.id,
  }
}

/**
 * 事件比 `session-opened` 先到（另一个窗口刚建的会话、退出时残留的回包）就整条丢掉。
 * 丢掉而不是抛：渲染层不该因为一条迟到的 IPC 消息白屏。
 */
function routeToSession(state, action) {
  const session = state.sessions[action.sessionId]
  if (!session) return state
  const next = applyToSession(session, action)
  if (next === session) return state
  return { ...state, sessions: { ...state.sessions, [action.sessionId]: next } }
}

function applyToSession(session, action) {
  switch (action.type) {
    case 'user-send':
      return push(session, { kind: 'user', text: action.text })

    case 'assistant-start':
      return push(session, { kind: 'assistant', text: '', streaming: true })

    // 增量必须并进同一条：每片 delta 新起一条的话，界面上会变成一行一个字往下堆
    case 'assistant-delta':
      return patchLast(session, isKind('assistant'), (m) => ({ ...m, text: m.text + action.text }))

    case 'assistant-end':
      return patchLast(session, isKind('assistant'), (m) => ({ ...m, streaming: false }))

    case 'tool-start':
      return push(session, {
        kind: 'tool',
        name: action.name,
        summary: action.summary ?? '',
        status: 'running',
        output: '',
        result: '',
        elapsedMs: 0,
      })

    case 'tool-output':
      return patchLast(session, isKind('tool'), (m) => ({ ...m, output: m.output + action.chunk }))

    // 工具是串行跑的（见 CLAUDA.md），所以「最后一个工具卡片」必然就是刚结束的那个
    case 'tool-end':
      return patchLast(session, isKind('tool'), (m) => ({
        ...m,
        status: action.ok ? 'ok' : 'error',
        result: action.result ?? '',
        elapsedMs: action.elapsedMs ?? 0,
      }))

    case 'info':
    case 'warn':
    case 'error':
      return push(session, { kind: 'notice', level: action.type, text: action.msg })

    case 'thinking':
      return { ...session, thinking: action.label ?? '' }

    case 'thinking-done':
      return { ...session, thinking: null }

    case 'session-status':
      return { ...session, status: action.status }

    case 'session-state':
      return mergeSnapshot(session, action.session)

    // 打开历史会话：把落盘的那份对话变成消息流。**整份替换**（不像 session-state
    // 那样只并字段）—— 这里要的就是「回到当初的样子」
    case 'messages-restored':
      return { ...session, items: toItems(action.messages) }

    case 'permission-request':
      return {
        ...session,
        pending: { requestId: action.requestId, label: action.label, detail: action.detail ?? '' },
      }

    // 陈旧的回复不能清掉新弹窗：用户点「允许」和点「停止」会抢同一个会话
    case 'permission-replied':
      return session.pending?.requestId === action.requestId ? { ...session, pending: null } : session

    case 'turn-end':
      return { ...session, lastTurn: action.summary }

    default:
      return session
  }
}

/**
 * 合并 `session/state` 的快照。**只认它带的字段，绝不整份替换** ——
 * 快照里没有 `items`，整份替换会把整个消息流冲掉。
 */
function mergeSnapshot(session, patch) {
  if (!patch) return session
  const next = { ...session }
  let changed = false
  for (const key of SESSION_FIELDS) {
    if (patch[key] === undefined || patch[key] === next[key]) continue
    next[key] = patch[key]
    changed = true
  }
  return changed ? next : session
}

function isKind(kind) {
  return (item) => item.kind === kind
}

function push(session, item) {
  return { ...session, items: [...session.items, item] }
}

function patchLast(session, match, patch) {
  for (let i = session.items.length - 1; i >= 0; i--) {
    if (!match(session.items[i])) continue
    const items = session.items.slice()
    items[i] = patch(items[i])
    return { ...session, items }
  }
  return session
}

/**
 * 右栏「改动文件」。**只收跑成功的写入**：被拒绝的 `write_file` 也会发 `tool-start`，
 * 按它来列的话，用户点了拒绝、右栏却多出一个文件。
 *
 * 从条目里现算而不是另存一份，是为了让「同一文件改两次」天然去重、且顺序跟着消息流走。
 */
export function changedFiles(session) {
  const out = []
  for (const item of session?.items ?? []) {
    if (item.kind !== 'tool' || item.status !== 'ok' || !WRITE_TOOLS.has(item.name)) continue
    if (item.summary && !out.includes(item.summary)) out.push(item.summary)
  }
  return out
}

/** 待办清单直接来自 `agent.todos.toJSON()`，不需要再加工，但渲染层要能少写一次判空 */
export function todoItems(session) {
  return session?.todos ?? []
}

/**
 * 把落盘的 `WireMessage[]` 还原成消息流条目，用于打开历史会话。
 *
 * 两件必须知道的事：
 * - **wire 格式的 `tool` 消息里没有工具名**，名字和参数在前面那条
 *   `assistant.tool_calls` 里，只能靠 `tool_call_id` 对回去。不这么做的结果是
 *   恢复出来的工具卡片全部没有名字。
 * - **落盘格式不记「这次工具调用成没成功」**：拒绝授权和工具自己报错都是往 tool
 *   消息里塞一段文本而已。所以这里的状态是 `done` 而不是 `ok` —— 认成成功的话，
 *   用户当初点了拒绝的那次写入，重开会话后右栏会凭空多出来一个文件。
 */
export function toItems(messages) {
  const names = new Map()
  const items = []

  for (const message of messages ?? []) {
    if (message.role === 'user') {
      items.push({ kind: 'user', text: message.content ?? '' })
      continue
    }

    if (message.role === 'assistant') {
      if (message.content) items.push({ kind: 'assistant', text: message.content, streaming: false })
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name ?? ''
        names.set(call.id, name)
        items.push({
          kind: 'tool',
          name,
          summary: summarizeArgs(call.function?.arguments),
          status: 'running',
          output: '',
          result: '',
          elapsedMs: 0,
        })
      }
      continue
    }

    if (message.role === 'tool') {
      const name = names.get(message.tool_call_id)
      // 工具是串行跑的，从后往前第一个还没收尾、名字又对得上的卡片就是它
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind !== 'tool' || item.status !== 'running' || item.name !== name) continue
        items[i] = { ...item, status: 'done', result: message.content ?? '' }
        break
      }
    }
    // system：恢复时 Agent 会按当前配置重新生成，画出来只会是过期的旧提示词
  }

  return items
}

/**
 * 增量重绘时该动哪几个 DOM 节点，返回条目下标。
 *
 * 单独抽出来是因为它的失败模式太隐蔽：新建的节点忘了画，界面不会报错，
 * 只是「切走再切回来前面全是空白」—— 看着像对话丢了。这里定了就没得漏。
 *
 * 名单 = 所有新建的（`prev .. next-1`）+ 尾巴（`next-1`），后者去重。
 * 条目是不可变的，追加不会改动已存在的那几条，所以老老实实画尾巴就够 ——
 * 多画一条不会出错，但那是流式每一帧都要白付一次的开销。
 */
export function streamPlan(prev, next) {
  if (next <= 0) return []
  const out = []
  for (let i = Math.max(0, prev); i < next; i++) out.push(i)
  if (out[out.length - 1] !== next - 1) out.push(next - 1)
  return out
}

/** 卡片标题上那点摘要。参数不是合法 JSON 时留空 —— 模型偶尔会吐出半截 JSON */
function summarizeArgs(raw) {
  try {
    const args = JSON.parse(raw ?? '')
    return args?.path ?? args?.command ?? args?.pattern ?? ''
  } catch {
    return ''
  }
}
