import readline from 'node:readline'
import type { Agent } from '../agent/agent.js'
import { memoryInitPrompt } from '../agent/system-prompt.js'
import type { View } from '../agent/view.js'
import { listMemories, memoryDir } from '../agent/memory-store.js'
import type { ClaudaConfig } from '../config.js'
import type { PermissionManager } from '../permissions.js'
import { toolNameOf } from '../runtime/permission-bridge.js'
import type { McpManager } from '../mcp/manager.js'
import type { SkillRegistry } from '../skills/registry.js'
import type { SkillMeta } from '../skills/types.js'
import type { Tool } from '../tools/types.js'
import { describeError } from '../util/errors.js'
import { decodeInput } from './input-decoder.js'
import { style, sym } from './theme.js'

export interface ReplOptions {
  agent: Agent
  view: View & { stopSpinner(): void }
  permissions: PermissionManager
  config: ClaudaConfig
  cwd: string
  skills?: SkillRegistry
  mcp?: McpManager
  /**
   * 重算当前应该挂给 Agent 的完整工具集（内置 + 技能 + 已启用的 MCP）。
   *
   * 由 `index.ts` 提供而不是在这里现拼：初始装配和运行期重装必须走同一份逻辑，
   * 两处各写一遍迟早会漂。`/mcp` 改了服务器开关后调它 + `agent.setTools()`。
   */
  assembleTools?: () => Tool[]
  /**
   * 换一个全新的会话 id，`/new` 用。
   *
   * 会话 id 由 index.ts 持有并传给 persist()，所以这里只能往回通知，没法自己改。
   * 不换的话 `/new` 之后的落盘会拿新会话覆盖旧文件。
   */
  onNewSession: () => void
  /** 接管一个已存在的会话 id，`/resume` 用。不接管的话续聊会另起一个文件，原文件永不更新 */
  onResumeSession: (id: string) => void
  /** 每轮结束后回调，用于落盘会话 */
  onPersist: () => void
  onExit: () => void
}

const DOUBLE_CTRL_C_WINDOW_MS = 3000

/**
 * 内置命令名。
 *
 * 只用于把「被内置命令遮蔽的技能」标出来给人看 —— 真正的分发在 handleSlash 的
 * default 分支里做，内置命令在那里天然优先。所以这份名单漏更新最多导致标签不准，
 * 不会让某个内置命令被技能抢走。
 */
const BUILTIN_COMMANDS = new Set([
  'help', '?', 'exit', 'quit', 'clear', 'new', 'compact', 'cost', 'usage',
  'model', 'mode', 'init', 'memory', 'memories', 'skills', 'mcp', 'tools',
  'status', 'sessions', 'resume', 'files', 'context',
])

/**
 * 交互式终端界面。
 *
 * 提示符故意不加颜色：readline 计算换行位置时不认识 ANSI 转义序列，
 * 长输入一旦折行，带色提示符会把光标算错位、重绘出乱码。
 */
export class Repl {
  private rl: readline.Interface
  private currentAbort: AbortController | null = null
  private closing = false
  private lastSigintAt = 0
  private turnCount = 0

  /**
   * 用「事件队列 + 等待者队列」自己管理输入，而不是 rl.question()。
   *
   * 原因：readline 在没人等待时会把 'line' 事件直接丢掉。管道输入（`printf ... | clauda`）
   * 会在 run() 还没开始提问前就把所有行走完，用 question() 会整段丢失并立刻 EOF 退出。
   * 先攒进队列就没有这个竞态了。
   */
  private lineQueue: string[] = []
  private waiters: ((v: string | null) => void)[] = []
  private inputClosed = false

  constructor(private opts: ReplOptions) {
    const isTty = Boolean(process.stdin.isTTY)
    this.rl = readline.createInterface({
      // 管道输入先过一道编码判定：中文 Windows（代码页 936）的管道字节常是 GBK，
      // 直接按 UTF-8 解会得到一片 U+FFFD，既喂给模型又回显给用户。
      // 交互式终端不能包这一层 —— 包了 raw 模式和方向键就失灵了。
      input: isTty ? process.stdin : process.stdin.pipe(decodeInput()),
      output: process.stdout,
      historySize: 300,
      terminal: isTty,
    })
    this.bindEvents()
  }

  // ------------------------------------------------------------ 生命周期

  private bindEvents(): void {
    this.rl.on('SIGINT', () => {
      if (this.currentAbort) {
        this.currentAbort.abort()
        this.info(style.yellow('\n已请求中断当前任务…'))
        return
      }
      const now = Date.now()
      if (now - this.lastSigintAt < DOUBLE_CTRL_C_WINDOW_MS) {
        this.shutdown()
        return
      }
      this.lastSigintAt = now
      process.stdout.write('\n' + style.dim('再按一次 Ctrl+C 退出') + '\n')
      this.rl.prompt()
    })

    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.lineQueue.push(line)
    })

    // 输入结束（Ctrl+D 或管道读完）时不能立刻退出 —— 队列里可能还有没处理完的行，
    // 交给 run() 循环自己收尾。
    this.rl.on('close', () => {
      this.inputClosed = true
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w(null)
    })
  }

  private shutdown(): void {
    if (this.closing) return
    this.closing = true
    process.stdout.write('\n' + style.dim('再见 👋') + '\n')
    this.rl.close()
    this.opts.onExit()
  }

  private info(msg: string): void {
    process.stdout.write(msg + '\n')
  }

  // ------------------------------------------------------------ 主循环

  async run(): Promise<void> {
    this.printBanner()

    while (!this.closing) {
      const raw = await this.question()
      if (raw === null) {
        this.shutdown()
        return
      }
      const input = raw.trim()
      if (!input) continue

      if (input.startsWith('/')) {
        await this.handleSlash(input)
        continue
      }
      await this.runTurn(input)
    }
  }

  /** 支持行尾反斜杠续行 */
  private async question(): Promise<string | null> {
    let buffer = ''
    for (;;) {
      const prompt = buffer === '' ? `${sym.pointer} ` : '  '
      const line = await this.readLine(prompt)
      if (line === null) return null
      if (line.endsWith('\\')) {
        buffer += line.slice(0, -1) + '\n'
        continue
      }
      return buffer + line
    }
  }

  private readLine(prompt: string): Promise<string | null> {
    if (this.closing) return Promise.resolve(null)

    const queued = this.lineQueue.shift()
    if (queued !== undefined) {
      // 管道输入：行早就到了，提示符只是为了让输出记录可读
      process.stdout.write(prompt + style.dim(queued) + '\n')
      return Promise.resolve(queued)
    }
    if (this.inputClosed) return Promise.resolve(null)

    // 让 readline 知道提示符，否则编辑长行时按方向键会重绘错位
    this.rl.setPrompt(prompt)
    this.rl.prompt()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private async runTurn(input: string): Promise<void> {
    const { agent } = this.opts
    const ac = new AbortController()
    this.currentAbort = ac

    try {
      const outcome = await agent.runTurn(input, ac.signal)
      const summary = agent.buildTurnSummary(outcome)
      this.opts.view.turnEnd(summary)
      this.turnCount++

      const label = agent.todos.current()
      if (label) this.info(style.dim(`  当前任务：${label.activeForm ?? label.content}`))
    } catch (err) {
      this.opts.view.error(describeError(err, this.opts.config))
    } finally {
      this.currentAbort = null
      this.opts.onPersist()
    }
  }

  /**
   * `/技能名` —— 把技能正文当作一条用户消息发给模型。
   *
   * 正文走消息而不是塞进系统提示词：技能是「这一次任务要照着做的东西」，
   * 用完就该随历史一起被压缩掉，没必要污染每轮都要发的系统提示词。
   */
  private async runSkill(name: string, arg: string): Promise<void> {
    const body = this.opts.skills?.read(name)
    if (body == null) {
      this.info(style.red(`技能 ${name} 读取失败，文件可能已被删除。`))
      return
    }
    const parts = [`我调用了技能「${name}」，请按以下指引执行。`]
    if (arg) parts.push(`附加要求：${arg}`)
    parts.push('--- 技能内容 ---', body)
    await this.runTurn(parts.join('\n\n'))
  }

  // ------------------------------------------------------------ 权限询问

  /** 由 PermissionManager 回调进来 */
  askPermission = async (label: string, detail?: string): Promise<boolean> => {
    this.opts.view.stopSpinner()
    const lines = [``, `${style.yellow(sym.warn)} clauda 想要执行：${style.bold(label)}`]
    if (detail) lines.push(style.dim('  ' + detail.split('\n')[0].slice(0, 200)))
    lines.push(`  允许？${style.dim('[y] 是  [n] 否  [a] 本次会话内总是允许')}`)
    this.info(lines.join('\n'))

    const answer = (await this.readLine('  选择 (y/N/a): ')) ?? 'n'
    const a = answer.trim().toLowerCase()
    if (a === 'a') {
      this.opts.permissions.allowForSession(toolNameOf(label))
      this.opts.permissions.allowForSession(label)
      return true
    }
    return a === 'y' || a === 'yes'
  }

  // ------------------------------------------------------------ 斜杠命令

  private async handleSlash(input: string): Promise<void> {
    const [cmd, ...rest] = input.slice(1).split(/\s+/)
    const arg = rest.join(' ').trim()
    const { agent, config } = this.opts

    switch (cmd) {
      case 'help':
      case '?':
        this.printHelp()
        break

      case 'exit':
      case 'quit':
        this.shutdown()
        break

      case 'clear':
        agent.reset()
        agent.todos.set([])
        this.turnCount = 0
        this.info(style.dim('已清空对话历史（用量统计保留）。'))
        break

      case 'new':
        agent.reset()
        agent.todos.set([])
        agent.totalUsage = { input: 0, output: 0 }
        agent.cost = 0
        this.turnCount = 0
        // 先换 id 再落盘：反过来的话这一下会把新会话写进旧 id 的文件，等于把旧对话抹了
        this.opts.onNewSession()
        this.opts.onPersist()
        this.info(style.dim('已开启新会话。'))
        break

      case 'compact': {
        const before = agent.contextTokens()
        const ok = await agent.compact(new AbortController().signal)
        if (ok) {
          this.info(
            style.dim(`已压缩上下文：约 ${before.toLocaleString('en-US')} → ${agent.contextTokens().toLocaleString('en-US')} tokens`),
          )
        } else {
          this.info(style.dim('当前历史太短，不需要压缩。'))
        }
        break
      }

      case 'cost':
      case 'usage': {
        const u = agent.totalUsage
        const pct = (agent.contextUsageRatio() * 100).toFixed(1)
        this.info(
          [
            `模型        ${config.provider.model}`,
            `累计 tokens 输入 ${u.input.toLocaleString('en-US')} / 输出 ${u.output.toLocaleString('en-US')}`,
            `累计费用    ${agent.cost > 0 ? agent.cost.toFixed(4) + ' ' + config.pricing.currency : '未配置单价'}`,
            `上下文占用  ${agent.contextTokens().toLocaleString('en-US')} / ${config.contextWindow.toLocaleString('en-US')} (${pct}%)`,
            `消息条数    ${agent.messages.length}`,
          ].join('\n'),
        )
        break
      }

      case 'model': {
        if (!arg) {
          this.info(`当前模型：${config.provider.model}（用法：/model <名称>）`)
          break
        }
        config.provider.model = arg
        // 模型名嵌在系统提示词的「会话配置」段里，不重建的话整个会话都在自报旧模型
        agent.refreshSystemPrompt()
        this.info(style.dim(`已切换到 ${arg}（仅本次会话有效）`))
        break
      }

      case 'mode': {
        const modes = ['default', 'auto', 'plan'] as const
        if (!arg) {
          this.info(`当前权限模式：${this.opts.permissions.mode}（可选：${modes.join(' / ')}）`)
          break
        }
        if (!modes.includes(arg as (typeof modes)[number])) {
          this.info(style.red(`未知模式 "${arg}"，可选：${modes.join(' / ')}`))
          break
        }
        this.opts.permissions.setMode(arg as (typeof modes)[number])
        agent.refreshSystemPrompt()
        this.info(style.dim(`已切换到 ${arg} 模式`))
        break
      }

      case 'init': {
        this.info(style.dim('正在让模型调研项目并生成 CLAUDA.md…'))
        await this.runTurn(memoryInitPrompt(this.opts.cwd))
        break
      }

      case 'memory':
        this.info(this.opts.agent.messages[0]?.content.split('## 项目记忆')[1]?.split('## 会话配置')[0]?.trim() ?? '(无)')
        break

      // 注意 /memory 和 /memories 是两回事：前者是项目记忆（CLAUDA.md，人写的），
      // 后者是记忆库（模型学的，全局）。名字像但是两套生命周期，别合并。
      case 'memories': {
        const { entries, total } = listMemories()
        if (entries.length === 0) {
          this.info(style.dim(`记忆库还是空的（${memoryDir()}）。模型学到值得跨会话复用的东西时会写进去。`))
          break
        }
        const rows = entries.map(
          (m) => `  ${style.cyan(m.name.padEnd(24))} ${style.dim(m.type.padEnd(10))} ${m.description}`,
        )
        const head = style.bold(`记忆库（${entries.length}${total > entries.length ? `/${total}` : ''} 条）`)
        this.info([head, ...rows, '', style.dim(`目录：${memoryDir()}`)].join('\n'))
        break
      }

      case 'skills': {
        const list = this.opts.skills?.list() ?? []
        if (list.length === 0) {
          this.info(
            style.dim(
              '没有发现技能。在 .clauda/skills/<名字>/SKILL.md 或 ~/.clauda/skills/<名字>/SKILL.md 放一份即可。',
            ),
          )
          break
        }
        this.info([style.bold(`可用技能（${list.length} 个）`), ...this.skillRows(list)].join('\n'))
        break
      }

      case 'tools': {
        // 读 agent 的工具集而不是 ALL_TOOLS：MCP 和技能注入的工具也要列出来
        const groups = groupTools(agent.listTools())
        const out: string[] = []
        for (const [label, list] of groups) {
          // 只有一类工具时不打分组标题，免得给默认场景平白加噪音
          if (groups.size > 1) out.push(style.bold(label))
          out.push(
            ...list.map(
              (t) =>
                `  ${t.name.padEnd(12)} ${style.dim(t.permission.padEnd(6))} ${t.description.split('\n')[0].slice(0, 60)}`,
            ),
          )
        }
        this.info(out.join('\n'))
        break
      }

      case 'mcp': {
        const mcp = this.opts.mcp
        if (!mcp) {
          this.info(style.dim('本次会话没有加载 MCP 管理器。'))
          break
        }
        const [sub, target] = arg.split(/\s+/).filter(Boolean)

        if (sub === 'on' || sub === 'off') {
          if (!target) {
            this.info(style.red(`用法：/mcp ${sub} <服务器名>`))
            break
          }
          try {
            await mcp.setEnabled(target, sub === 'on')
            // MCP 工具变了就必须让 Agent 重算 schema 和 token 核算，否则工具列表
            // 和上下文占用会各说各话
            this.opts.agent.setTools(this.opts.assembleTools?.() ?? this.opts.agent.listTools())
            this.info(style.dim(`已${sub === 'on' ? '接入' : '摘除'} MCP 服务器 ${target}`))
          } catch (e) {
            this.info(style.red(`${sub === 'on' ? '接入' : '摘除'}失败：${describeError(e)}`))
          }
          break
        }

        const list = mcp.status()
        if (list.length === 0) {
          this.info(
            style.dim('没有配置 MCP 服务器。在 config.json 的 mcpServers 里加一个即可（格式见 README）。'),
          )
          break
        }
        const out = list.map((s) => {
          const mark =
            s.state === 'connected' ? style.green('已连接')
            : s.state === 'failed' ? style.red('失败')
            : style.dim('未启用')
          const detail = s.error ? style.dim(`  ${s.error.split('\n')[0]}`) : ''
          return `  ${style.cyan(s.name.padEnd(16))} ${s.transport.padEnd(5)} ${mark}  ${style.dim(`工具 ${s.toolCount}`)}${detail}`
        })
        const tokens = mcp.tokenHint()
        if (tokens > 0) {
          out.push('', style.dim(`这些工具的 schema 每次请求都要发，约 ${tokens} token。用 /mcp off <名字> 可以摘掉。`))
        }
        this.info(out.join('\n'))
        break
      }

      case 'status':
        this.info(
          [
            `工作目录   ${this.opts.cwd}`,
            `模型       ${config.provider.model}`,
            `接口地址   ${config.provider.baseUrl}`,
            `权限模式   ${this.opts.permissions.mode}`,
            `自动压缩   ${config.autoCompact ? '开' : '关'}`,
            `会话轮数   ${this.turnCount}`,
          ].join('\n'),
        )
        break

      case 'sessions': {
        const { listSessions } = await import('../agent/session.js')
        const list = listSessions(this.opts.cwd)
        if (list.length === 0) {
          this.info(style.dim('当前目录还没有历史会话。'))
          break
        }
        this.info(
          list
            .slice(0, 20)
            .map(
              (s) =>
                `  ${style.cyan(s.id)}  ${style.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${s.title}`,
            )
            .join('\n'),
        )
        this.info(style.dim('  用 clauda --resume <id> 恢复某个会话'))
        break
      }

      case 'resume': {
        if (!arg) {
          this.info(style.red('用法：/resume <session-id>（可用 /sessions 查看）'))
          break
        }
        const { loadSession } = await import('../agent/session.js')
        const rec = loadSession(this.opts.cwd, arg)
        if (!rec) {
          this.info(style.red(`找不到会话 ${arg}`))
          break
        }
        agent.restore({
          messages: rec.messages,
          todos: rec.todos ?? [],
          totalUsage: rec.totalUsage ?? { input: 0, output: 0 },
          cost: rec.cost ?? 0,
        })
        // 接管被恢复会话的 id：不接管的话后续落盘会另起一个文件，
        // 这个会话从此分裂成两份，而原文件永远停在恢复前的状态。
        this.opts.onResumeSession(rec.id)
        this.info(style.dim(`已恢复会话 ${rec.id}（${rec.messages.length} 条消息）`))
        break
      }

      case 'files':
      case 'context': {
        const paths = collectTouchedFiles(agent.messages)
        this.info(
          paths.length
            ? `本会话读写过的文件：\n` + paths.map((p) => '  ' + style.cyan(p)).join('\n')
            : style.dim('本会话还没读写过文件。'),
        )
        break
      }

      default: {
        // 技能分发放在 default 里：内置命令天然优先（它们在更靠前的 case 就处理掉了），
        // 于是既不用维护一份命令名副本，以后新增内置命令也自动不会被技能抢走。
        if (this.opts.skills?.has(cmd)) {
          await this.runSkill(cmd, arg)
          break
        }
        this.info(style.red(`未知命令 /${cmd}`) + style.dim('，输入 /help 查看可用命令'))
      }
    }
  }

  // ------------------------------------------------------------ 展示

  private printBanner(): void {
    const { config } = this.opts
    const width = Math.min(process.stdout.columns || 80, 76)
    const rule = style.gray('─'.repeat(width))
    this.info('')
    this.info(`${style.bold(style.cyan('clauda'))} ${style.dim('v0.1.0')}  ${style.dim('终端编码 Agent')}`)
    this.info(rule)
    this.info(`  ${style.dim('模型')}   ${config.provider.model}`)
    this.info(`  ${style.dim('接口')}   ${config.provider.baseUrl}`)
    this.info(`  ${style.dim('目录')}   ${this.opts.cwd}`)
    this.info(`  ${style.dim('权限')}   ${this.opts.permissions.mode}${style.dim('  （/mode 可切换，/help 看全部命令）')}`)
    this.info(rule)
    if (!config.provider.apiKey) {
      this.info(
        style.yellow(`${sym.warn} 还没有配置 API Key。`) +
          style.dim(' 请设置环境变量 CLAUDA_API_KEY，或写入 ~/.clauda/config.json'),
      )
    }
    this.info('')
  }

  /** 技能在 /help 和 /skills 里用同一套排版，免得两处说法不一致 */
  private skillRows(list: SkillMeta[]): string[] {
    return list.flatMap((s) => [
      `  ${style.cyan(('/' + s.name).padEnd(16))} ${s.description}` +
        (BUILTIN_COMMANDS.has(s.name) ? style.yellow('  [与内置命令同名，内置优先]') : ''),
      `  ${' '.repeat(16)} ${style.dim(s.file)}`,
    ])
  }

  private printHelp(): void {
    const rows: [string, string][] = [
      ['/help', '显示这份帮助'],
      ['/status', '查看当前配置与连接信息'],
      ['/model <名称>', '切换模型（本次会话有效）'],
      ['/mode <模式>', '切换权限模式：default / auto / plan'],
      ['/cost', '查看 token 用量与上下文占用'],
      ['/compact', '手动压缩对话历史'],
      ['/clear', '清空对话历史'],
      ['/new', '开一个全新会话（连用量一起重置）'],
      ['/init', '让模型调研项目并生成 CLAUDA.md'],
      ['/files', '列出本会话读写过的文件'],
      ['/sessions', '列出当前目录的历史会话'],
      ['/resume <id>', '恢复指定会话'],
      ['/skills', '列出可用技能'],
      ['/memory', '查看项目记忆（CLAUDA.md）'],
      ['/memories', '列出记忆库（模型自己学到的）'],
      ['/mcp', 'MCP 服务器状态，/mcp off <名字> 可临时摘掉'],
      ['/tools', '列出可用工具'],
      ['/exit', '退出'],
    ]

    const lines = [
      style.bold('可用命令'),
      ...rows.map(([k, v]) => `  ${style.cyan(k.padEnd(16))} ${v}`),
    ]

    const skills = this.opts.skills?.list() ?? []
    if (skills.length > 0) {
      lines.push('', style.bold('可用技能'), `  ${style.dim('直接输入 /<技能名> 即可让模型照它执行')}`, ...this.skillRows(skills))
    }

    lines.push(
      '',
      style.bold('输入技巧'),
      `  ${style.cyan('行尾 \\'.padEnd(16))} 续行，适合粘贴多行代码或长需求`,
      `  ${style.cyan('Ctrl+C'.padEnd(16))} 打断当前任务；连按两次退出`,
      `  ${style.cyan('↑ / ↓'.padEnd(16))} 翻阅历史输入`,
      `  ${style.cyan('Ctrl+D'.padEnd(16))} 退出`,
    )

    this.info(lines.join('\n'))
  }
}

/** 按来源分组，让 MCP / 技能工具和内置工具一眼分得开 */
function groupTools(tools: Tool[]): Map<string, Tool[]> {
  const groups = new Map<string, Tool[]>()
  for (const t of tools) {
    const label =
      t.source?.kind === 'mcp'
        ? `MCP · ${t.source.server}`
        : t.source?.kind === 'skill'
          ? '技能'
          : t.source?.kind === 'memory'
            ? '记忆'
            : '内置'
    const bucket = groups.get(label)
    if (bucket) bucket.push(t)
    else groups.set(label, [t])
  }
  return groups
}

// ------------------------------------------------------------------ helpers

/** 从消息历史里挖出被读写的文件路径 */
function collectTouchedFiles(messages: { role: string; tool_calls?: { function: { name: string; arguments: string } }[] }[]): string[] {
  const out = new Set<string>()
  for (const m of messages) {
    if (!m.tool_calls) continue
    for (const tc of m.tool_calls) {
      if (!['read_file', 'write_file', 'edit_file'].includes(tc.function.name)) continue
      try {
        const args = JSON.parse(tc.function.arguments) as { path?: string }
        if (args.path) out.add(args.path)
      } catch {
        // 参数不合法就跳过
      }
    }
  }
  return [...out]
}
