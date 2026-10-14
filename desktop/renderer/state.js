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

/**
 * 待发附件上限。和主进程 `src/runtime/attachment.ts` 的 `MAX_ATTACHMENTS` 是同一个数，
 * 但**只能各写一份** —— renderer 走 `app://` 拿不到 `dist/`，那边也有同样的手抄
 * （`UserAttachment` 的形状）。改一个记得改另一个。
 */
export const MAX_ATTACHMENTS = 8

/**
 * 单张图片上限，同样和 `src/runtime/attachment.ts` 的 `MAX_IMAGE_BYTES` 对齐。
 *
 * 渲染层判这一下不是重复劳动：粘上来的截图没有磁盘路径，得先在**这里**用 FileReader
 * 读成 base64 再送过去 —— 不先判大小的话，一张 50MB 的图会先在渲染进程里编码一遍
 * （卡住整个界面、内存翻三倍），然后才被主进程丢掉。
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * 左导航的五个视图。`'sessions'` 是中栏那张对话，其余四个是共用一个容器的设置页
 * （见 `SETTINGS_META`）。
 *
 * 归约时挡一道是因为视图名还会被拿去当对象的下标找元数据 —— 拼错了不会报错，
 * 只会画出一片空白，别指望肉眼发现。
 */
export const VIEWS = ['sessions', 'agents', 'model', 'skills', 'mcp']

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
    /** 左导航选中的视图，见 `VIEWS` */
    view: 'sessions',
    /**
     * 挂在输入框上、还没发出去的附件。
     *
     * **按整个界面一份，不按会话分** —— 界面上只有一个 `#composer`。也**不在切换会话时
     * 清空**：`#input` 里没发出去的字在切会话时本来就跟着走，只清附件的话，用户会在
     * 新会话里看到自己的半句话还在、以为附件也在，于是发出一封没有附件的信。
     */
    attachments: [],
    /**
     * `project/info` 的结果，模型 / 技能 / MCP 三个设置页共用这一份。
     *
     * 它是**按项目目录**来的（技能、MCP、厂商档案全是项目级的），所以一个会话都没开
     * 也该有值。null 只表示「还没选目录」或「正在重新拉」。
     */
    project: null,
  }
}

/**
 * 会话快照的字段与缺省值。打开会话和 `session-state` 回填**必须共用这一份**。
 *
 * **每个后端会下发的字段都得在这儿列一行**：`mergeSnapshot` 只认这份名单里的键，
 * 没列进去的会被静默丢掉 —— 症状是「后端明明发了 `agentName`，顶栏永远空着」。
 */
const SESSION_DEFAULTS = {
  cwd: '',
  title: '',
  model: '',
  mode: 'default',
  tools: [],
  todos: [],
  contextTokens: 0,
  contextRatio: 0,
  /** 这个会话绑的智能体名，空串 = 没绑。取自 `SessionInfo`，不是项目的默认智能体 */
  agentName: '',
  /** 空态可点的问题。取自**这份会话冻结的** AgentSpec，见 `SessionInfo.agentQuestions` */
  agentQuestions: [],
  /** 非空时界面弹**一次**通知：绑的智能体已经不在了，这个会话按默认配置打开 */
  agentWarning: '',
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
      // 项目信息**不跟着会话清**：它是按 cwd 拉的，同一个项目下的会话切来切去，
      // 配置 / 技能 / MCP 一个字都不会变。清掉只会让设置页闪一下空态。
      // 真换了项目（点开另一个项目里的会话）由 app.js 那边跟着换 cwd 并重拉
      return { ...state, activeId: action.id }
    case 'session-opened':
      return openSession(state, action.session)
    case 'view':
      return VIEWS.includes(action.view) ? { ...state, view: action.view } : state
    case 'project-info':
      return { ...state, project: action.info ?? null }
    case 'attach':
      return { ...state, attachments: addAttachments(state.attachments, action.attachments ?? []) }
    case 'detach':
      return { ...state, attachments: state.attachments.filter((_, i) => i !== action.index) }
    case 'clear-attachments':
      return { ...state, attachments: [] }
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
    // 同理 `select`：新会话是另一个项目（或至少是一份新的运行时），旧的项目信息作废
    project: null,
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
      // `images` 是本地预览（data URL）：气泡立刻把图显示出来，不等主进程那一圈回来
      return push(session, { kind: 'user', text: action.text, images: action.images ?? [] })

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

/**
 * 并入新附件。
 *
 * 按**来源**去重：同一个文件拖两次是个很自然的动作，不去重的话发出去就是同一张图两遍，
 * 白付一份 token、还占掉一个名额。图片没有磁盘路径，就只能靠「文件名 + 字节数」认。
 */
function addAttachments(current, incoming) {
  const out = current.slice()
  const seen = new Set(out.map(attachmentKey))
  for (const att of incoming) {
    const key = attachmentKey(att)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(att)
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

function attachmentKey(att) {
  return att?.path ? `p:${att.path}` : `n:${att?.name ?? ''}:${att?.bytes ?? 0}`
}

/**
 * 送给 `session/send` 的那份。**一字段不多带** —— 主进程的 `sanitizeAttachments`
 * 是按归一化形状重新验一遍的，这里多塞的字段到那边只会被丢掉（图片的 `bytes` 还是
 * 它自己按 data URL 长度重算的，不认这份）。
 */
export function attachmentPayload(attachments) {
  return (attachments ?? []).map((a) =>
    a.kind === 'image'
      ? { kind: 'image', name: a.name, dataUrl: a.dataUrl, bytes: a.bytes }
      : { kind: 'file', name: a.name, path: a.path, bytes: a.bytes },
  )
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
 * 用户气泡里该显示的字 —— **只取第一个 text 块**。
 *
 * 带图的消息 content 是数组，形状是 `[用户打的字, …图片, 附件清单]`。最后那段清单是
 * 主进程追加给模型看的（见 `src/util/message.ts` 的 `buildUserContent`），用户没必要
 * 在气泡里再看一遍自己刚拖进去的路径。纯文本消息只有一个块，行为与从前一字不差。
 *
 * 这段逻辑在 `src/util/message.ts` 的 `messageText` 里有一份更全的（那边要拼上清单，
 * 摘要和标题用），**两边不能合并**：renderer 走 `app://` 拿不到 `dist/`。
 */
export function userText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (part?.type === 'text') return typeof part.text === 'string' ? part.text : ''
  }
  return ''
}

/** 消息里所有图片的 data URL。恢复历史时气泡要重画出图片，靠的就是它 */
export function imageUrls(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') out.push(part.image_url.url)
  }
  return out
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
      items.push({ kind: 'user', text: userText(message.content), images: imageUrls(message.content) })
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
