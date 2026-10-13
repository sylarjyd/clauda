#!/usr/bin/env node
import path from 'node:path'
import { Command, Option } from 'commander'
import { Agent } from './agent/agent.js'
import { latestSessionId, listSessions, loadSession, newSessionId } from './agent/session.js'
import { listMemories } from './agent/memory-store.js'
import { memoryInitPrompt } from './agent/system-prompt.js'
import { loadConfig, type PermissionMode, type CliOverrides } from './config.js'
import { McpManager } from './mcp/manager.js'
import { PermissionManager, type Asker } from './permissions.js'
import { OpenAICompatibleProvider } from './provider/openai.js'
import { mcpCostNotice } from './runtime/mcp-cost.js'
import { persistSession } from './runtime/persist.js'
import { createToolAssembly } from './runtime/tools-assembly.js'
import { SkillRegistry } from './skills/registry.js'
import { PlainView } from './ui/plain-view.js'
import { Repl } from './ui/repl.js'
import { TerminalView } from './ui/terminal-view.js'
import { style, sym } from './ui/theme.js'
import { describeError } from './util/errors.js'

const VERSION = '0.1.0'

/** 顶层 catch 里也想带上接口地址，所以把最近一次加载的配置留在模块作用域 */
let lastLoadedConfig: ReturnType<typeof loadConfig> | undefined

/**
 * 退出前必须关掉 MCP 连接。
 *
 * stdio 传输起的子进程会让事件循环一直活着 —— 忘了关，`/exit` 之后 clauda 不会退出，
 * 表现是「卡住」而不是报错，很难联想到是 MCP。所有出口都要过 `shutdown()`。
 */
let activeMcp: McpManager | undefined
let shuttingDown = false

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await activeMcp?.closeAll()
  } catch {
    // 关不掉也得退，不能让清理把退出卡住
  }
  process.exit(code)
}

interface CliFlags {
  print?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  permissionMode?: PermissionMode
  maxTokens?: number
  contextWindow?: number
  continue?: boolean
  resume?: string | boolean
  listSessions?: boolean
  init?: boolean
  outputFormat: 'text' | 'json'
}

async function main(): Promise<void> {
  const program = new Command()

  program
    .name('clauda')
    .description('终端编码 Agent —— 参考 Claude Code 的功能实现，后端走 OpenAI 兼容接口')
    .version(VERSION, '-v, --version')
    .argument('[prompt]', '直接提问（等价于 -p），不填则进入交互模式')
    .option('-p, --print <prompt>', '无头模式：执行一次并输出结果后退出')
    .option('--model <model>', '覆盖模型名称')
    .option('--base-url <url>', '覆盖 API 地址（需以 /v1 结尾）')
    .option('--api-key <key>', '覆盖 API Key')
    .addOption(
      new Option('--permission-mode <mode>', '权限模式').choices(['default', 'auto', 'plan']),
    )
    .option('--max-tokens <n>', '单次回复的最大 token 数', (v) => Number(v))
    .option('--context-window <n>', '模型上下文窗口大小', (v) => Number(v))
    .option('-c, --continue', '继续当前目录最近的一次会话')
    .option('-r, --resume [id]', '恢复指定会话（不给 id 则取最近一次）')
    .option('--list-sessions', '列出当前目录的历史会话')
    .option('--init', '让模型调研项目并生成 CLAUDA.md')
    .addOption(
      new Option('--output-format <format>', '无头模式的输出格式').choices(['text', 'json']).default('text'),
    )
    .showHelpAfterError('（用 clauda --help 查看完整说明）')

  program.parse()
  const opts = program.opts<CliFlags>()
  const positional = program.args[0] as string | undefined
  const cwd = process.cwd()

  const overrides: CliOverrides = {
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    permissionMode: opts.permissionMode,
    maxTokens: opts.maxTokens,
    contextWindow: opts.contextWindow,
  }
  const config = loadConfig(cwd, overrides)
  lastLoadedConfig = config

  if (opts.listSessions) {
    printSessions(cwd)
    return
  }

  const prompt = opts.print ?? positional
  const headless = prompt !== undefined || opts.init === true

  const provider = new OpenAICompatibleProvider(config.provider)

  // 权限回调依赖 Repl，而 Repl 又依赖 Agent —— 用一层间接引用打破循环
  let asker: Asker = async () => false
  const permissions = new PermissionManager(config.permissions, (label, detail) =>
    asker(label, detail),
  )

  const view = headless
    ? new PlainView({ silentAssistant: opts.outputFormat === 'json' })
    : new TerminalView()

  const skills = SkillRegistry.discover(cwd)

  const mcp = new McpManager(config.mcpServers ?? {}, { version: VERSION, view })
  await mcp.start()
  activeMcp = mcp

  // 配方放在 runtime 里是因为桌面端要用同一份 —— 各写各的迟早会漂
  const { assemble } = createToolAssembly(skills, mcp)

  const mcpCost = mcpCostNotice(mcp, config.contextWindow)
  if (mcpCost.infoText) view.info(style.dim(mcpCost.infoText))
  if (mcpCost.warnText) view.warn(mcpCost.warnText)

  const agent = new Agent({
    cwd,
    config,
    provider,
    view,
    permissions,
    tools: assemble(),
    skills,
    // 传函数而不是快照：memory_write 在会话中途新增的记忆，当轮就要出现在索引里
    memoryIndex: () => listMemories(),
  })

  // 可变：`/new` 要换一个全新的 id，`/resume` 要接管被恢复会话的 id。
  // 一直用启动时那一个的话，两者都会把对话写进错误的文件（见 repl.ts 的两个回调）。
  let sessionId = newSessionId()

  const persist = () =>
    persistSession({ cwd, sessionId, model: config.provider.model, snapshot: agent.snapshot() })

  // 恢复历史会话
  const resumeId =
    opts.resume === true ? latestSessionId(cwd) : typeof opts.resume === 'string' ? opts.resume : opts.continue ? latestSessionId(cwd) : null
  if (opts.resume || opts.continue) {
    if (!resumeId) {
      fail('当前目录没有可恢复的会话（用 --list-sessions 查看）')
    }
    const rec = loadSession(cwd, resumeId)
    if (!rec) fail(`找不到会话：${resumeId}`)
    agent.restore({
      messages: rec.messages,
      todos: rec.todos ?? [],
      totalUsage: rec.totalUsage ?? { input: 0, output: 0 },
      cost: rec.cost ?? 0,
    })
    // 接管被恢复会话的 id，否则续聊会写成一个新文件、原会话永不更新
    sessionId = rec.id
    if (!headless) {
      process.stdout.write(style.dim(`已恢复会话 ${rec.id}：${rec.title}\n\n`))
    }
  }

  if (headless) {
    asker = makeHeadlessAsker()
    await runHeadless(agent, config, prompt ?? memoryInitPrompt(cwd), opts.outputFormat)
    persist()
    await shutdown(0)
    return
  }

  // 交互模式：没有 key 直接说清楚，省得第一句话才报 401
  if (!config.provider.apiKey) {
    process.stdout.write(
      style.yellow(`${sym.warn} 未检测到 API Key\n`) +
        style.dim(
          '   任选一种方式配置：\n' +
            '     1. 设置环境变量 CLAUDA_API_KEY（以及 CLAUDA_BASE_URL、CLAUDA_MODEL）\n' +
            `     2. 写入 ${path.join(cwd, '.clauda', 'config.json')}\n` +
            '   详见项目根目录的 .env.example\n\n',
        ),
    )
  }

  const repl = new Repl({
    agent,
    view,
    permissions,
    config,
    cwd,
    skills,
    mcp,
    assembleTools: assemble,
    onNewSession: () => {
      sessionId = newSessionId()
    },
    onResumeSession: (id) => {
      sessionId = id
    },
    onPersist: persist,
    onExit: () => {
      void shutdown(0)
    },
  })
  asker = repl.askPermission

  // SIGTERM 没人管：交互模式下 Ctrl+C 由 readline 的 'SIGINT' 事件接管（见 repl.ts），
  // 这里再挂一个 process 级 SIGINT 会把「连按两次退出」的逻辑抢掉。
  process.on('SIGTERM', () => {
    void shutdown(0)
  })

  await repl.run()
}

async function runHeadless(
  agent: Agent,
  config: ReturnType<typeof loadConfig>,
  prompt: string,
  format: 'text' | 'json',
): Promise<void> {
  if (!config.provider.apiKey) {
    fail('未配置 API Key：请设置环境变量 CLAUDA_API_KEY，或写入 ~/.clauda/config.json')
  }

  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)

  try {
    const outcome = await agent.runTurn(prompt, ac.signal)
    const summary = agent.buildTurnSummary(outcome)

    if (format === 'json') {
      process.stdout.write(
        JSON.stringify(
          {
            result: outcome.text,
            aborted: outcome.aborted,
            steps: outcome.steps,
            usage: { input: summary.usage.input, output: summary.usage.output },
            totalUsage: summary.totalUsage,
            cost: summary.cost,
            currency: summary.currency,
            model: config.provider.model,
          },
          null,
          2,
        ) + '\n',
      )
    }
    if (summary.usage.input || summary.usage.output) {
      process.stderr.write(
        style.dim(
          `↑${summary.usage.input} ↓${summary.usage.output} tokens` +
            (summary.cost > 0 ? ` · ${summary.cost.toFixed(4)} ${summary.currency}` : '') +
            '\n',
        ),
      )
    }
  } finally {
    process.off('SIGINT', onSigint)
  }
}

/**
 * 无头模式下没人能回答授权弹窗，所以默认拒绝写/执行类操作。
 * 只提示一次，避免刷屏；同时告诉用户怎么放行。
 */
function makeHeadlessAsker(): Asker {
  let warned = false
  return async (label: string) => {
    if (!warned) {
      warned = true
      process.stderr.write(
        style.yellow(`${sym.warn} 无头模式下无法弹出授权确认，写文件/执行命令的请求会被拒绝。\n`) +
          style.dim('   如需放行请加 --permission-mode auto，或在配置文件的 permissions.allow 里预先声明。\n'),
      )
    }
    process.stderr.write(style.dim(`   已拒绝：${label}\n`))
    return false
  }
}

function printSessions(cwd: string): void {
  const list = listSessions(cwd)
  if (list.length === 0) {
    process.stdout.write(style.dim('当前目录还没有历史会话。\n'))
    return
  }
  for (const s of list) {
    process.stdout.write(
      `${style.cyan(s.id)}  ${style.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${s.title}\n`,
    )
  }
}

/**
 * 出错退出。这些分支里 MCP 可能已经连上了，所以要先杀子进程再退。
 *
 * 保持同步且返回 `never`：调用点靠这个类型收窄来保证后续代码不会带着 null 继续跑
 * （`await fail()` 拿不到这层收窄，TS 不把 await 过的调用当 never 处理）。
 * 因此这里只能走 `closeAllSync()`，异步的那条路径留给 `shutdown()`。
 */
function fail(msg: string): never {
  process.stderr.write(style.red(`${sym.cross} ${msg}\n`))
  activeMcp?.closeAllSync()
  process.exit(1)
}

void main().catch((err) => {
  fail(describeError(err, lastLoadedConfig))
})
