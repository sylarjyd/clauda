import { Agent, type AgentOptions, type SessionSnapshot, type TurnOutcome } from '../agent/agent.js'
import {
  configPath,
  normalizeBaseUrl,
  writeProjectModel,
  writeProjectProvider,
  type ClaudaConfig,
  type PermissionMode,
} from '../config.js'
import { VENDORS, vendorByBaseUrl, type VendorPreset } from '../provider/vendors.js'
import type { McpServerStatus } from '../mcp/manager.js'
import { PermissionManager } from '../permissions.js'
import type { Provider } from '../provider/types.js'
import type { SkillMeta } from '../skills/types.js'
import type { Tool } from '../tools/types.js'
import { IpcView, type ViewEvent } from './ipc-view.js'
import { mcpCostNotice, type McpCostNotice } from './mcp-cost.js'
import { persistSession } from './persist.js'
import {
  PermissionBridge,
  toolNameOf,
  type PermissionDecision,
  type PermissionRequestEvent,
} from './permission-bridge.js'

/** 桌面端要认得的全部事件：`View` 转出来的 + 桥的授权请求 + 会话状态 */
export type RuntimeEvent = ViewEvent | PermissionRequestEvent | { type: 'session-status'; status: SessionStatus }

export interface EventSink {
  send(sessionId: string, event: RuntimeEvent): void
}

export type SessionStatus = 'idle' | 'running'

export type SendResult = { ok: true; outcome: TurnOutcome } | { ok: false; reason: string }

/**
 * 一个项目的运行时。**按 cwd 缓存、按会话引用计数**，因为 `McpManager` 会起子进程，
 * 而且它的 `closeAll()` 不可逆（关掉就不能再开）。
 */
export interface SessionProject {
  readonly cwd: string
  /**
   * 模板配置。会话创建时会被**克隆**一份 —— 见下面 `openSession` 的注释。
   */
  readonly config: ClaudaConfig
  readonly provider: Provider
  /**
   * 刻意不写成 `AgentOptions['skills']` —— 那边只声明了 `{name, description}`，
   * 而桌面端的技能页要显示 `file` / `dir`。`SkillMeta[]` 协变地满足 `SkillSummary[]`，
   * 所以传给 `Agent` 依然合法。
   */
  readonly skills?: { list(): SkillMeta[] }
  readonly memoryIndex?: AgentOptions['memoryIndex']
  /** 每次现算，跟着 MCP 开关走 */
  assembleTools(): Tool[]
  readonly mcp: {
    /** 可能抛：连接失败的服务器在这里报错，别把返回值丢掉（见 `setMcpEnabled`） */
    setEnabled(name: string, enabled: boolean): Promise<void>
    status(): McpServerStatus[]
    tokenHint(): number
    /** 只要 MCP 那几个，`assembleTools()` 是全部工具。`mcpCostNotice` 要靠它数工具个数 */
    tools(): Tool[]
  }
  /** 引用计数归零时调用 */
  dispose(): Promise<void> | void
}

/**
 * 「没认出是哪家厂商」的 key（用户手填了地址，或地址是自建网关/区域变体）。
 * renderer 拿它当「自定义」那一项的值，所以两边必须串同一个常量。
 */
export const CUSTOM_VENDOR = '__custom__'

/**
 * 桌面端「模型 / 技能 / MCP」三个设置页要的全部数据。
 *
 * 和 `SessionInfo` 一样是**可序列化快照**：renderer 拿到就能画，不用再问主进程。
 */
export interface ProjectInfo {
  cwd: string
  /** 写在哪一份配置文件上，UI 要告诉用户「改到哪去了」 */
  configFile: string
  provider: {
    baseUrl: string
    /**
     * 当前 baseUrl 对应的厂商 key，反查不到就是 `'__custom__'`（用户手填的地址）。
     *
     * **推导在主进程做**：renderer 走 `app://` 协议，`main.js` 的目录穿越检查
     * 不让它 import 到 `dist/`，所以拿不到 `VENDORS` 表的推导逻辑。这里只下发结论，
     * renderer 按 key 查下面那张表、不判 —— 否则两边各写一套判据就会互相矛盾。
     */
    vendorKey: string
    /**
     * 密钥本身**不出主进程**，只回一段能认出「配没配、是不是这一把」的提示。
     * 渲染层拿到也不该有机会把它写进日志或截图。
     */
    apiKeyHint: string
    model: string
    temperature: number
    maxTokens: number
  }
  /** 厂商预置表，原样下发给 renderer 画选择器 */
  vendors: readonly VendorPreset[]
  context: {
    window: number
    autoCompact: boolean
    compactThreshold: number
    maxSteps: number
  }
  permissions: { mode: PermissionMode; allow: string[]; deny: string[] }
  skills: SkillMeta[]
  mcp: McpServerStatus[]
  /**
   * MCP 开销提示。**措辞由 `mcpCostNotice` 统一出**，桌面端只负责摆位置 ——
   * 两端各写一套的话，改了阈值或口径没人会想起来去对齐另一边。
   */
  mcpCost: McpCostNotice
}

export interface Session {
  readonly id: string
  readonly cwd: string
  readonly config: ClaudaConfig
  readonly permissions: PermissionManager
  readonly view: IpcView
  readonly agent: Agent
  status: SessionStatus
  /** 当前轮次的取消手柄，`abort` / `closeSession` 都要用 */
  controller?: AbortController
}

/** 一轮跑下来记的账：哪些工具会作废提示词、这一轮里有没有真的跑过 */
interface TurnMark {
  invalidating: Set<string>
  dirty: boolean
}

export interface SessionManagerOptions {
  sink: EventSink
  openProject(cwd: string): SessionProject | Promise<SessionProject>
}

interface ProjectEntry {
  project: SessionProject
  /** 还开着几个会话。归零才 dispose —— `closeAll()` 不可逆 */
  refs: number
}

/**
 * 多会话并行的核心。
 *
 * 三件事在这里必须做对，否则症状都是「卡住」而不是报错：
 * - **同一会话不能并发 runTurn**：`Agent` 只有一个 pending 槽，两条 user 消息交错入栈
 *   会让第一条的 Promise 泄漏
 * - **config 按会话克隆**：`/model` 写 `config.provider.model`、`/mode` 写
 *   `config.permissions.mode`，共享的话 A 切模型会串到所有会话
 * - **授权 Promise 必须能结清**：`PermissionManager` 的 `ask` 不监听 signal，
 *   所以每条取消路径都要先 `denyAll`
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly projects = new Map<string, ProjectEntry>()
  private readonly marks = new Map<string, TurnMark>()
  private readonly bridge: PermissionBridge
  private seq = 0

  constructor(private readonly opts: SessionManagerOptions) {
    this.bridge = new PermissionBridge(opts.sink, {
      onAllowForSession: (sessionId, label) => {
        const session = this.sessions.get(sessionId)
        if (!session) return
        // 两种粒度都放行：整条 label 只覆盖完全相同的那一次调用，工具名才能覆盖同类调用
        session.permissions.allowForSession(toolNameOf(label))
        session.permissions.allowForSession(label)
      },
    })
  }

  async openSession(cwd: string, opts: { id?: string; snapshot?: SessionSnapshot } = {}): Promise<Session> {
    const entry = await this.acquireProject(cwd)
    const id = opts.id ?? `s${++this.seq}`

    // 克隆而不是共用：`/model`、`/mode` 都直接写 config，共用会让一个会话的切换串到所有会话
    const config = structuredClone(entry.project.config)
    const permissions = new PermissionManager(config.permissions, this.bridge.askerFor(id))
    const view = new IpcView(id, this.sessionSink())
    const agent = new Agent({
      cwd,
      config,
      provider: entry.project.provider,
      view,
      permissions,
      tools: entry.project.assembleTools(),
      skills: entry.project.skills,
      memoryIndex: entry.project.memoryIndex,
    })

    const session: Session = { id, cwd, config, permissions, view, agent, status: 'idle' }
    if (opts.snapshot) agent.restore(opts.snapshot)
    this.sessions.set(id, session)
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  async send(sessionId: string, text: string): Promise<SendResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: '会话不存在' }
    if (session.status !== 'idle') return { ok: false, reason: '上一条消息还在处理中，请等它结束' }

    // 同步置位：下面第一个 await 之前就得挡住第二次调用，否则两条 user 消息会交错入栈
    this.setStatus(session, 'running')
    const controller = new AbortController()
    session.controller = controller
    this.beginTurnMark(session)

    try {
      const outcome = await session.agent.runTurn(text, controller.signal)
      session.view.turnEnd(session.agent.buildTurnSummary(outcome))
      return { ok: true, outcome }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      session.view.error(msg)
      return { ok: false, reason: msg }
    } finally {
      // 记忆是全局的，索引却拼在各会话的提示词里 —— A 写完了得让同项目其它会话跟着重建，
      // 否则它们继续按旧索引做决策。代价是打断那几路的提示词前缀缓存，但只发生在真写了记忆时
      const mark = this.marks.get(sessionId)
      if (mark?.dirty) this.broadcastPromptRefresh(session.cwd, sessionId)
      this.marks.delete(sessionId)
      session.controller = undefined
      // 放在 finally 里：abort / 出错的那一轮也是用户的对话，丢掉比留着更让人恼火
      this.persist(session)
      this.setStatus(session, 'idle')
    }
  }

  /**
   * 落盘。桌面端不落盘的话，关掉窗口这一轮就没了，侧边栏的「历史会话」也永远是空的。
   * 只有当轮真的说过话时才写（`persistSession` 内部按 messages 长度挡了一道）。
   */
  private persist(session: Session): void {
    persistSession({
      cwd: session.cwd,
      sessionId: session.id,
      model: session.config.provider.model,
      snapshot: session.agent.snapshot(),
    })
  }

  /**
   * 中断当前轮次。
   * **必须先结清待决授权**：`PermissionManager` 的 `ask` 不监听 signal，只 abort 的话
   * `runTurn` 会一直停在那一句 await 上，表现是「点了停止但没反应」。
   */
  abort(sessionId: string): void {
    this.bridge.denyAll(sessionId)
    this.sessions.get(sessionId)?.controller?.abort()
  }

  /**
   * renderer 点了授权按钮。陈旧的 `requestId` 会被桥丢掉 —— 用户点「允许」和点「停止」
   * 抢同一个会话时，晚到的回复不能去放行下一轮那次同名的调用。
   */
  replyPermission(sessionId: string, requestId: number, decision: PermissionDecision): void {
    this.bridge.reply(sessionId, requestId, decision)
  }

  hasPendingPermission(sessionId: string): boolean {
    return this.bridge.hasPending(sessionId)
  }

  /**
   * 开关某个 MCP 服务器，并**广播给同项目的每个会话**。
   * 只重算当前会话的话，同项目其它会话的 agent 仍持有旧工具列表 —— 用户以为关了其实没关。
   *
   * **必须 await 并把异常放出去**：`McpManager.setEnabled` 在连不上时会抛，早先这里把
   * 返回的 Promise 丢了，于是「接入一个配错了的服务器」既不报错、工具也没接上，界面还显示
   * 成功。工具集只在真成功之后才重算，否则会把一份没变的列表当成新的发下去。
   */
  async setMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
    const entry = this.projects.get(cwd)
    if (!entry) return
    await entry.project.mcp.setEnabled(name, enabled)
    for (const session of this.sessions.values()) {
      if (session.cwd === cwd) session.agent.setTools(entry.project.assembleTools())
    }
  }

  /** 设置页的快照。会话或项目已经没了就返回 null，由 channel 层翻成 `{ok:false}` */
  projectInfo(sessionId: string): ProjectInfo | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const entry = this.projects.get(session.cwd)
    if (!entry) return null

    const { project } = entry
    const cfg = project.config
    return {
      cwd: project.cwd,
      configFile: configPath(project.cwd),
      provider: {
        baseUrl: cfg.provider.baseUrl,
        vendorKey: vendorByBaseUrl(cfg.provider.baseUrl)?.key ?? CUSTOM_VENDOR,
        apiKeyHint: maskKey(cfg.provider.apiKey),
        model: cfg.provider.model,
        temperature: cfg.provider.temperature,
        maxTokens: cfg.provider.maxTokens,
      },
      vendors: VENDORS,
      context: {
        window: cfg.contextWindow,
        autoCompact: cfg.autoCompact,
        compactThreshold: cfg.compactThreshold,
        maxSteps: cfg.maxSteps,
      },
      // 这里是**项目模板**里的权限配置，不是某个会话当前的模式 —— 后者在中栏顶栏上
      permissions: {
        mode: cfg.permissions.mode,
        allow: [...cfg.permissions.allow],
        deny: [...cfg.permissions.deny],
      },
      skills: project.skills?.list() ?? [],
      mcp: project.mcp.status(),
      mcpCost: mcpCostNotice(project.mcp, cfg.contextWindow),
    }
  }

  /**
   * 改「默认模型」：写回项目配置文件，**并同步内存里那份 `project.config`**。
   *
   * 少了后一半就是「改了没生效」：`openSession` 走的是 `structuredClone(project.config)`，
   * 而它在 `createProjectRuntime` 那一刻就加载完了。项目已经开着时，用户新建的会话仍会拿到
   * 旧模型 —— 从界面上看和「没改」一模一样。
   */
  setDefaultModel(cwd: string, model: string): string {
    const file = writeProjectModel(cwd, model)
    const entry = this.projects.get(cwd)
    if (entry) entry.project.config.provider.model = model
    return file
  }

  /**
   * 改「接口地址」：写回项目配置文件，**并同步内存里那份 `project.config`**。
   *
   * 不双写就是「改了没生效」：provider 是在 `createProjectRuntime` 那一刻用
   * `config.provider` 建的，已经开着的项目仍拿旧地址发请求（见 `provider/openai.ts`
   * 的 `syncClient` —— 它盯的就是这份内存里的对象）。
   */
  setDefaultBaseUrl(cwd: string, rawBaseUrl: string): string {
    // **这里也必须归一化**，不能只在 `loadConfig` 里做：内存里这一个对象是 provider
    // 现读的那份（`syncClient`），漏掉的话刚改完的地址要等重启才生效 —— 表现是
    // 「存为」点了没反应
    const baseUrl = normalizeBaseUrl(rawBaseUrl)
    const file = writeProjectProvider(cwd, { baseUrl })
    const entry = this.projects.get(cwd)
    if (entry) entry.project.config.provider.baseUrl = baseUrl
    return file
  }

  /**
   * 切厂商：**地址与模型一起原子写盘**，并把本项目所有活着的会话的模型刷成预置默认值。
   *
   * 两件事必须一起做，否则换来的只会是一个费解的 404：
   * - 切到 DeepSeek 却留着 `gpt-4o-mini` → 模型名在新端点不存在；
   * - 端点立刻生效（桌面端选的就是这条），而会话的 `model` 是 `openSession` 时
   *   `structuredClone` 出来的旧值 → 当前会话下一条消息就必 404。
   *
   * 语义是**自洽**的，不是两种作用范围打架：厂商定义「这个项目跟谁说话」（传输层，
   * 项目级，立刻生效）；默认模型定义「新会话用哪个脑子」（会话级默认）。
   */
  setVendor(cwd: string, preset: VendorPreset): string {
    const model = preset.models[0]
    const file = writeProjectProvider(cwd, { baseUrl: preset.baseUrl, model })

    const entry = this.projects.get(cwd)
    if (entry) {
      entry.project.config.provider.baseUrl = preset.baseUrl
      if (model) entry.project.config.provider.model = model
    }
    for (const session of this.sessions.values()) {
      if (session.cwd !== cwd) continue
      if (model) session.config.provider.model = model
      // 系统提示词里写着当前模型名，不重建的话会话会自报旧模型
      session.agent.refreshSystemPrompt()
    }
    return file
  }

  setModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.config.provider.model = model
    // 系统提示词里写着当前模型名，不重建的话会话会自报旧模型
    session.agent.refreshSystemPrompt()
  }

  setMode(sessionId: string, mode: PermissionMode): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // permissions 持有的就是本会话克隆出来的那个 config.permissions，两处一起变
    session.permissions.setMode(mode)
    session.agent.refreshSystemPrompt()
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // 顺序不能反：待决的授权 Promise 不结清，runTurn 就永远不返回，abort 也救不回来
    this.bridge.denyAll(sessionId)
    session.controller?.abort()
    this.sessions.delete(sessionId)
    this.marks.delete(sessionId)
    await this.releaseProject(session.cwd)
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id)
  }

  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return
    session.status = status
    this.opts.sink.send(session.id, { type: 'session-status', status })
  }

  /**
   * 包一层 sink 是为了盯住 `tool-start`：哪些工具会作废提示词由工具自己声明
   * （`Tool.invalidatesPrompt`），不在这里判断具体工具名 —— 同 CLAUDA.md 的约束。
   */
  private sessionSink(): EventSink {
    return {
      send: (sid, event) => {
        if (event.type === 'tool-start') {
          const mark = this.marks.get(sid)
          if (mark?.invalidating.has(event.name)) mark.dirty = true
        }
        this.opts.sink.send(sid, event)
      },
    }
  }

  /** 每轮开始时现算一次：MCP 开关会改变工具集，缓存下来会漏掉新接入的工具 */
  private beginTurnMark(session: Session): void {
    const entry = this.projects.get(session.cwd)
    const tools = entry ? entry.project.assembleTools() : []
    const invalidating = new Set(tools.filter((t) => t.invalidatesPrompt).map((t) => t.name))
    this.marks.set(session.id, { invalidating, dirty: false })
  }

  private broadcastPromptRefresh(cwd: string, exceptSessionId: string): void {
    for (const other of this.sessions.values()) {
      // 跑这一轮的那个会话，Agent 自己已经重建过了，再来一次只会白白断一次前缀缓存
      if (other.cwd !== cwd || other.id === exceptSessionId) continue
      other.agent.refreshSystemPrompt()
    }
  }

  private async acquireProject(cwd: string): Promise<ProjectEntry> {
    const existing = this.projects.get(cwd)
    if (existing) {
      existing.refs++
      return existing
    }
    const project = await this.opts.openProject(cwd)
    const entry: ProjectEntry = { project, refs: 1 }
    this.projects.set(cwd, entry)
    return entry
  }

  private async releaseProject(cwd: string): Promise<void> {
    const entry = this.projects.get(cwd)
    if (!entry) return
    entry.refs--
    if (entry.refs > 0) return
    this.projects.delete(cwd)
    await entry.project.dispose()
  }
}

/** 密钥只回末尾四位。空串原样返回，好让 UI 分得清「没配」和「配了」 */
function maskKey(key: string): string {
  return key ? `····${key.slice(-4)}` : ''
}
