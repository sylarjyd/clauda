import { Agent, type AgentOptions, type SessionSnapshot, type TurnOutcome } from '../agent/agent.js'
import {
  completeProfile,
  configPath,
  normalizeBaseUrl,
  removeProjectProfile,
  writeActiveProfile,
  writeProjectProfile,
  writeProjectProvider,
  type ClaudaConfig,
  type PermissionMode,
  type ProjectProviderPatch,
  type ProviderConfig,
  type ProviderProfile,
} from '../config.js'
import { VENDORS, vendorByBaseUrl, type VendorPreset } from '../provider/vendors.js'
import type { McpServerStatus } from '../mcp/manager.js'
import { PermissionManager } from '../permissions.js'
import { OpenAICompatibleProvider } from '../provider/openai.js'
import type { Provider } from '../provider/types.js'
import type { SkillMeta } from '../skills/types.js'
import type { Tool } from '../tools/types.js'
import type { UserAttachment } from '../types.js'
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
   *
   * 这里刻意**不放 provider**：早先放了一个共享实例，于是改接口地址会立刻钻到所有活会话
   * 里去。provider 现在归会话自己（`openSession` 里建），项目这份只当模板。
   */
  readonly config: ClaudaConfig
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
 * 一份厂商档案在界面上的样子。设置页左栏按它画列表，右栏按它填参数。
 *
 * 和 `ProjectInfo.provider` 的关系：那个是「**当前生效**的那一份」的解析视图（会话与
 * 顶栏在用），这个是**每一份各自**的视图 —— 两者都是 `config.profiles` 的投影。
 */
export interface ProfileInfo {
  /** 档案名，写进 config.json 的就是它；界面上的操作一律按它定位 */
  key: string
  /**
   * 显示用的名字。认得出厂商就用厂商的 label（「DeepSeek」「豆包（火山方舟）」），
   * 认不出就用 key —— 名字**由 baseUrl 反推**，不是存下来的（见 `provider/vendors.ts`）。
   */
  label: string
  vendorKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  /** 同 `provider.apiKeyHint`：每个档案各遮各的，密钥本身不出主进程 */
  apiKeyHint: string
  isActive: boolean
}

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
  /**
   * 全部厂商档案，**同时保存了好几份**。`provider` 是其中 `isActive` 那一份的视图，
   * 这里连别的几份一起给，设置页才能「左选厂商、右配参数」。
   */
  profiles: ProfileInfo[]
  /** 当前用的是哪一份（`profiles` 里的某个 `key`）。**切换 ≠ 选中**，见类注释 */
  activeProvider: string
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
  /**
   * 建 provider 的工厂，参数是那个会话克隆出来的 `config.provider`。默认就是真的
   * `OpenAICompatibleProvider`；留这个口子是因为 `tests/unit.mjs` 不许碰 socket，
   * 得能塞一个假的进去（e2e 才用真进程 + 真 loopback）。
   */
  createProvider?(config: ProviderConfig): Provider
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
 * - **provider 也按会话建**：它是「这个会话跟谁说话」，和 config 一起在创建那一刻定下来。
 *   项目级共享一个实例的话，设置页改接口地址会直接钻到所有活会话里
 * - **授权 Promise 必须能结清**：`PermissionManager` 的 `ask` 不监听 signal，
 *   所以每条取消路径都要先 `denyAll`
 *
 * 由此得到一条贯穿设置页的规则：**改配置只对之后新建的会话生效**。「接口地址」「厂商」
 * 「默认模型」三个入口都是这个语义，项目配置在这里只当模板。
 *
 * 多厂商把「改哪一份」和「用哪一份」分成了两件事：**选中**（界面上左栏点谁）只决定
 * 编辑哪一份档案，**当前使用**（`activeProvider`）才决定新会话跟谁说话。两者混成一件
 * 的话，「同时配置多个厂商」就不成立了 —— 配 B 之前得先把 B 变成正在用的。
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly projects = new Map<string, ProjectEntry>()
  private readonly marks = new Map<string, TurnMark>()
  private readonly bridge: PermissionBridge
  /** 见 `SessionManagerOptions.createProvider` */
  private readonly createProvider: (config: ProviderConfig) => Provider
  private seq = 0

  constructor(private readonly opts: SessionManagerOptions) {
    this.createProvider = opts.createProvider ?? ((config) => new OpenAICompatibleProvider(config))
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
      // provider 也归会话自己，而且**必须**跟着上面那份克隆走：`Agent.opts.provider` 构造后
      // 不可变，于是端点与密钥在会话诞生的这一刻就冻住了 —— 之后项目改地址、换厂商，活着的
      // 会话照旧打原来的地方，只有新会话拿新值。「配置只对新会话生效」就是这么实现的。
      provider: this.createProvider(config.provider),
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

  async send(sessionId: string, text: string, attachments: UserAttachment[] = []): Promise<SendResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: '会话不存在' }
    if (session.status !== 'idle') return { ok: false, reason: '上一条消息还在处理中，请等它结束' }

    // 同步置位：下面第一个 await 之前就得挡住第二次调用，否则两条 user 消息会交错入栈
    this.setStatus(session, 'running')
    const controller = new AbortController()
    session.controller = controller
    this.beginTurnMark(session)

    try {
      const outcome = await session.agent.runTurn(text, controller.signal, attachments)
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
      profiles: Object.entries(cfg.profiles).map(([key, profile]) =>
        profileInfoOf(key, profile, cfg.activeProvider),
      ),
      activeProvider: cfg.activeProvider,
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
   * 改**某一份档案**的「接口地址 / 默认模型」：写回项目配置文件，并同步内存里那份模板。
   * 只影响之后新建的会话（已经在跑的会话端点冻在创建那一刻，见 `openSession`）。
   *
   * `profileKey` 是设置页左栏**选中的**那一份，不填则落到当前使用的那份上。
   *
   * 内存那份模板**必须**双写：它是新会话唯一的来源，而它在 `createProjectRuntime` 那一刻
   * 就加载完了 —— 漏了这一步就成了「改了没生效」。
   */
  setProfileField(cwd: string, patch: ProjectProviderPatch, profileKey?: string): string {
    const key = this.profileKeyOf(cwd, profileKey)
    // **地址在这里也必须归一化**，不能只在 `loadConfig` 里做：内存里这份模板是新会话唯一的
    // 来源，留着未归一的原文，新建的会话拿到的地址就和重启后的不一致 —— 表现是「存为」点了，
    // 重启前后行为不一样
    const normalized: ProjectProviderPatch = { ...patch }
    if (normalized.baseUrl !== undefined) normalized.baseUrl = normalizeBaseUrl(normalized.baseUrl)

    const file = writeProjectProvider(cwd, normalized, key)
    this.patchTemplate(cwd, key, normalized)
    return file
  }

  /**
   * 新增一份厂商档案。地址与模型从**预置表**取（自定义那份留空由用户手填），
   * 于是和从前一样不存在「写一个界面没提供过的地址」这条路径。
   *
   * **绝不顺手把它切成当前使用的那一份** —— 那正是「同时配置多个厂商」不成立的开始
   * （配 B 之前得先把 B 变成正在用的）。真要换是 `setActiveProfile` 的事。
   *
   * key 由这里定而不是界面给：它要判「已经有哪些档案」，那是主进程才知道的事。
   * 预置厂商用厂商 key，自定义的用 `custom` / `custom-2`…—— 名字只是给人看的，
   * **认厂商靠 baseUrl 反推**（`vendorByBaseUrl`），所以不需要用户输入名字。
   */
  addProfile(cwd: string, preset: VendorPreset | null): { file: string; key: string } {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，加不了厂商档案')
    const cfg = entry.project.config

    const key = preset ? preset.key : freeKey(cfg.profiles, 'custom')
    if (cfg.profiles[key]) throw new Error(`已经有一份叫「${key}」的档案了`)

    const profile: Partial<ProviderProfile> = preset
      ? { baseUrl: preset.baseUrl, model: preset.models[0] }
      : // 自定义那份**故意不填地址**：填个内置默认地址就成了「静默指向 OpenAI」。
        // 空地址的档案切不过去（见 `setActiveProfile`），也就不会跑到一个没人配过的地方去
        { baseUrl: '', apiKey: '', model: '' }

    const file = writeProjectProfile(cwd, key, profile, cfg.activeProvider)
    // 补成完整的再放进模板：`projectInfo` 拿到就能画，不用再猜哪个字段可能是 undefined
    cfg.profiles[key] = completeProfile(profile)
    return { file, key }
  }

  /**
   * 把某一份档案切成「当前使用」。写盘 + 同步模板，只影响之后新建的会话。
   *
   * 参数不合法就**抛**：调用方是 IPC 通道，外层那个 catch 会把消息翻成 `{ok:false, reason}`，
   * 用户看到的就是一句人话。
   */
  setActiveProfile(cwd: string, key: string): string {
    const entry = this.projects.get(cwd)
    const profile = entry?.project.config.profiles[key]
    if (!entry || !profile) throw new Error(`没有这个厂商档案：${key}`)
    // 缺地址或模型时切过去，换来的只是一串连不上的报错 / 400。挡住，并说清缺什么
    const missing: string[] = []
    if (!profile.baseUrl) missing.push('接口地址')
    if (!profile.model) missing.push('默认模型')
    if (missing.length > 0) throw new Error(`这份档案还缺${missing.join('和')}，填好了才能设为当前使用`)

    const file = writeActiveProfile(cwd, key)
    entry.project.config.activeProvider = key
    this.syncTemplate(cwd)
    return file
  }

  /**
   * 删掉一份档案。**当前使用的那份不许删**：删了 `activeProvider` 就指向一个不存在的名字，
   * 配置会静默退回内置默认值（OpenAI + gpt-4o-mini）—— 那是个「配置里写着 DeepSeek，
   * 跑起来打的是 OpenAI」的坑，`config.ts` 把「调用方先确认」写进了契约，这里是那个调用方。
   */
  removeProfile(cwd: string, key: string): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，删不了厂商档案')
    const cfg = entry.project.config
    if (!cfg.profiles[key]) throw new Error(`没有这个厂商档案：${key}`)
    if (key === cfg.activeProvider) throw new Error('这是当前使用的厂商，先切到别家再删')

    const file = removeProjectProfile(cwd, key)
    delete cfg.profiles[key]
    return file
  }

  /**
   * 往哪个档案上写：界面给的那个（左栏选中的）> 当前使用的那份。
   *
   * 不写成「只认当前那份」是因为多厂商下这两者**经常不是一回事** —— 用户在左栏选了
   * DeepSeek 改地址，改的必须是 DeepSeek 那份，而不是此刻正在用的 Kimi。
   */
  private profileKeyOf(cwd: string, profileKey?: string): string {
    return profileKey || this.projects.get(cwd)?.project.config.activeProvider || ''
  }

  /**
   * 改完盘上的档案之后，把内存里那份**模板配置**补成一样的 —— 它是新会话唯一的来源
   * （`openSession` 走 `structuredClone`），漏一步就表现成「改了没生效」。
   *
   * 这里**不重新 `loadConfig`**：那条路会跑 dotenv，而 dotenv 改的是全局 `process.env`
   * 且不覆盖已存在的键 —— `project.ts` 把 `loadConfig` 包在 env 快照里正是为了挡它
   * （同时开着 A、B 两个项目时，先加载的那个会把键留在环境里，后加载的静默继承）。
   * 在这里重跑一遍等于把那个坑重新挖开。
   */
  private patchTemplate(cwd: string, key: string, patch: Partial<ProviderProfile>): void {
    const entry = this.projects.get(cwd)
    if (!entry) return
    const cfg = entry.project.config
    cfg.profiles[key] = completeProfile({ ...cfg.profiles[key], ...patch })
    this.syncTemplate(cwd)
  }

  /**
   * 把当前档案的字段刷进 `cfg.provider`。规则与 `loadConfig` 的 `resolveProfiles` 同源：
   * **端点类字段一概以当前档案为准**，`provider` 段只剩传输旋钮（`timeoutMs` 那些）。
   *
   * 一份同步实现，省得每个改动点各写一遍「顺便把 provider 也改了」—— 漏一处的症状是
   * 「切过去了，但新会话打的是旧地址」。
   */
  private syncTemplate(cwd: string): void {
    const entry = this.projects.get(cwd)
    if (!entry) return
    const cfg = entry.project.config
    const active = cfg.profiles[cfg.activeProvider]
    // 只覆盖档案那五个字段：`Object.assign` 进来的是完整的 `ProviderProfile`
    if (active) Object.assign(cfg.provider, active)
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

function profileInfoOf(key: string, profile: ProviderProfile, activeKey: string): ProfileInfo {
  const preset = vendorByBaseUrl(profile.baseUrl)
  return {
    key,
    // 厂商名由 baseUrl 反推，反推不到才用档案名 —— 界面不自己判（见 `vendors.ts` 的注释）
    label: preset?.label ?? key,
    vendorKey: preset?.key ?? CUSTOM_VENDOR,
    baseUrl: profile.baseUrl,
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    apiKeyHint: maskKey(profile.apiKey),
    isActive: key === activeKey,
  }
}

/**
 * 挑一个没被占用的档案名：先试 `custom`，被占了就 `custom-2`、`custom-3`…
 *
 * 为什么不让用户起名字：名字对**认厂商**毫无作用（那边靠 baseUrl 反推），多一个输入框
 * 只会多一种「填了个不存在的名字然后找不到自己那家」的状态。
 */
function freeKey(existing: Record<string, unknown>, base: string): string {
  if (!existing[base]) return base
  for (let i = 2; ; i++) {
    const key = `${base}-${i}`
    if (!existing[key]) return key
  }
}
