import type { ClaudaConfig } from '../config.js'
import type { PermissionManager } from '../permissions.js'
import type { Provider } from '../provider/types.js'
import { ALL_TOOLS, toolSpecs } from '../tools/index.js'
import { TodoList } from '../tools/todo.js'
import type { Tool, ToolContext } from '../tools/types.js'
import {
  addUsage,
  emptyUsage,
  type ToolCall,
  type Usage,
  type UserAttachment,
  type WireMessage,
  type WireToolCall,
} from '../types.js'
import { buildUserContent, contentTokens, messageText } from '../util/message.js'
import { capByTokens, estimateTokens, truncateMiddle } from '../util/text.js'
import { buildSystemPrompt, type MemorySummary, type SkillSummary } from './system-prompt.js'
import type { TurnSummary, View } from './view.js'

export interface AgentOptions {
  cwd: string
  config: ClaudaConfig
  provider: Provider
  view: View
  permissions: PermissionManager
  tools?: Tool[]
  /**
   * 本会话绑的智能体，只取「名字 + 一段正文」—— 模型 / 温度 / 权限 / 白名单早在建会话时
   * 就折进 `config` 和 `tools` 了，这里只剩系统提示词里那段人格。
   *
   * 冻结语义（改智能体只影响之后新开的会话）正是靠**构造后不再变**来保证的：`refreshSystemPrompt()`
   * 读的是同一份 `opts`，所以模式切换、恢复会话、`invalidatesPrompt` 三条路重建出来的提示词
   * 都还是建会话那一刻那一份。
   */
  agent?: { name: string; prompt: string }
  skills?: { list(): SkillSummary[] }
  /**
   * 记忆库索引。传的是**函数**而不是快照：`memory_write` 可以在会话中途新增记忆，
   * 那一刻之后系统提示词里的索引必须跟着变，否则当轮写的记忆要等下次会话才可见。
   */
  memoryIndex?: () => { entries: MemorySummary[]; total: number }
  /**
   * 工具集合可能变了，请重新装配一遍。
   *
   * 由声明了 `invalidatesTools` 的工具触发（对话里新建/删除技能与 MCP 服务器）。
   * 和 `memoryIndex` 是函数同一个道理：那一刻的真相只有外面那个持有项目运行时的人知道 ——
   * Agent 自己手里只有一个**已经过期**的工具数组，重算得从技能注册表、MCP 管理器重新拼。
   */
  onToolsChanged?: () => void
}

export interface TurnOutcome {
  text: string
  aborted: boolean
  steps: number
  compactions: number
}

/** compact 时保留的最近消息条数 —— 太少了模型会丢当前任务的上下文 */
const KEEP_RECENT_MESSAGES = 6

/**
 * 压缩时至少要摘掉这么多 token 的头部，否则不值得为它多跑一次摘要请求。
 * 头部太小的情况（历史很短就被一个大工具结果顶爆）压缩本来就救不了。
 */
const MIN_HEAD_TOKENS = 400

/** 工具结果被截断时告诉模型怎么拿到剩下的部分，光说「截断了」它只会换个方式再撞一次 */
const TOOL_TRUNCATE_HINT =
  '结果被截断了。请用更精确的参数分次获取：read_file 用 offset/limit 分段读，grep 用 head_limit，或缩小 glob 范围。'

/** 一组消息的估算体量，口径与 contextTokens() 保持一致 */
function messagesTokens(msgs: WireMessage[]): number {
  let total = 0
  for (const m of msgs) {
    // 不能直接 estimateTokens：用户消息带图时 content 是数组，那边只收字符串
    total += contentTokens(m.content)
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function.name + tc.function.arguments)
      }
    }
  }
  return total
}

export class Agent {
  readonly todos = new TodoList()
  messages: WireMessage[] = []
  totalUsage: Usage = emptyUsage()
  cost = 0
  /** 最近一轮的消耗，供 /cost 展示 */
  lastTurnUsage: Usage = emptyUsage()

  private tools: Tool[]
  private specs: ReturnType<typeof toolSpecs>
  /**
   * 工具 schema 占用的 token。
   *
   * 这部分是作为请求的 tools 参数发出去的，不在 messages 里，而 contextTokens()
   * 只遍历 messages —— 真机实测漏掉 1404 token，占固定开销的 64%。后果是压缩
   * 触发点系统性偏晚：窗口小于约 5600 时，真实请求已经撑爆窗口，估算值却还没到
   * 阈值。这里把它算进来，宁可略高估（多算一点只会让压缩早触发，是安全方向）。
   */
  private specsTokens: number
  private compactions = 0
  /**
   * 上次压缩之后的消息条数。用来给压缩加冷却：
   * 上下文窗口设得很小时（比如 1200），压缩完仍然超标，每一步都会再压一次，
   * 白白多花一次请求。要求历史至少又长了 2 条才允许再压。
   */
  private messagesAtLastCompact = 0

  constructor(private opts: AgentOptions) {
    this.tools = opts.tools ?? ALL_TOOLS
    this.specs = toolSpecs(this.tools)
    this.specsTokens = estimateTokens(JSON.stringify(this.specs))
    this.reset()
  }

  get config(): ClaudaConfig {
    return this.opts.config
  }

  /** 当前可用的工具集合，供 `/tools` 使用 */
  listTools(): Tool[] {
    return this.tools
  }

  /**
   * 运行期替换工具集合（MCP 服务器启停）。
   *
   * 必须同时重算 `specs` 和 `specsTokens`。别的地方不用动：`streamOnce` 读 `this.specs`、
   * `runOneTool` 读 `this.tools`，都是**调用时**取值，换了集合自动跟上；只有这两个字段
   * 是构造时算一次的。漏算 `specsTokens` 的后果是 MCP 工具的 schema 不进上下文核算，
   * 压缩触发点系统性偏晚 —— 正是「必含工具 schema」那条约束要防的事。
   *
   * 首次装配走构造函数，这样第一轮请求的核算就是对的；这里只服务于中途增删。
   */
  setTools(tools: Tool[]): void {
    this.tools = tools
    this.specs = toolSpecs(tools)
    this.specsTokens = estimateTokens(JSON.stringify(this.specs))
  }

  private buildPrompt(): string {
    return buildSystemPrompt({
      cwd: this.opts.cwd,
      config: this.opts.config,
      mode: this.opts.permissions.mode,
      skills: this.opts.skills,
      memoryIndex: this.opts.memoryIndex?.(),
      agent: this.opts.agent,
    })
  }

  reset(): void {
    this.messages = [{ role: 'system', content: this.buildPrompt() }]
    this.compactions = 0
    this.messagesAtLastCompact = 0
  }

  /** 权限模式变化后需要刷新系统提示词里的行为约束 */
  refreshSystemPrompt(): void {
    if (this.messages[0]?.role !== 'system') return
    this.messages[0] = { role: 'system', content: this.buildPrompt() }
  }

  /** 最近一次请求消耗的上下文体量（估算），含每轮都要发的工具 schema */
  contextTokens(): number {
    return this.specsTokens + messagesTokens(this.messages)
  }

  contextUsageRatio(): number {
    return this.contextTokens() / Math.max(1, this.opts.config.contextWindow)
  }

  // ------------------------------------------------------------ 主循环

  /**
   * 跑一轮。
   *
   * `attachments` 只有桌面端会传（拖拽 / 粘贴 / 选文件来的）。CLI 侧走默认空数组，
   * 于是 `buildUserContent` 返回**字符串**，老路径一个字节都没变。
   */
  async runTurn(
    userInput: string,
    signal: AbortSignal,
    attachments: UserAttachment[] = [],
  ): Promise<TurnOutcome> {
    this.messages.push({ role: 'user', content: buildUserContent(userInput, attachments) })

    const usageBefore = this.totalUsage
    let text = ''
    let steps = 0
    const startCompactions = this.compactions
    const maxSteps = this.opts.config.maxSteps

    const finish = (aborted: boolean): TurnOutcome => {
      const usage = this.totalUsage
      const turnUsage: Usage = {
        input: usage.input - usageBefore.input,
        output: usage.output - usageBefore.output,
        cachedInput:
          usage.cachedInput !== undefined || usageBefore.cachedInput !== undefined
            ? (usage.cachedInput ?? 0) - (usageBefore.cachedInput ?? 0)
            : undefined,
      }
      this.lastTurnUsage = turnUsage
      return { text, aborted, steps, compactions: this.compactions - startCompactions }
    }

    for (;;) {
      if (signal.aborted) return finish(true)

      if (steps >= maxSteps) {
        this.opts.view.warn(
          `已达到单轮最大工具调用轮数（${maxSteps}），停止继续调用。你可以再发一条消息让我接着做。`,
        )
        break
      }

      if (this.shouldCompact()) {
        const ok = await this.compact(signal)
        if (ok) this.compactions++
      }

      this.opts.view.thinking(this.todos.current()?.activeForm)

      let step: StepResult
      try {
        step = await this.streamOnce(signal)
      } catch (err) {
        this.opts.view.thinkingDone()
        if (signal.aborted) return finish(true)
        throw err
      }
      this.opts.view.thinkingDone()

      if (step.usage) {
        this.totalUsage = addUsage(this.totalUsage, step.usage)
        this.cost += priceOf(step.usage, this.opts.config)
      }
      if (step.text) text += step.text
      steps++

      if (step.calls.length === 0) break
      await this.runTools(step.calls, signal)
    }

    return finish(false)
  }

  private async streamOnce(signal: AbortSignal): Promise<StepResult> {
    const stream = this.opts.view.assistantStart()
    let text = ''
    const pendingCalls: ToolCall[] = []
    let usage: Usage | undefined

    try {
      for await (const ev of this.opts.provider.stream({
        messages: this.messages,
        tools: this.specs,
        model: this.opts.config.provider.model,
        temperature: this.opts.config.provider.temperature,
        maxTokens: this.opts.config.provider.maxTokens,
        signal,
      })) {
        switch (ev.type) {
          case 'text':
            text += ev.text
            stream.write(ev.text)
            break
          case 'tool_call':
            pendingCalls.push(ev.call)
            break
          case 'usage':
            usage = ev.usage
            break
          case 'done':
            break
        }
      }
    } finally {
      stream.end()
    }

    const assistant: WireMessage = { role: 'assistant', content: text }
    if (pendingCalls.length > 0) {
      assistant.tool_calls = pendingCalls.map(toWireToolCall)
    }
    this.messages.push(assistant)

    return { text, calls: pendingCalls, usage }
  }

  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    // 同一轮里模型可以并行发多个工具调用，串行执行更可控（也避免 bash 互相抢资源）
    for (const call of calls) {
      const result = signal.aborted
        ? '用户中断了本轮执行，该工具调用未执行。'
        : await this.runOneTool(call, signal)
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      })
    }
  }

  private async runOneTool(call: ToolCall, signal: AbortSignal): Promise<string> {
    // args 的类型是 Record，但它在运行期来自 JSON.parse —— 可能是 null / 数字 / 数组。
    // 直接取属性会抛 TypeError，而这行在下面那个 try 之外：异常会穿出整个工具循环，
    // 把整轮对话打挂而不是变成一条工具错误结果。所以先做一次类型收窄。
    const callArgs = (call.args ?? {}) as Record<string, unknown>
    if (callArgs._parseError) {
      const msg = `工具参数不是合法 JSON：${String(callArgs._parseError)}\n原始参数：${truncateMiddle(String(callArgs._raw ?? ''), 500)}`
      this.opts.view.toolStart(call.name, '(参数解析失败)')
      this.opts.view.toolEnd(false, msg, 0)
      return `错误：${msg}`
    }

    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) {
      const names = this.tools.map((t) => t.name).join('、')
      const msg = `不存在名为 "${call.name}" 的工具。可用工具：${names}`
      this.opts.view.toolStart(call.name, '(未知工具)')
      this.opts.view.toolEnd(false, msg, 0)
      return `错误：${msg}`
    }

    const summary = safeSummary(tool, callArgs)
    this.opts.view.toolStart(tool.name, summary)

    const perm = await this.opts.permissions.check(tool, callArgs)
    if (!perm.ok) {
      this.opts.view.toolEnd(false, perm.reason ?? '权限被拒绝', 0)
      return `错误：${perm.reason ?? '权限被拒绝'}`
    }

    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      todos: this.todos,
      permission: this.opts.permissions,
      config: this.opts.config,
      onOutput: (chunk) => this.opts.view.toolOutput(chunk),
    }

    const started = Date.now()
    try {
      const out = await tool.run(callArgs, ctx)
      const elapsed = Date.now() - started
      this.opts.view.toolEnd(true, out, elapsed)
      // 改写了系统提示词的工具（目前只有 memory_write）跑完必须重建一次。
      // 代价是这一轮改了 messages[0]，会打断后端的提示词前缀缓存 —— 但只在真的写了
      // 记忆时发生一次，换来的是一条记忆当轮就可见，值得。
      if (tool.invalidatesPrompt) this.refreshSystemPrompt()
      // 改了工具集合的工具（新建/删除技能与 MCP 服务器）跑完要重新装配。**顺序在
      // refreshSystemPrompt 之后不重要，但必须在 `run` 返回之后**：装配读的是技能注册表
      // 和 MCP 管理器的当前状态，得等写盘那一步真的落了地。
      //
      // 这里不直接 `this.setTools(...)`：Agent 只拿得到一份过期的工具数组，重算要回到
      // 持有项目运行时的那一层，所以是回调。回调内部会把新集合塞回来（见 SessionManager）。
      if (tool.invalidatesTools) this.opts.onToolsChanged?.()
      return this.capResult(out || '（工具执行完成，无输出）')
    } catch (err) {
      const elapsed = Date.now() - started
      const msg = (err as Error)?.message ?? String(err)
      this.opts.view.toolEnd(false, msg, elapsed)
      return `错误：${msg}`
    }
  }

  /**
   * 单个工具结果的 token 上限。
   *
   * read_file 的上限是按「行」算的（2000 行），bash 的输出则完全没上限，而 2000 行
   * 代码和 2000 行中文说明的 token 数能差好几倍。实测一个超大工具结果可以一步吃掉
   * 整个窗口——偏偏它落在历史末尾，压缩摘不掉它，所以只能在这里封顶。
   *
   * 没显式配置时按窗口的 1/4 取，本地 4k/8k 窗口的模型会自动收紧到 1k/2k。
   */
  private toolResultBudget(): number {
    const configured = this.opts.config.maxToolResultTokens
    if (configured && configured > 0) return configured
    return Math.min(8000, Math.max(500, Math.floor(this.opts.config.contextWindow / 4)))
  }

  private capResult(text: string): string {
    return capByTokens(text, this.toolResultBudget(), TOOL_TRUNCATE_HINT).text
  }

  // ------------------------------------------------------------ 上下文压缩

  shouldCompact(): boolean {
    if (!this.opts.config.autoCompact) return false
    if (this.contextUsageRatio() < this.opts.config.compactThreshold) return false
    if (
      this.messagesAtLastCompact > 0 &&
      this.messages.length - this.messagesAtLastCompact < 2
    ) {
      return false
    }
    return true
  }

  /**
   * 选压缩切点：从期望保留的条数开始逐步减少保留量，返回第一个合法切点。
   *
   * 为什么要能突破 KEEP_RECENT_MESSAGES：一轮里模型可以连着调好几个工具，结果
   * 全堆在历史末尾，按常规保留量切的话头部几乎摘不掉。上下文已经超标时允许一路
   * 退到「只留当前这一步的往返」，能多压一点是一点。返回 null 表示没有可压的部分。
   */
  private pickCut(): number | null {
    for (let keep = KEEP_RECENT_MESSAGES; keep >= 1; keep--) {
      let cut = this.messages.length - keep
      if (cut <= 1) return null
      // 不能把 assistant 的 tool_calls 和它的 tool 结果切开
      while (cut > 1 && this.messages[cut].role === 'tool') cut--
      if (cut > 1) return cut
    }
    return null
  }

  /** 返回是否真的压缩了 */
  async compact(signal: AbortSignal): Promise<boolean> {
    const cut = this.pickCut()
    if (cut === null) return false

    const head = this.messages.slice(1, cut)
    const tail = this.messages.slice(cut)

    // 头部太小的话，摘要请求本身比省下来的还贵，不值得压
    if (messagesTokens(head) < MIN_HEAD_TOKENS) return false

    this.opts.view.thinking('正在压缩上下文')
    let summary: string
    try {
      summary = await this.summarize(head, signal)
    } catch (err) {
      this.opts.view.thinkingDone()
      this.opts.view.warn(`上下文压缩失败，保留原历史：${(err as Error).message}`)
      return false
    }
    this.opts.view.thinkingDone()

    this.messages = [
      this.messages[0],
      {
        role: 'user',
        content:
          '<conversation_summary>\n' +
          '以下是本次会话较早部分的摘要（原始消息已被压缩以节省上下文）：\n\n' +
          summary +
          '\n</conversation_summary>',
      },
      { role: 'assistant', content: '收到，我已了解此前的工作背景，继续。' },
      ...tail,
    ]
    this.messagesAtLastCompact = this.messages.length
    return true
  }

  private async summarize(messages: WireMessage[], signal: AbortSignal): Promise<string> {
    const transcript = messages
      .map((m) => {
        const calls = m.tool_calls?.map((c) => `  → 调用 ${c.function.name}(${truncateMiddle(c.function.arguments, 300)})`).join('\n')
        // 数组型 content 会被 truncateMiddle 静默 toString 成 [object Object]，先拍平
        return `[${m.role}] ${truncateMiddle(messageText(m.content), 4000)}${calls ? '\n' + calls : ''}`
      })
      .join('\n\n')

    const prompt = `请把下面这段编码会话的历史压缩成一份结构化摘要，供后续继续工作时参考。

必须保留：
1. 用户提出的原始需求和后续的每一次修正；
2. 已经完成的工作、改动了哪些文件（写全路径）、关键代码片段或函数名；
3. 当前进展到哪一步、下一步打算做什么；
4. 遇到的报错、踩过的坑、以及已经验证过的结论；
5. 用户的明确偏好或约束（比如「不要动某个模块」）。

不要保留：寒暄、重复的探索过程、已被推翻的尝试细节。

直接输出摘要正文，不要加「摘要如下」之类的开场白。

--- 会话历史 ---
${transcript}`

    let out = ''
    for await (const ev of this.opts.provider.stream({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      model: this.opts.config.provider.model,
      temperature: 0,
      maxTokens: 2048,
      signal,
    })) {
      if (ev.type === 'text') out += ev.text
      if (ev.type === 'usage') {
        this.totalUsage = addUsage(this.totalUsage, ev.usage)
        this.cost += priceOf(ev.usage, this.opts.config)
      }
    }
    if (!out.trim()) throw new Error('模型返回了空摘要')
    return out.trim()
  }

  // ------------------------------------------------------------ 统计

  buildTurnSummary(outcome: TurnOutcome): TurnSummary {
    return {
      steps: outcome.steps,
      usage: this.lastTurnUsage,
      totalUsage: this.totalUsage,
      cost: this.cost,
      currency: this.opts.config.pricing.currency,
      aborted: outcome.aborted,
      compactions: outcome.compactions,
    }
  }

  snapshot(): SessionSnapshot {
    return {
      messages: this.messages,
      todos: this.todos.toJSON(),
      totalUsage: this.totalUsage,
      cost: this.cost,
    }
  }

  restore(snap: SessionSnapshot): void {
    this.messages = snap.messages
    this.todos.set(snap.todos ?? [])
    this.totalUsage = snap.totalUsage ?? emptyUsage()
    this.cost = snap.cost ?? 0
    // 压缩的记账状态不在快照里，得在恢复时清掉：留着旧的 messagesAtLastCompact
    // 会让冷却判断把后续压缩一直挡掉（`messages.length - 上次条数 < 2` 恒成立）。
    this.compactions = 0
    this.messagesAtLastCompact = 0
    // 落盘时的系统提示词可能已经过期（换了模型、记忆库变了、cwd 不同）。
    // 放在 restore 里而不是各个调用点：CLI 的 --resume 和 REPL 的 /resume 都走这里，
    // 少接一处就会出现「恢复了会话但配置段还是旧的」。
    this.refreshSystemPrompt()
  }
}

interface StepResult {
  text: string
  calls: ToolCall[]
  usage?: Usage
}

export interface SessionSnapshot {
  messages: WireMessage[]
  todos: ReturnType<TodoList['toJSON']>
  totalUsage: Usage
  cost: number
}

function toWireToolCall(c: ToolCall): WireToolCall {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs } }
}

function safeSummary(tool: Tool, args: Record<string, unknown>): string {
  try {
    return truncateMiddle(tool.summary(args), 120)
  } catch {
    return ''
  }
}

function priceOf(usage: Usage, config: ClaudaConfig): number {
  const p = config.pricing
  const cached = usage.cachedInput ?? 0
  const fresh = Math.max(0, usage.input - cached)
  const cachedRate = p.cachedInput ?? p.input
  return (
    (fresh / 1_000_000) * p.input +
    (cached / 1_000_000) * cachedRate +
    (usage.output / 1_000_000) * p.output
  )
}
