/**
 * 一层够用的假 DOM，用来在 Node 里把 `desktop/renderer/app.js` 真跑一遍。
 *
 * 为什么要这个：`app.js` 是这次改动里最大的一块没被覆盖的代码，而它最容易出的错
 * 不是「算错了」而是「漏画了」—— `streamPlan` 那种纯逻辑单测盯不到它。用桩 DOM 把
 * `renderStream` / `paint` / `renderModal` 真正走一遍，能抓到「切走再切回来前面全是空白」
 * 这一类症状（实测抓到过一次）。
 *
 * 它不是浏览器实现的替代品：布局、样式、真实事件派发一概不管。**仍然要人工开窗口看**。
 * 这里只保证「该画的都画了、该藏的都藏了」。
 */

const IDS = [
  'app',
  'nav-sessions', 'nav-model', 'nav-skills', 'nav-mcp',
  'badge-sessions', 'badge-model', 'badge-skills', 'badge-mcp', 'rail-project',
  'view-sessions', 'view-settings', 'settings-title', 'settings-sub', 'settings-body',
  'new-session', 'pick-project', 'project-path', 'session-list', 'notices', 'chat-title',
  'model-input', 'mode-select', 'context-fill', 'stream', 'composer', 'input', 'abort',
  'changed-files', 'todos', 'modal-host',
]

class El {
  constructor(tag = 'div') {
    this.tagName = tag
    this.children = []
    this.listeners = {}
    this.className = ''
    this._class = new Set()
    this.classList = {
      add: (c) => this._class.add(c),
      remove: (c) => this._class.delete(c),
      contains: (c) => this._class.has(c),
    }
    this.dataset = {}
    this.style = {}
    this.textContent = ''
    this.value = ''
    this.hidden = false
    this.disabled = false
    this.scrollTop = 0
    this.scrollHeight = 1000
    this.clientHeight = 400
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes) {
    for (const old of this.children) old.parent = null
    this.children = []
    this.append(...nodes)
  }

  /**
   * 只在渲染层缩短消息流时用到（实际路径不可达：恢复历史会把 `openSeq` 推进一格、
   * 整个消息流推倒重画）。留着是因为桩少了 DOM 有的方法，哪天它真被走到就是个
   * 「为什么测试里说 El.remove 不是函数」的迷惑现场。
   */
  remove() {
    if (!this.parent) return
    const at = this.parent.children.indexOf(this)
    if (at >= 0) this.parent.children.splice(at, 1)
    this.parent = null
  }

  /**
   * 设置页给开关和输入框挂 `aria-label` 要用它。真 DOM 有这个方法，
   * 桩里缺一个就会在「切到技能/MCP 页」那条路径上炸成 `setAttribute is not a function`。
   */
  setAttribute(name, value) {
    ;(this.attrs ??= {})[name] = value
  }

  getAttribute(name) {
    return (this.attrs ?? {})[name] ?? null
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event })
  }

  click() {
    this.fire('click')
  }

  set innerHTML(value) {
    this._html = value
  }

  get innerHTML() {
    return this._html ?? ''
  }
}

/**
 * 装上假 DOM 并 import `app.js`。**必须在 import 之前调** —— app.js 在模块顶层就跑
 * `boot()`，晚了就是一堆 `document is not defined`。
 *
 * `sessions` 让用例自己决定 `session/open` 返回什么快照。
 */
export async function bootRenderer() {
  const byId = new Map(IDS.map((id) => [id, new El()]))
  const handlers = []
  const calls = []
  const opened = new Map()
  let seq = 0

  // 用例可以改它，模拟「配错了的服务器连不上」。默认成功
  const mcp = { fail: null }
  const savedModels = []
  const projectInfo = {
    cwd: 'C:/p',
    configFile: 'C:/p/.clauda/config.json',
    provider: {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyHint: '····abcd',
      model: 'desk-model',
      temperature: 0.3,
      maxTokens: 4096,
    },
    context: { window: 128000, autoCompact: true, compactThreshold: 0.8, maxSteps: 40 },
    permissions: { mode: 'default', allow: ['Read'], deny: ['Bash(rm:*)'] },
    skills: [
      {
        name: 'demo',
        description: '演示技能',
        dir: 'C:/p/.clauda/skills/demo',
        file: 'C:/p/.clauda/skills/demo/SKILL.md',
      },
    ],
    mcp: [
      { name: 'demo', transport: 'stdio', state: 'connected', toolCount: 2 },
      // 刻意配错、连不上的那台。用例靠它验「开关失败必须报出来」
      { name: 'broken', transport: 'http', state: 'disabled', toolCount: 0 },
    ],
    mcpCost: { tokens: 900, servers: 1, tools: 2, infoText: '已接入 MCP：1 个服务器 / 2 个工具', warnText: '' },
  }

  globalThis.document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new El(tag),
    activeElement: null,
  }

  globalThis.window = {
    clauda: {
      invoke: async (channel, payload) => {
        calls.push(channel)
        if (channel === 'project/list') return { ok: true, projects: [{ cwd: 'C:/p' }] }
        if (channel === 'session/list') return { ok: true, sessions: [] }
        if (channel === 'session/open') {
          const id = `s${++seq}`
          const session = {
            id,
            cwd: payload.cwd,
            model: 'm',
            mode: 'default',
            tools: [],
            todos: [],
            contextTokens: 0,
            contextRatio: 0,
          }
          opened.set(id, session)
          return { ok: true, session }
        }
        if (channel === 'session/state') return { ok: true, session: opened.get(payload.sessionId) }
        if (channel === 'project/info') return { ok: true, info: projectInfo }
        if (channel === 'project/set-default-model') {
          savedModels.push(payload)
          return { ok: true, file: projectInfo.configFile }
        }
        // 连不上的服务器：`McpManager.setEnabled` 会抛，channel 层翻成 `{ok:false, reason}`。
        // 界面必须把这个 reason 显示出来，不能报成功
        if (channel === 'mcp/set-enabled') {
          const reason = mcp.fail?.[payload.name]
          return reason ? { ok: false, reason } : { ok: true }
        }
        return { ok: true }
      },
      onEvent: (fn) => handlers.push(fn),
      pickDirectory: async () => 'C:/p',
    },
  }

  await import(new URL('../desktop/renderer/app.js', import.meta.url).href)
  await tick()

  return {
    el: (id) => byId.get(id),
    /** 喂一条 IPC 事件，等价于主进程 `webContents.send` */
    emit: (sessionId, event) => {
      for (const fn of handlers) fn(sessionId, event)
    },
    calls,
    opened,
    mcp,
    savedModels,
    projectInfo,
    /** 侧边栏第 n 个会话行。组的第 0 个孩子是标题，行从 1 开始 */
    row: (n) => byId.get('session-list').children[0].children[n],
    tick,
  }
}

/** app.js 里 `boot()` 是 async 的，开完会话要让它跑完一轮微任务 */
export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 卸掉假 DOM，免得影响后面还在跑的用例 */
export function uninstallDom() {
  delete globalThis.document
  delete globalThis.window
}
