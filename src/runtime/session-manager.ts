import path from 'node:path'
import { Agent, type AgentOptions, type SessionSnapshot, type TurnOutcome } from '../agent/agent.js'
import { agentProfileProblem, applyAgentToConfig, scopedSkills, toSpec } from '../agents/apply.js'
import type { AgentInfo, AgentMeta, AgentSpec, HasSkills, HasTools, ResolvedAgent } from '../agents/types.js'
import { removeAgent as removeAgentDir, writeAgent, type WriteAgentInput } from '../agents/writer.js'
import {
  claudaHome,
  completeProfile,
  configPath,
  normalizeBaseUrl,
  removeMcpServerAnywhere,
  removeProjectProfile,
  setMcpServerToolsAnywhere,
  writeActiveProfile,
  writeDefaultAgent,
  writeMcpServer,
  writeProjectProfile,
  writeProjectProvider,
  writeSkillDisabled,
  type ClaudaConfig,
  type McpServerConfig,
  type PermissionMode,
  type ProjectProviderPatch,
  type ProviderConfig,
  type ProviderProfile,
} from '../config.js'
import { VENDORS, vendorByBaseUrl, type VendorPreset } from '../provider/vendors.js'
import type { McpServerStatus, McpToolInfo } from '../mcp/manager.js'
import { PermissionManager } from '../permissions.js'
import { OpenAICompatibleProvider } from '../provider/openai.js'
import type { Provider } from '../provider/types.js'
import type { SkillAdmin, SkillMeta, SkillSource } from '../skills/types.js'
import { removeSkill, writeSkill, type SkillScope } from '../skills/writer.js'
import type { Tool } from '../tools/types.js'
import type { UserAttachment } from '../types.js'
import { IpcView, type ViewEvent } from './ipc-view.js'
import { mcpCostNotice, type McpCostNotice } from './mcp-cost.js'
import { skillCostNotice, type SkillCostNotice } from './skill-cost.js'
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
 * 一个项目的运行时。**按 cwd 缓存、按会话引用计数**（外加界面选的那个项目把它钉住），
 * 因为 `McpManager` 会起子进程，而且它的 `closeAll()` 不可逆（关掉就不能再开）。
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
   *
   * 另外两个方法是增删技能要用的（都在 `SkillRegistry` 上）：`refresh()` 让它原地重扫
   * ——注册表原先是打开项目那一刻的一次性快照—— `get()` 用来按名字查到那个 `SKILL.md` 的
   * 精确路径。不写死成 `SkillRegistry` 是为了让这个接口继续只依赖「能干什么」。
   *
   * `has()` / `read()` 进来是因为**按智能体白名单收窄出来的技能视图**也走这个接口
   * （`scopedSkills` 收 `SkillSource`，返回的视图也要能塞回 `AgentOptions.skills`）——
   * 提示词里的「可用技能」索引必须和工具集合看到的是同一份名单。
   */
  readonly skills?: SkillSource & SkillAdmin & { refresh(): void }
  /**
   * 智能体注册表。可选，和 `skills` 同一个理由：这个接口只承诺「项目里有哪些智能体」，
   * 而没有智能体的调用方（测试里那些假的 project）不必为此造一个。
   *
   * `resolve()` 才是建会话要的那一份（带正文），`list()` 只给元数据 —— 桌面端的智能体页
   * 要显示 `file` / `scope`，所以这里不收窄成 `AgentOptions['agent']`。
   */
  readonly agents?: {
    list(): AgentMeta[]
    get(name: string): AgentMeta | undefined
    resolve(name: string): ResolvedAgent | null
    refresh(): void
  }
  readonly memoryIndex?: AgentOptions['memoryIndex']
  /**
   * 每次现算，跟着 MCP 开关和智能体白名单走。
   *
   * **收智能体参数是「按会话过滤」的落点**：同项目两个会话可以绑不同智能体，
   * 所以调用方（`openSession` / `refreshProjectTools` / `beginTurnMark`）必须逐个会话地传。
   */
  assembleTools(agent?: HasTools & HasSkills): Tool[]
  readonly mcp: {
    /** 可能抛：连接失败的服务器在这里报错，别把返回值丢掉（见 `setMcpEnabled`） */
    setEnabled(name: string, enabled: boolean): Promise<void>
    /**
     * 运行期加一个服务器并把配置交给调用方落盘（顺序在调用方那边，见 `addMcpServer`）。
     * **可能抛**：连不上时抛，别吞 —— 吞掉的后果是「界面说加上了，工具一个没多」。
     */
    addServer(name: string, cfg: McpServerConfig): Promise<void>
    /** 运行期摘掉一个服务器。名字不存在时抛 */
    removeServer(name: string): Promise<void>
    /**
     * 改一台服务器的工具白名单，只动运行期这一份（落盘由 `setMcpTools` 负责）。
     * `undefined` = 不设白名单（全接），空数组 = 一个都不接。
     */
    setTools(name: string, tools: string[] | undefined): void
    /** 一台服务器上报的全部工具，设置页展开那一行时才取 */
    toolCatalog(name: string): McpToolInfo[]
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
  /**
   * 智能体一览。**不带正文** —— `project/info` 被每轮刷新的徽标拖着走，正文该走 `agent/get`。
   * 也**不带任何端点或密钥**：`AgentInfo` 只装 `AGENT.md` frontmatter 里写的东西 + 路径 +
   * `isDefault`，`profile` 只出名字。
   */
  agents: AgentInfo[]
  /** 本项目默认绑哪个智能体（决策 2 的「设置页里能标一个本项目默认」），'' = 没设 */
  defaultAgent: string
  mcp: McpServerStatus[]
  /**
   * MCP 开销提示。**措辞由 `mcpCostNotice` 统一出**，桌面端只负责摆位置 ——
   * 两端各写一套的话，改了阈值或口径没人会想起来去对齐另一边。
   */
  mcpCost: McpCostNotice
  /**
   * 技能索引的开销提示。和 `mcpCost` 一样**措辞由 `skillCostNotice` 统一出**，
   * 桌面端只负责摆位置。技能页列着上百行却看不出它们正在花钱，这个数字就是给那个看的。
   */
  skillCost: SkillCostNotice
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
  /**
   * 这条会话绑的智能体名，**空串表示没有**。
   *
   * 名字被 `agent`（`Agent` 实例）占了，所以这里只能叫 `agentName`。别想着把两者合一：
   * `persist()` 正是靠 `session.agent.snapshot()` 拿消息的。
   */
  agentName: string
  /**
   * 建会话那一刻解析好的智能体，**冻结**。工具 / 技能白名单、权限覆盖、模型覆盖全按它算。
   *
   * 不按名字回头重读 `AGENT.md`：改了智能体只该影响之后新开的会话（和「模型 / 端点只对
   * 新会话生效」同一条理由）。冻结还顺手买到「删掉智能体之后老会话照样原样打开」。
   */
  agentSpec?: AgentSpec
  /** 给了名字却解析不出来时的那个名字，空串 = 没事。界面据此弹一条通知 */
  agentMissing: string
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
 * 决定这条会话绑哪个智能体。**只有三条路**，没有第四条：
 * - (a) **恢复**：`agentSpec` 这个键出现过（哪怕给的是 `null`）它就是权威，
 *   **绝不看 `config.defaultAgent`**
 * - (b) **新会话且名字非空**：拿名字去注册表解析
 * - (c) 其余（没给名字 / 名字为空串）：没有智能体
 *
 * (a) 那条判据必须是 `'agentSpec' in opts` 而不是「值非 null」：一条从没绑过智能体的旧会话
 * 恢复时传的正是 `agentSpec: null`，把它当成「没给」的话，那条会话会在用户什么都没点的
 * 情况下悄悄套上当下的项目默认 —— 行为静默改变，最难查的一类。
 *
 * 名字找不到时**不抛**：一个删掉的智能体不该让自动恢复的会话打不开。返回 `missing` 让界面
 * 出一条通知，而不是把用户扔在一个打不开的会话前面。
 */
function pickAgent(
  project: SessionProject,
  opts: { agent?: string; agentSpec?: AgentSpec | null },
): { spec: AgentSpec | null; missing: string } {
  if ('agentSpec' in opts) return { spec: opts.agentSpec ?? null, missing: '' }
  const name = opts.agent ?? ''
  if (!name) return { spec: null, missing: '' }
  const resolved = project.agents?.resolve(name)
  if (!resolved) return { spec: null, missing: name }
  return { spec: toSpec(resolved), missing: '' }
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
 * 项目运行时的生命周期**不跟会话走**：会话开关只加减引用计数，界面选中的那个项目另外
 * 把它钉住（`ensureProject`）。技能与 MCP 挂在这份运行时上，所以「一个会话都没开」
 * 也得能拿到它 —— 否则设置页在那一刻只能显示空态。
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
  /**
   * 正在建的项目运行时。**`openProject` 是异步的**，并发两条 `project/info` 会双双
   * 看到「还没有」而各建一份 —— 多出来的那份带着没人关的 MCP 子进程。
   */
  private readonly opening = new Map<string, Promise<ProjectEntry>>()
  /**
   * 界面当前选中的项目目录。它把这份运行时**钉住**：没有会话引用也不销毁。
   * 见 `ensureProject` / `dropProject`。
   */
  private pinnedCwd: string | null = null
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

  async openSession(
    cwd: string,
    opts: { id?: string; snapshot?: SessionSnapshot; agent?: string; agentSpec?: AgentSpec | null } = {},
  ): Promise<Session> {
    const entry = await this.acquireProject(cwd)
    const id = opts.id ?? `s${++this.seq}`
    const { spec, missing } = pickAgent(entry.project, opts)

    // 克隆而不是共用：`/model`、`/mode` 都直接写 config，共用会让一个会话的切换串到所有会话
    const config = structuredClone(entry.project.config)
    // **这一句必须夹在克隆与建 provider 之间。** provider 构造后不可变（见下），晚一步就会出现
    // 「提示词说用 A、请求打到 B」—— 提示词是按新 config 生成的，两边各说各话，而且**不报错**。
    // 改这里之前先读 `apply.ts` 的 `applyAgentToConfig` 注释：逐键各管各（写了就盖，没写就沿用）。
    if (spec) applyAgentToConfig(config, spec)
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
      tools: entry.project.assembleTools(spec ?? undefined),
      // 该智能体的**技能视图**（不是项目那份注册表）：提示词里的「可用技能」索引和 `skill`
      // 工具能载入的范围必须在同一个白名单里，否则会出现「索引里写着、却载不进来」。
      skills: entry.project.skills
        ? scopedSkills(entry.project.skills, spec ?? undefined)
        : undefined,
      memoryIndex: entry.project.memoryIndex,
      agent: spec ? { name: spec.name, prompt: spec.prompt } : undefined,
      // 对话里新建技能 / MCP 服务器之后，工具集合要当场重算（`Tool.invalidatesTools`）。
      // 这里一律连提示词一起重建：技能和 MCP 的四个工具声明的是同一个标志，回调里分不出
      // 刚跑的到底是哪一个（`memory_write` 那种只动提示词的另有 `invalidatesPrompt`）。多
      // 重建一次的代价是打断一次前缀缓存，漏掉一次的代价是提示词里的技能索引永远是旧的。
      onToolsChanged: () => this.refreshProjectTools(cwd, true),
    })

    const session: Session = {
      id,
      cwd,
      config,
      permissions,
      view,
      agent,
      status: 'idle',
      agentName: spec?.name ?? '',
      agentSpec: spec ?? undefined,
      agentMissing: missing,
    }
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
      // 冻结的那份配方随会话落盘，下次恢复原样用回来（不是按名字重查 —— 见 `Session.agentSpec`）
      agent: session.agentSpec,
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
    // 提示词不用重建：开关换的只是发给后端的 tools 数组，「## 可用技能」那段没动
    this.refreshProjectTools(cwd, false)
  }

  /**
   * 工具集合变了：把新的一份发给**同项目**的每个会话。
   *
   * 按 cwd 广播而不是只发给调用方那个会话 —— 技能与 MCP 都挂在**项目**运行时上，同项目的
   * 其它会话手里是同一批工具的旧快照。只重算当前会话的话，用户以为加好了，切到旁边那个
   * 会话里却没有。
   *
   * `promptToo` 控制要不要连系统提示词一起重建。**并非所有工具集变化都影响提示词**：
   * 「## 可用技能」只跟技能注册表有关，而 MCP 增删换的是 tools 数组 —— 那种时候重建一次
   * 是白白打断那几路的提示词前缀缓存。所以这**不是一个可以随手省掉的优化**，是两个真的
   * 不同的影响面，调用点必须各自说清自己是哪一种。
   */
  private refreshProjectTools(cwd: string, promptToo: boolean): void {
    const entry = this.projects.get(cwd)
    if (!entry) return
    for (const session of this.sessions.values()) {
      if (session.cwd !== cwd) continue
      // **每个会话各算各的**：同项目两个会话可以绑不同的智能体，外面算一份发下来会让
      // 「一个关了 bash、另一个还能跑」—— 白名单就形同虚设了。
      session.agent.setTools(entry.project.assembleTools(session.agentSpec))
      if (promptToo) session.agent.refreshSystemPrompt()
    }
  }

  /**
   * 设置页的快照。**按 cwd 取，不按会话** —— 里面每一项都是项目级的（技能、MCP、
   * 上下文、厂商档案），没有一个字段来自某个会话。
   *
   * 项目还没建运行时（或已经销毁）就返回 null，由 channel 层翻成 `{ok:false}`。
   */
  projectInfo(cwd: string): ProjectInfo | null {
    const entry = this.projects.get(cwd)
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
      // `listAll()` 而不是 `list()`：设置页要画出**被关掉的那些**，否则开关一关这一行就没了，
      // 再也点不回来。喂给模型的那几处走的是 `list()`（注册表里已经滤过），这里只多不少
      skills: project.skills?.listAll() ?? [],
      // 元数据只有一份（`list()` 的产物，**不重读文件、不带正文**）。要正文走 `agent/get`。
      // 用展开而不是逐个字段抄：`AgentMeta` 全是可序列化的标量与数组、没有密钥，
      // 而逐个抄会在有人给 `AgentMeta` 加字段时**静默漏掉**（`ProjectInfo` 却看不出来）
      agents: (project.agents?.list() ?? []).map((a) => ({
        ...a,
        isDefault: a.name === cfg.defaultAgent,
        // 「档案找不到，用的是项目当前那份」这类降级提示要在界面上标出来，
        // 只写进日志等于让用户自己发现自己配错了
        problem: agentProfileProblem(a, cfg.profiles),
      })),
      defaultAgent: cfg.defaultAgent,
      mcp: project.mcp.status(),
      mcpCost: mcpCostNotice(project.mcp, cfg.contextWindow),
      // 同 `mcpCost`：措辞由 `skillCostNotice` 统一出，桌面端只负责摆位置
      skillCost: skillCostNotice(project.skills, cfg.contextWindow),
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

  // ------------------------------------------------- 技能与 MCP 的增删（设置页 + 对话）

  /**
   * 新建一个技能：写盘 → 重扫注册表 → 广播新工具集。
   *
   * **顺序不能换。** 广播那一步重算的是 `assemble()`，它读 `skills.list()` —— 先广播再重扫
   * 的话，算出来的还是旧名单：零技能时连 `skill` 工具都不在集合里，用户看到的正是
   * 「技能页里有了，可它说没有这个技能」。
   *
   * 参数不合法（名字不合规）由 `writeSkill` 抛，这里不吞 —— 通道那层会翻成人话。
   */
  addSkill(cwd: string, input: { scope: SkillScope; name: string; description: string; body: string }): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，加不了技能')
    const result = writeSkill({ ...input, cwd })
    entry.project.skills?.refresh()
    // 技能会让「## 可用技能」和工具集合**同时**变，所以是 true
    this.refreshProjectTools(cwd, true)
    return result.file
  }

  /**
   * 删掉一个技能。入参是**名字**，路径从注册表里查 —— 界面和对话两边都只拿到名字，
   * 让它们各自拼路径迟早会拼出一个不存在的目录。
   */
  removeSkill(cwd: string, name: string): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，删不了技能')
    // `find()` 而不是 `get()`：**关掉的技能也得删得掉**。`get()` 当它不存在，用它的话
    // 「禁用之后再也删不了」—— 一个死结，而且症状是「明明在设置页里看着它，就是删不掉」
    const meta = entry.project.skills?.find(name)
    if (!meta) throw new Error(`没有名为 "${name}" 的技能`)
    // 真正的护栏（目标必须在某个 skills 根下、里面真有 SKILL.md）在 writer.ts 里
    const dir = removeSkill(meta.file)
    entry.project.skills?.refresh()
    this.refreshProjectTools(cwd, true)
    return dir
  }

  /**
   * 打开 / 关掉一个技能 —— 技能页每行那个开关。
   *
   * 关掉只是让它**不进「## 可用技能」**（`skill` 工具、斜杠命令一并当它不存在），
   * `SKILL.md` 一个字不动。要真删还是走 `removeSkill`。
   *
   * **必须落盘**：只改内存的话重开项目就全回来了。而落盘之后**还要把内存那份补成一样的** ——
   * 它是新建会话和下次拆装工具集的来源，漏一步就表现成「点了开关，当轮是好的，重开又回来了」。
   *
   * 内存那份**自己算**，不回读磁盘：`loadConfig` 会跑 dotenv（改全局 `process.env`），
   * 理由见 `patchTemplate` 那条注释。算法比看上去简单 —— 上面 `setSkillDisabled` 的两种
   * 情形各自的结果都是「并集里加一个 / 并集里去掉一个」，与 scope 无关。
   *
   * `refreshProjectTools(cwd, true)`：技能同时改提示词（那段索引）和工具集（关到一个不剩时
   * `skill` 工具该摘掉），所以是 true，同 `addSkill`。
   */
  setSkillDisabled(cwd: string, name: string, disabled: boolean, scope: SkillScope): string[] {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，改不了技能开关')
    // 名字先认：不然开关能关掉一个压根不存在的技能，配置文件里就多一条永远不生效的记录
    if (!entry.project.skills?.find(name)) throw new Error(`没有名为 "${name}" 的技能`)

    const changed = writeSkillDisabled(
      { global: path.join(claudaHome(), 'config.json'), project: configPath(cwd) },
      scope,
      name,
      disabled,
    )

    const cfg = entry.project.config
    cfg.disabledSkills = disabled
      ? [...new Set([...cfg.disabledSkills, name])]
      : cfg.disabledSkills.filter((n) => n !== name)
    entry.project.skills.setDisabled(cfg.disabledSkills)
    this.refreshProjectTools(cwd, true)
    return changed
  }

  /**
   * 建 / 改一个智能体。同名**整份覆盖**，所以它同时是「新建」和「保存」—— 界面只发这一个动词。
   *
   * **刻意不调 `refreshProjectTools`**，和上面两个技能方法正好相反：改一个智能体只影响
   * **之后新开的**会话（已在的会话手里是冻结的那份配方，见 `Session.agentSpec`）。广播过去的话，
   * 「我把审查员调紧了一点」会当场改掉一段正在进行的对话的身份 —— 那正是决策 2 要排除的。
   * 技能与 MCP 不是这个道理：它们是会话手里拿的工具，工具换了手里就得换。
   */
  addAgent(cwd: string, input: Omit<WriteAgentInput, 'cwd'>): { file: string; created: boolean } {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，加不了智能体')
    const result = writeAgent({ ...input, cwd })
    // 注册表是打开项目那一刻扫的一次性快照，不重扫的话「刚建的智能体当场开不了会话」
    entry.project.agents?.refresh()
    return result
  }

  /**
   * 读一份智能体的**全部字段带正文** —— 设置页的编辑表单要正文。
   *
   * `project/info` 里那份**刻意不带正文**（它被每轮刷新的徽标拖着走），所以另开一条通道。
   * 名字不存在就**抛**：静默返回个半份会让用户对着一个空表单以为「它本来就是空的」。
   */
  getAgent(cwd: string, name: string): ResolvedAgent {
    const entry = this.projects.get(cwd)
    const resolved = entry?.project.agents?.resolve(name)
    if (!resolved) throw new Error(`没有名为 "${name}" 的智能体`)
    return resolved
  }

  /**
   * 删一个智能体（连目录）。入参是**名字**，路径从注册表里查 —— 界面只拿到名字，
   * 让它自己拼路径迟早会拼出一个不存在的目录（同 `removeSkill`）。
   *
   * 真正的护栏（目标必须在某个 `agents` 根下、目录里真有 `AGENT.md`）在 `writer.ts` 里。
   */
  removeAgent(cwd: string, name: string): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，删不了智能体')
    const meta = entry.project.agents?.get(name)
    if (!meta) throw new Error(`没有名为 "${name}" 的智能体`)
    const dir = removeAgentDir(meta.file)
    entry.project.agents?.refresh()
    return dir
  }

  /**
   * 标「本项目默认」。只写 `config.json` 的一个键，并**同步内存里的模板** —— 不同步就是
   * 「改了没生效」（同 `setProfileField` 那条）。
   *
   * 不校验这个名字存不存在：默认可以指向一个还没建的智能体（界面上选的时候自然拿不到）。
   * 空串 = 取消默认。**只影响之后新开的会话** —— 旧会话的绑定是冻结的。
   */
  setDefaultAgent(cwd: string, name: string): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，改不了默认智能体')
    const file = writeDefaultAgent(cwd, name)
    entry.project.config.defaultAgent = name
    return file
  }

  /**
   * 加一个 MCP 服务器：**先落盘、再连接**。
   *
   * 顺序和 `mcp_add` 那个工具里同一条理由：写盘可能因为配置文件不是合法 JSON 而抛，
   * 那时连接还没建，什么都不会留下。反过来则是「连接建好了、配置没写成」—— 一个
   * 谁也找不到的孤儿进程，重启就没了，用户还以为是保存成功了。
   *
   * 连不上时会**抛**（`addServer` 的契约），但配置已经写下去了：那是用户能看见也能在
   * MCP 页里删掉的状态，比静默回退强。
   */
  async addMcpServer(
    cwd: string,
    scope: 'global' | 'project',
    name: string,
    cfg: McpServerConfig,
  ): Promise<string> {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，加不了 MCP 服务器')
    const file =
      scope === 'global'
        ? writeMcpServer(path.join(claudaHome(), 'config.json'), name, cfg)
        : writeMcpServer(configPath(cwd), name, cfg)
    await entry.project.mcp.addServer(name, cfg)
    // MCP 换的是 tools 数组，「## 可用技能」那段没动 —— 不重建提示词，省一次前缀缓存
    this.refreshProjectTools(cwd, false)
    return file
  }

  /**
   * 删掉一个 MCP 服务器：先摘运行期、再按优先级从配置里删。
   *
   * 运行期那份是**合并之后**的，所以「有没有这个名字」问它才对；配置那边找哪个文件由
   * `removeMcpServerAnywhere` 按项目优先的顺序决定 —— 合并之后看不出某一条来自哪份文件。
   */
  async removeMcpServer(cwd: string, name: string): Promise<string> {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，删不了 MCP 服务器')
    await entry.project.mcp.removeServer(name)
    const file = removeMcpServerAnywhere(cwd, name)
    this.refreshProjectTools(cwd, false)
    return file
  }

  /**
   * 一台服务器的工具明细（设置页展开那一行时才要）。**只读，不落盘**。
   *
   * 单独一个方法而不是塞进 `ProjectInfo`：工具明细比状态行大两个数量级，而 `ProjectInfo`
   * 是每轮徽标刷新都要重算一遍的。谁展开谁付这笔钱。
   */
  mcpToolCatalog(cwd: string, name: string): McpToolInfo[] {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，看不了 MCP 工具')
    return entry.project.mcp.toolCatalog(name)
  }

  /**
   * 改一台服务器的工具白名单：**先落盘、再改运行期**（顺序同 `addMcpServer`）。
   *
   * 反过来的话，配置写失败（不是合法 JSON）时运行期已经变了，界面显示改成功、重启回原样。
   *
   * `tools` 给空数组就是「一个都不接」—— 调用方（设置页）把「全勾上」翻成 `undefined`，
   * 因为那是**不设白名单**，和空数组是两件事（见 `setMcpServerTools`）。
   *
   * 返回真正写着这台服务器的那个文件；两处都没有时返回 `''`，此时运行期也没动 —— 那种
   * 情况只可能是「运行期临时加的服务器」（`mcp_add` 写完盘又手工删了配置），不该假装成功。
   */
  setMcpTools(cwd: string, name: string, tools: string[] | undefined): string {
    const entry = this.projects.get(cwd)
    if (!entry) throw new Error('项目运行时还没就绪，改不了 MCP 工具白名单')
    const file = setMcpServerToolsAnywhere(cwd, name, tools)
    if (!file) return ''
    entry.project.mcp.setTools(name, tools)
    // 同 `addMcpServer`：换的是 tools 数组，「## 可用技能」没动，提示词不用重建
    this.refreshProjectTools(cwd, false)
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
    // 被 `ensureProject` 钉住的那份没有会话引用，`closeSession` 带不走它。退出时一样要
    // 收干净 —— MCP 子进程留着的话事件循环不会结束，表现是关窗之后进程不消失
    this.pinnedCwd = null
    const remaining = [...this.projects.values()]
    this.projects.clear()
    for (const entry of remaining) await entry.project.dispose()
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
    const tools = entry ? entry.project.assembleTools(session.agentSpec) : []
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

  /**
   * 按项目目录拿运行时，没有就建，并把它**钉住**。
   *
   * 为什么要钉：技能与 MCP 挂在项目运行时上（MCP 子进程的宿主就是它），而运行时原本
   * 只在开会话时才建、最后一个会话关掉就销毁。于是「还没开会话」和「刚关掉会话」这两个
   * 状态下，模型 / 技能 / MCP 三页只剩一句「还没有打开的会话」—— 可配技能和 MCP 恰恰是
   * 开第一个会话**之前**想做的事。
   *
   * 钉的是**最后一次调用的那个目录**：换项目时上一份要是已经没人用（refs 归零）就顺手
   * 销毁，不然每换一次目录都会留一份带着 MCP 子进程的运行时。
   */
  async ensureProject(cwd: string): Promise<SessionProject> {
    const previous = this.pinnedCwd
    if (previous && previous !== cwd) {
      this.pinnedCwd = null
      await this.dropProject(previous)
    }
    this.pinnedCwd = cwd
    const entry = await this.getOrCreateProject(cwd)
    return entry.project
  }

  private async acquireProject(cwd: string): Promise<ProjectEntry> {
    const entry = await this.getOrCreateProject(cwd)
    entry.refs++
    return entry
  }

  /**
   * 建（或复用）一份运行时，**不记引用计数** —— 「有没有会话在用」和「运行时在不在」
   * 从这一步起是两件事，前者由 `refs` 记，后者由 `ensureProject` 的钉子兜底。
   */
  private getOrCreateProject(cwd: string): Promise<ProjectEntry> {
    const existing = this.projects.get(cwd)
    if (existing) return Promise.resolve(existing)
    const inflight = this.opening.get(cwd)
    if (inflight) return inflight

    const pending = Promise.resolve(this.opts.openProject(cwd))
      .then((project) => {
        const entry: ProjectEntry = { project, refs: 0 }
        this.projects.set(cwd, entry)
        return entry
      })
      .finally(() => this.opening.delete(cwd))
    this.opening.set(cwd, pending)
    return pending
  }

  private async releaseProject(cwd: string): Promise<void> {
    const entry = this.projects.get(cwd)
    if (!entry) return
    entry.refs--
    if (entry.refs > 0) return
    await this.dropProject(cwd)
  }

  /**
   * 没人用、也没被选中，就真正销毁。
   *
   * **两个条件都不能少**：被 `ensureProject` 钉着的那份不能销毁（否则「关掉最后一个
   * 会话」那个瞬间菜单徽标和三个设置页一起变空，而那正是想改配置的时候）；还有会话在
   * 跑的更不能 —— `ensureProject` 换项目时会直接调到这里，那时 `refs` 可能大于零。
   */
  private async dropProject(cwd: string): Promise<void> {
    if (cwd === this.pinnedCwd) return
    const entry = this.projects.get(cwd)
    if (!entry || entry.refs > 0) return
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
