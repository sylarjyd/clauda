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
  'badge-sessions', 'badge-model', 'badge-skills', 'badge-mcp',
  'view-sessions', 'view-settings', 'settings-title', 'settings-sub', 'settings-body',
  'new-session', 'pick-project', 'project-path', 'session-list', 'notices', 'chat-title',
  'model-input', 'mode-select', 'context-fill', 'stream', 'composer', 'input', 'abort',
  'attach-list', 'attach', 'drop-hint',
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

  // 厂商表直接用**真的那一份**（dist 里的）：写死在 fixture 里的话，表改了界面测试
  // 还是绿的，就测不出「选择器少画了一项」这类错
  const { VENDORS, vendorByBaseUrl } = await import(
    new URL('../dist/provider/vendors.js', import.meta.url).href
  )

  // 用例可以改它，模拟「配错了的服务器连不上」。默认成功
  const mcp = { fail: null }

  /**
   * 附件相关。**主进程那侧的行为一律不在这里实现**（读字节、判 4MB、认扩展名都是
   * `src/runtime/attachment.ts` 的事，unit.mjs 里真造文件测）。这里只做两件事：
   * 把 renderer 送上来的原始形状原样报回一条归一化结果，好让断言盯着
   * 「chip 有没有画出来」「submit 有没有把它们带上去」。
   */
  const ingestCalls = []
  const picker = { paths: [] }
  /** 送给 `session/send` 的每份 payload。断言「附件有没有跟着消息出去」只能看它 */
  const sent = []
  /**
   * 让用例把 `session/send` 弄成失败 / 部分失败。默认两个字段都是空的（一切正常）。
   * `fail` 非空时返回 `{ok:false}`，用来验「发送失败不能清空附件」这条 ——
   * 清空 + 报错的组合会让用户白拖一遍。
   */
  const sendBehavior = { fail: null, dropped: 0 }
  const savedModels = []
  const savedProfileAdds = []
  const savedBaseUrls = []
  const savedActive = []
  const savedRemovals = []
  /**
   * 两份档案，**当前使用的那份不是列表里的第一份**（顺序按 key 排，`custom` 在前）——
   * 这样「选中」和「当前使用」混成一套判据时，界面测试立刻能抓到。
   *
   * `custom` 的地址故意不是任何预置：默认状态下厂商应该认成「自定义」。
   */
  const projectInfo = {
    cwd: 'C:/p',
    configFile: 'C:/p/.clauda/config.json',
    provider: {
      baseUrl: 'http://127.0.0.1:9/v1',
      vendorKey: '__custom__',
      apiKeyHint: '····abcd',
      model: 'desk-model',
      temperature: 0.3,
      maxTokens: 4096,
    },
    profiles: [
      {
        key: 'custom',
        label: 'custom',
        vendorKey: '__custom__',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'desk-model',
        temperature: 0.3,
        maxTokens: 4096,
        apiKeyHint: '····abcd',
        isActive: true,
      },
      {
        key: 'kimi',
        label: 'Kimi（月之暗面）',
        vendorKey: 'kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2.6',
        temperature: 0,
        maxTokens: 8192,
        apiKeyHint: '',
        isActive: false,
      },
    ],
    activeProvider: 'custom',
    vendors: VENDORS,
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
        if (channel === 'session/send') {
          sent.push(payload)
          if (sendBehavior.fail) return { ok: false, reason: sendBehavior.fail }
          return { ok: true, dropped: sendBehavior.dropped || undefined }
        }
        if (channel === 'attachment/ingest') {
          ingestCalls.push(payload)
          if (picker.rejectAll) return { ok: true, attachments: [], rejected: ['（桩：一律拒绝）'] }
          return {
            ok: true,
            attachments: (payload.items ?? []).map((it) => {
              const isImage =
                String(it.mime ?? '').startsWith('image/') ||
                /\.(png|jpe?g|webp|gif)$/i.test(String(it.path ?? ''))
              return {
                kind: isImage ? 'image' : 'file',
                name: it.name || 'stub',
                path: it.path,
                // 有 dataUrl 就用它（剪贴板那条路），否则现编一个 data URL（磁盘那条路）
                dataUrl: isImage ? (it.dataUrl ?? 'data:image/png;base64,AAAA') : undefined,
                bytes: 12,
              }
            }),
            rejected: picker.rejected ?? [],
          }
        }
        if (channel === 'project/info') return { ok: true, info: projectInfo }
        if (channel === 'project/set-default-model' || channel === 'project/set-base-url') {
          if (channel === 'project/set-default-model') savedModels.push(payload)
          else savedBaseUrls.push(payload)
          // 真后端写的是**选中的那份档案**（`profileKey`），写完内存里那份模板跟着变，
          // 随后的 project/info 就是新值。桩里照做 —— 只改那一份，别的一份都不碰：
          // 这正是「改 B 的地址会不会顺手动了 A」的判据
          const profile = projectInfo.profiles.find((p) => p.key === payload.profileKey)
          if (!profile) return { ok: false, reason: `未知档案：${payload.profileKey}` }
          if (channel === 'project/set-base-url') {
            profile.baseUrl = payload.baseUrl
            profile.vendorKey = vendorByBaseUrl(payload.baseUrl)?.key ?? '__custom__'
            profile.label = vendorByBaseUrl(payload.baseUrl)?.label ?? profile.key
          } else {
            profile.model = payload.model
          }
          // 当前使用的那份，`provider` 那个解析视图也跟着变
          if (profile.isActive) Object.assign(projectInfo.provider, {
            baseUrl: profile.baseUrl,
            vendorKey: profile.vendorKey,
            model: profile.model,
          })
          return { ok: true, file: projectInfo.configFile }
        }
        if (channel === 'project/add-profile') {
          savedProfileAdds.push(payload)
          const preset = VENDORS.find((v) => v.key === payload.vendorKey)
          // 认不出的 key 按「自定义」处理，和主进程一致（`__custom__` 走的就是这条）
          const key = preset ? preset.key : 'custom-2'
          if (projectInfo.profiles.some((p) => p.key === key)) return { ok: false, reason: `已经有一份叫「${key}」的档案了` }
          projectInfo.profiles.push({
            key,
            label: preset?.label ?? key,
            vendorKey: preset?.key ?? '__custom__',
            baseUrl: preset?.baseUrl ?? '',
            model: preset?.models[0] ?? '',
            temperature: 0,
            maxTokens: 8192,
            apiKeyHint: '',
            isActive: false,
          })
          return { ok: true, file: projectInfo.configFile, key }
        }
        if (channel === 'project/set-active-provider') {
          savedActive.push(payload)
          const profile = projectInfo.profiles.find((p) => p.key === payload.profileKey)
          if (!profile) return { ok: false, reason: `没有这个厂商档案：${payload.profileKey}` }
          if (!profile.baseUrl || !profile.model) return { ok: false, reason: '这份档案还缺参数' }
          for (const p of projectInfo.profiles) p.isActive = p.key === profile.key
          projectInfo.activeProvider = profile.key
          Object.assign(projectInfo.provider, {
            baseUrl: profile.baseUrl,
            vendorKey: profile.vendorKey,
            model: profile.model,
            apiKeyHint: profile.apiKeyHint,
          })
          return { ok: true, file: projectInfo.configFile }
        }
        if (channel === 'project/remove-profile') {
          savedRemovals.push(payload)
          const at = projectInfo.profiles.findIndex((p) => p.key === payload.profileKey)
          if (at < 0) return { ok: false, reason: `没有这个厂商档案：${payload.profileKey}` }
          if (projectInfo.profiles[at].isActive) return { ok: false, reason: '这是当前使用的厂商，先切到别家再删' }
          projectInfo.profiles.splice(at, 1)
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
      pickFiles: async () => picker.paths,
      /**
       * 真实现是 `webUtils.getPathForFile`：**同步**，且对没有磁盘来源的 File 返回空串。
       * 桩按同样的契约来 —— 用例给 File 造一个 `path` 字段就走磁盘那条路，不给就是
       * 剪贴板那条（renderer 得自己 FileReader 读）。
       */
      pathForFile: (file) => file?.path ?? '',
    },
  }

  // FileReader 只有剪贴板那条路会用到（有磁盘路径时根本不读字节）。
  // 桩里直接回一个固定长度的 data URL，够验证「renderer 把 dataUrl 报上去了」
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,UE5H'
      this.onload?.()
    }
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
    savedProfileAdds,
    savedBaseUrls,
    savedActive,
    savedRemovals,
    vendors: VENDORS,
    projectInfo,
    /** 送给 `attachment/ingest` 的每一份 payload，断言 renderer 报了些什么 */
    ingestCalls,
    /** 送给 `session/send` 的每一份 payload */
    sent,
    /** 改它来喂「选文件」那条入口 */
    picker,
    /** 改它来喂「发送失败 / 有附件被丢掉」两条路径 */
    sendBehavior,
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
  delete globalThis.FileReader
}
