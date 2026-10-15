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
  'nav-agents', 'nav-sessions', 'nav-model', 'nav-skills', 'nav-mcp',
  'nav-settings', 'settings-group',
  // 点开「设置」时要让位的两块。少了它们 renderRail 会直接抛
  'rail', 'browse',
  'badge-agents', 'badge-sessions', 'badge-model', 'badge-skills', 'badge-mcp',
  'view-sessions', 'view-settings', 'settings-title', 'settings-sub', 'settings-body',
  'new-session', 'new-session-agent', 'pick-project', 'project-path', 'session-list',
  'chat-title', 'chat-agent',
  'model-input', 'mode-select', 'context-fill', 'stream', 'empty-questions',
  'composer', 'input', 'abort',
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
 * 每次 `bootRenderer()` 给 app.js 的 import 换一个 query，逼 Node 重新求值那份模块。
 *
 * **why**：ESM 的 import 是按 URL 缓存的。`app.js` 在模块顶层就跑 `boot()` 并把
 * `els` / `state` / `cwd` 这些钉在**第一次**那份 `globalThis.document` 上，所以第二次
 * `bootRenderer()` 若命中缓存，整套界面还连着**上一份**假 DOM，新 `byId` 一个 children
 * 都拿不到（症状：`session-list.children[0]` 是 undefined）。带上 `?v=n` 就各跑各的，
 * 每个用例块都能从干净的一页开始。
 */
let bootCount = 0

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
  const savedSkillAdds = []
  const savedSkillRemovals = []
  /** `skill/set-disabled` 的每一份 payload。断言「开关有没有把 disabled 反过来发」只能看它 */
  const savedSkillDisables = []
  const savedMcpAdds = []
  const savedMcpRemovals = []
  /** `mcp/tools/set` 的每一份 payload。断言「全勾上发的是 null 还是名单」只能看它 */
  const savedMcpToolSets = []
  const savedAgentAdds = []
  const savedAgentRemovals = []
  const savedAgentDefaults = []
  /** `session/delete` 的每一份 payload。断言「删的是不是这一条、cwd 带对没有」只能看它 */
  const savedSessionDeletes = []
  /**
   * 让用例把 `skill/add` / `mcp/add` 弄成失败。默认是空的（写盘成功）。
   * `mcp.fail` 是**每台服务器**的失败原因（`mcp/set-enabled` 那条既有分支在用），
   * 加号失败是另一码事 —— 名字不同、时机不同，所以另开一格
   */
  const skillBehavior = { fail: null }
  const mcpAddBehavior = { fail: null }
  const agentBehavior = { fail: null }
  /** 让用例把 `session/delete` 弄成失败，验「失败要报出来、别假装删掉了」 */
  const sessionDeleteBehavior = { fail: null }
  /**
   * 智能体的**磁盘真相**。`project/info` 那份是从这里折出六个字段的，正文与配置明细
   * 只有 `agent/get` 才给 —— 桩要是把它们也塞进 `projectInfo.agents`，就永远测不出
   * 「右栏的正文必须走 `agent/get` 那条路」。
   *
   * 两份的取法都是刻意的：
   * - `code-review` 是本项目默认，`questions` 非空（空态那几条靠它）；`temperature: 0`
   *   是**有效值**，和「没写」必须能分开。
   * - `kimi-chat` 不是默认、`temperature` **没写**（读回草稿时得是空栏而不是 0），
   *   并且带一条非空的 `problem`（档案没了的降级提示，界面得摆出来）。
   *
   * `problem` 在真后端是拿着项目配置算出来的，不在 `ResolvedAgent` 上；这里挂在桩的
   * 记录里，只为让 `project/info` 那条提示有东西可画。
   */
  const agentStore = {
    'code-review': {
      name: 'code-review',
      description: '按严重程度审查改动',
      dir: 'C:/p/.clauda/agents/code-review',
      file: 'C:/p/.clauda/agents/code-review/AGENT.md',
      scope: 'project',
      profile: 'custom',
      model: '',
      temperature: 0,
      permission: 'default',
      allow: ['write_file'],
      deny: ['Bash(rm:*)'],
      tools: ['read_file', 'grep'],
      skills: ['demo'],
      questions: ['这次改动有什么风险？', '跑测试要装什么，怎么装？'],
      body: '你是一名严格的代码审查员。',
      problem: '',
    },
    'kimi-chat': {
      name: 'kimi-chat',
      description: '闲聊用的',
      dir: 'C:/home/.clauda/agents/kimi-chat',
      file: 'C:/home/.clauda/agents/kimi-chat/AGENT.md',
      scope: 'global',
      profile: 'kimi',
      model: '',
      temperature: undefined,
      permission: undefined,
      allow: undefined,
      deny: undefined,
      tools: [],
      skills: [],
      questions: [],
      body: '你是个随和的助手。',
      problem: '档案「kimi」找不到，用的是当前使用的那份',
    },
  }

  /**
   * `project/info` 里那一条：**只有这六个字段**。真后端就是这么拼的（`AgentInfo`），
   * 正文、白名单、常见问题一概不在里面 —— `project/info` 被每轮刷新的徽标拖着走。
   */
  const agentBrief = (a, isDefault) => ({
    name: a.name,
    description: a.description,
    file: a.file,
    scope: a.scope,
    isDefault,
    problem: a.problem ?? '',
  })

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
    // 一条开着的、一条关掉的：开关和「已关掉」那块折叠区各要一个能验证的目标
    skills: [
      {
        name: 'demo',
        description: '演示技能',
        dir: 'C:/p/.clauda/skills/demo',
        file: 'C:/p/.clauda/skills/demo/SKILL.md',
        disabled: false,
      },
      {
        name: 'heavy',
        description: '很占地方的那个技能',
        dir: 'C:/p/.clauda/skills/heavy',
        file: 'C:/p/.clauda/skills/heavy/SKILL.md',
        disabled: true,
      },
    ],
    mcp: [
      // 3 个工具里挑过 2 个：带分母的那一版文案（`工具 2/3`）和「挑选工具」那个三角
      // 都得有个能验证的目标。没挑过的那台在 `broken` 上（它压根没连上）
      {
        name: 'demo',
        transport: 'stdio',
        state: 'connected',
        toolCount: 2,
        toolTotal: 3,
        toolLabel: '工具 2/3',
      },
      // 刻意配错、连不上的那台。用例靠它验「开关失败必须报出来」
      { name: 'broken', transport: 'http', state: 'disabled', toolCount: 0, toolTotal: 0, toolLabel: '工具 0' },
    ],
    mcpCost: { tokens: 900, servers: 1, tools: 2, infoText: '已接入 MCP：1 个服务器 / 2 个工具', warnText: '' },
    // 技能成本汇总，**每次 `project/info` 现算**（见 `recountSkills`）。早先在这儿抄过
    // 一份字面量，于是「关掉一个之后页脚的数字变了没有」永远测不出 —— 抄来的数字不会变
    skillCost: null,
    // 智能体。**只到这六个字段为止**（见 `agentBrief`）；正文要正文走 `agent/get`
    agents: [
      agentBrief(agentStore['code-review'], true),
      agentBrief(agentStore['kimi-chat'], false),
    ],
    // 本项目默认。有它，`#new-session-agent` 那一格才有个可验证的初始选中项
    defaultAgent: 'code-review',
  }

  /**
   * 每台服务器**上报过的全部工具**，`mcp/tools/get` 的返回。`allowed` 由白名单算出来，
   * 真后端那边是 `allowed()` 现判的。
   *
   * `search` 那一条的 `localName` 和 `name` **故意不一样**：消毒去重之后本地名字会变，
   * 界面上得把它印出来，否则用户在授权弹窗里看到的名字对不上号。
   */
  const mcpToolStore = {
    demo: [
      { name: 'create_issue', localName: 'create_issue', description: '新建一个 issue', tokens: 320, allowed: true },
      { name: 'search', localName: 'mcp__demo__search', description: '搜索已有条目', tokens: 180, allowed: true },
      { name: 'delete_all', localName: 'delete_all', description: '删光所有条目', tokens: 90, allowed: false },
    ],
    broken: [],
  }

  /** 按 `skills` 现算成本汇总 —— 真后端也是每轮从注册表重算一遍。
   *
   * 桩要**算**而不是**存**，是因为开关和增删都会动到它：存下来的数字不跟着变，而「关掉一个
   * 之后页脚少了多少 token」恰好是这一页主要想告诉人的事。
   *
   * 数字不照着 `mcpCost` 那套量级（一台上千）走：技能索引一行才几 token，真按 40/120 编
   * 得离谱反而会掩盖「这一页在讲省了多少」的判断。
   */
  function recountSkills() {
    const on = projectInfo.skills.filter((s) => !s.disabled)
    const off = projectInfo.skills.filter((s) => s.disabled)
    projectInfo.skillCost = {
      tokens: on.length * 40,
      saved: off.length * 120,
      on: on.length,
      off: off.length,
      infoText:
        off.length > 0
          ? `技能索引：${projectInfo.skills.length} 个里开着 ${on.length} 个，约 +${on.length * 40} token 上下文；关掉的 ${off.length} 个若全开着再多约 +${off.length * 120}`
          : `${on.length} 个技能全部开着，约 +${on.length * 40} token 上下文（每轮请求都要付一遍）`,
      warnText: '',
    }
  }
  recountSkills()

  /**
   * 按工具清单现算 `toolCount` / `toolTotal` / `toolLabel` 三个数 —— 真后端也是从白名单
   * 现算的（`allowed()`），而不是把「接进来几个」单独存一份。
   *
   * 三兄弟必须一起走：`toolLabel` 是主进程出的那句 `工具 2/3`，桩里要是不跟着改，
   * 「勾掉一个之后那一行的话变了没有」就永远测不出来。
   */
  function syncMcpToolCount(name) {
    const server = projectInfo.mcp.find((s) => s.name === name)
    const tools = mcpToolStore[name]
    if (!server || !tools) return
    server.toolTotal = tools.length
    server.toolCount = tools.filter((t) => t.allowed).length
    server.toolLabel =
      server.toolTotal > server.toolCount
        ? `工具 ${server.toolCount}/${server.toolTotal}`
        : `工具 ${server.toolCount}`
  }
  for (const name of Object.keys(mcpToolStore)) syncMcpToolCount(name)

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
          // `agent` 是**名字**（'' = 明确不要智能体）。真后端解析不出来时只警告、不抛 ——
          // 桩照做，否则「名字给过却已经不在了」这条降级路径根本走不到
          const asked = typeof payload.agent === 'string' ? payload.agent : ''
          const spec = asked ? agentStore[asked] : undefined
          const session = {
            id,
            cwd: payload.cwd,
            model: 'm',
            mode: 'default',
            tools: [],
            todos: [],
            contextTokens: 0,
            contextRatio: 0,
            agentName: spec ? spec.name : '',
            // 空态那几条只能来自**这份会话冻结的** AgentSpec，不能回头按名字现查 ——
            // 回头查的话，改一个智能体的常见问题，老会话的空态会跟着变
            agentQuestions: spec?.questions ?? [],
            agentWarning:
              asked && !spec ? `智能体「${asked}」已经不在了，这个会话按默认配置打开` : '',
          }
          opened.set(id, session)
          return { ok: true, session }
        }
        if (channel === 'session/state') return { ok: true, session: opened.get(payload.sessionId) }
        // 删除会话。**显式写**，否则会落到兜底的 `{ok:true}` 上 —— 那样「删了但没删
        // 对一条」也会被判成功。桩照真后端的行为把那条会话从内存里抹掉
        if (channel === 'session/delete') {
          savedSessionDeletes.push(payload)
          if (sessionDeleteBehavior.fail) return { ok: false, reason: sessionDeleteBehavior.fail }
          opened.delete(payload.id)
          return { ok: true, file: `C:/p/.clauda/projects/p/sessions/${payload.id}.json` }
        }
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
        // 每份快照都现算一遍成本汇总：渲染层只在这儿拿项目信息，放这一处就够
        if (channel === 'project/info') {
          recountSkills()
          return { ok: true, info: projectInfo }
        }
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
        // 智能体的增删改查。**这四条同样必须显式写**（理由见下一条注释）：落到兜底的
        // `{ok:true}` 上就是「保存了、磁盘没变，测试还报成功」
        if (channel === 'agent/add') {
          savedAgentAdds.push(payload)
          if (agentBehavior.fail) return { ok: false, reason: agentBehavior.fail }
          const root = payload.scope === 'global' ? 'C:/home/.clauda/agents' : 'C:/p/.clauda/agents'
          const file = `${root}/${payload.name}/AGENT.md`
          // 同名**整份覆盖**，所以它同时是「保存」；`created` 决定界面报「新建」还是「保存」
          const created = !(payload.name in agentStore)
          agentStore[payload.name] = {
            name: payload.name,
            description: payload.description ?? '',
            dir: `${root}/${payload.name}`,
            file,
            scope: payload.scope,
            profile: payload.profile ?? '',
            model: payload.model ?? '',
            temperature: payload.temperature,
            permission: payload.permission,
            allow: payload.allow,
            deny: payload.deny,
            tools: payload.tools ?? [],
            skills: payload.skills ?? [],
            questions: payload.questions ?? [],
            body: payload.body ?? '',
            problem: agentStore[payload.name]?.problem ?? '',
          }
          const brief = agentBrief(agentStore[payload.name], projectInfo.defaultAgent === payload.name)
          const at = projectInfo.agents.findIndex((a) => a.name === payload.name)
          if (at >= 0) projectInfo.agents[at] = brief
          else projectInfo.agents.push(brief)
          return { ok: true, file, created }
        }
        if (channel === 'agent/get') {
          const agent = agentStore[payload.name]
          // 找不到**报失败**，不能静默成功 —— 那会让用户对着一个空表单以为「它本来就是空的」
          return agent ? { ok: true, agent } : { ok: false, reason: `没有这个智能体：${payload.name}` }
        }
        if (channel === 'agent/remove') {
          savedAgentRemovals.push(payload)
          const at = projectInfo.agents.findIndex((a) => a.name === payload.name)
          if (at < 0) return { ok: false, reason: `没有这个智能体：${payload.name}` }
          const gone = agentStore[payload.name]
          projectInfo.agents.splice(at, 1)
          delete agentStore[payload.name]
          return { ok: true, dir: gone.dir }
        }
        if (channel === 'project/set-default-agent') {
          savedAgentDefaults.push(payload)
          // `''` 是「取消默认」，不是错误
          if (payload.name && !agentStore[payload.name]) {
            return { ok: false, reason: `没有这个智能体：${payload.name}` }
          }
          projectInfo.defaultAgent = payload.name ?? ''
          for (const a of projectInfo.agents) a.isDefault = a.name === projectInfo.defaultAgent
          return { ok: true, file: projectInfo.configFile }
        }
        // 连不上的服务器：`McpManager.setEnabled` 会抛，channel 层翻成 `{ok:false, reason}`。
        // 界面必须把这个 reason 显示出来，不能报成功
        if (channel === 'mcp/set-enabled') {
          const reason = mcp.fail?.[payload.name]
          return reason ? { ok: false, reason } : { ok: true }
        }
        // 技能与 MCP 的增删。**这四条必须显式写**：不写的话会落到下面那句
        // `return { ok: true }` 上，于是「保存了但磁盘没变」也被判成成功
        if (channel === 'skill/add') {
          savedSkillAdds.push(payload)
          if (skillBehavior.fail) return { ok: false, reason: skillBehavior.fail }
          const root = payload.scope === 'global' ? 'C:/home/.clauda/skills' : 'C:/p/.clauda/skills'
          const file = `${root}/${payload.name}/SKILL.md`
          projectInfo.skills.push({
            name: payload.name,
            description: payload.description,
            dir: `${root}/${payload.name}`,
            file,
            // 新建的必然是开着的 —— 真后端那边新技能也不在 `disabledSkills` 里
            disabled: false,
          })
          return { ok: true, file }
        }
        if (channel === 'skill/remove') {
          savedSkillRemovals.push(payload)
          const at = projectInfo.skills.findIndex((s) => s.name === payload.name)
          if (at < 0) return { ok: false, reason: `没有这个技能：${payload.name}` }
          const [gone] = projectInfo.skills.splice(at, 1)
          return { ok: true, dir: gone.dir }
        }
        if (channel === 'skill/set-disabled') {
          savedSkillDisables.push(payload)
          const target = projectInfo.skills.find((s) => s.name === payload.name)
          if (!target) return { ok: false, reason: `没有这个技能：${payload.name}` }
          // 汇总不在这一支重算 —— 渲染层改完必再要一次 `project/info`，那儿统一算
          target.disabled = payload.disabled === true
          const file = payload.scope === 'project' ? projectInfo.configFile : 'C:/home/.clauda/config.json'
          return { ok: true, files: [file] }
        }
        if (channel === 'mcp/add') {
          savedMcpAdds.push(payload)
          if (mcpAddBehavior.fail) return { ok: false, reason: mcpAddBehavior.fail }
          if (projectInfo.mcp.some((s) => s.name === payload.name)) {
            return { ok: false, reason: `服务器 "${payload.name}" 连不上` }
          }
          const file =
            payload.scope === 'global' ? 'C:/home/.clauda/config.json' : projectInfo.configFile
          projectInfo.mcp.push({
            name: payload.name,
            transport: payload.config.type ?? (payload.config.url ? 'http' : 'stdio'),
            state: 'connected',
            toolCount: 2,
            toolTotal: 2,
            toolLabel: '工具 2',
          })
          // 刚接上的服务器也有一份清单：没有它，展开那一行只会说「这台报了 0 个工具」
          mcpToolStore[payload.name] = [
            { name: 'ping', localName: 'ping', description: '探活', tokens: 100, allowed: true },
            { name: 'stats', localName: 'stats', description: '看统计', tokens: 120, allowed: true },
          ]
          syncMcpToolCount(payload.name)
          return { ok: true, file }
        }
        if (channel === 'mcp/remove') {
          savedMcpRemovals.push(payload)
          const at = projectInfo.mcp.findIndex((s) => s.name === payload.name)
          if (at < 0) return { ok: false, reason: `没有名为 "${payload.name}" 的 MCP 服务器` }
          projectInfo.mcp.splice(at, 1)
          delete mcpToolStore[payload.name]
          return { ok: true, file: projectInfo.configFile }
        }
        if (channel === 'mcp/tools/get') {
          const tools = mcpToolStore[payload.name]
          // 真后端没连上就是空数组（`perServer` 里没有它），不是报错
          if (!tools) return { ok: true, tools: [] }
          return { ok: true, tools: tools.map((t) => ({ ...t })) }
        }
        if (channel === 'mcp/tools/set') {
          savedMcpToolSets.push(payload)
          const tools = mcpToolStore[payload.name]
          if (!tools) return { ok: false, reason: `没找到「${payload.name}」写在哪个配置文件里，白名单没改` }
          // `tools: null` = 不要白名单（全接）；数组 = 就要这几个（**空数组是「一个都不接」**，
          // 不是「没给」—— 这一条正是这个通道收三态而不是收数组的全部理由）
          const wanted = payload.tools === null ? null : new Set(payload.tools)
          for (const t of tools) t.allowed = wanted === null || wanted.has(t.name)
          syncMcpToolCount(payload.name)
          return { ok: true, file: projectInfo.configFile, tools: tools.map((t) => ({ ...t })) }
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

  await import(new URL(`../desktop/renderer/app.js?v=${++bootCount}`, import.meta.url).href)
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
    savedSkillAdds,
    savedSkillRemovals,
    savedSkillDisables,
    savedMcpAdds,
    savedMcpRemovals,
    savedMcpToolSets,
    savedAgentAdds,
    savedAgentRemovals,
    savedAgentDefaults,
    savedSessionDeletes,
    skillBehavior,
    mcpAddBehavior,
    agentBehavior,
    sessionDeleteBehavior,
    vendors: VENDORS,
    projectInfo,
    /** 智能体的磁盘真相（`agent/get` 给的就是这里的一份）。用例可以直接改它 */
    agentStore,
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
