import type { Stream } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { McpServerConfig } from '../config.js'
import type { ToolPermission } from '../types.js'
import { toolSpecs } from '../tools/index.js'
import type { Tool } from '../tools/types.js'
import { estimateTokens } from '../util/text.js'
import { assignMcpToolNames } from './naming.js'
import { makeMcpTool } from './tool.js'

export type McpTransportKind = 'stdio' | 'http'
export type McpServerState = 'connected' | 'failed' | 'disabled'

export interface McpServerStatus {
  name: string
  transport: McpTransportKind
  state: McpServerState
  toolCount: number
  error?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PERMISSION: ToolPermission = 'exec'
/** 失败时回显服务器 stderr 的尾部长度，够看出「命令不存在」还是「握手被拒」 */
const STDERR_TAIL = 400

/**
 * MCP 服务器的连接池与工具装配。
 *
 * 设计原则是**永不因为一个服务器坏掉而拖垮整个会话**：`start()` 内部全部用
 * `allSettled`，单个服务器失败只记 `failed` 状态并警告，其余照常接入。
 * 会话里少几个工具，总好过 clauda 起不来。
 */
export class McpManager {
  private readonly clients = new Map<string, Client>()
  /** 按服务器名存状态，`/mcp` 运行期开关要能就地改 */
  private readonly statuses = new Map<string, McpServerStatus>()
  /** 每个服务器拉到的工具，关掉再打开时不用重新 listTools */
  private readonly perServer = new Map<string, Tool[]>()
  /** 用户用 `/mcp off` 关掉的服务器 —— 和配置里的 `enabled:false` 是两码事，别合并 */
  private readonly offByUser = new Set<string>()
  /** stdio 子进程的 pid，只为同步兜底退出路径留着 */
  private readonly pids = new Map<string, number>()
  /** 每个服务器生效的超时，`callTool` 在工具闭包里拿不到 cfg，只能在这里存一份 */
  private readonly timeouts = new Map<string, number>()
  private active: Tool[] = []
  private starting = false
  private closed = false

  constructor(
    private readonly config: Record<string, McpServerConfig>,
    private readonly opts: {
      version: string
      /** 收窄成结构类型，本模块因此不必依赖 View 的具体实现 */
      view: { warn(msg: string): void }
    },
  ) {}

  /** 并发连上所有启用的服务器。**永不抛异常** —— 单个失败只降级为警告 */
  async start(): Promise<void> {
    if (this.starting || this.closed) return
    this.starting = true

    const enabled: Array<[string, McpServerConfig]> = []
    for (const [name, cfg] of Object.entries(this.config)) {
      if (cfg.enabled === false) {
        this.statuses.set(name, { name, transport: transportOf(cfg), state: 'disabled', toolCount: 0 })
        continue
      }
      enabled.push([name, cfg])
    }

    const results = await Promise.allSettled(
      enabled.map(async ([name, cfg]) => {
        const tools = await this.connectOne(name, cfg)
        return { name, cfg, tools }
      }),
    )

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const [name, cfg] = enabled[i]
      if (r.status === 'fulfilled') {
        this.perServer.set(name, r.value.tools)
        this.statuses.set(name, {
          name,
          transport: transportOf(cfg),
          state: 'connected',
          toolCount: r.value.tools.length,
        })
      } else {
        const error = describe(r.reason)
        this.statuses.set(name, { name, transport: transportOf(cfg), state: 'failed', toolCount: 0, error })
        this.opts.view.warn(`MCP 服务器 ${name} 连接失败，已跳过：${error}`)
      }
    }

    this.rebuildActive()
  }

  /**
   * 运行期开关一个服务器。
   *
   * 关掉时会真的断开连接 —— 留着连接白白占一个子进程，而重新打开本来就要重连。
   * 工具列表缓存起来，重开时省一次 `listTools` 往返。
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const cfg = this.config[name]
    if (!cfg) throw new Error(`没有名为 "${name}" 的 MCP 服务器`)

    if (!enabled) {
      this.offByUser.add(name)
      const client = this.clients.get(name)
      this.clients.delete(name)
      this.pids.delete(name)
      if (client) {
        try {
          await client.close()
        } catch {
          // 断不掉就算了，工具已经从集合里摘走了
        }
      }
      this.statuses.set(name, { name, transport: transportOf(cfg), state: 'disabled', toolCount: 0 })
      this.rebuildActive()
      return
    }

    this.offByUser.delete(name)
    if (!this.clients.has(name)) {
      try {
        const tools = await this.connectOne(name, cfg)
        this.perServer.set(name, tools)
        this.statuses.set(name, {
          name,
          transport: transportOf(cfg),
          state: 'connected',
          toolCount: tools.length,
        })
      } catch (e) {
        const error = describe(e)
        this.statuses.set(name, { name, transport: transportOf(cfg), state: 'failed', toolCount: 0, error })
        this.rebuildActive()
        throw new Error(error)
      }
    }
    this.rebuildActive()
  }

  /** 接入的工具，交给 Agent 拼进工具集 */
  tools(): Tool[] {
    return this.active
  }

  /** 供 `/mcp` 展示，顺序与配置里的书写顺序一致 */
  status(): McpServerStatus[] {
    return [...this.statuses.values()]
  }

  /** 接入的工具 schema 每轮请求都要付的 token 估算，`/mcp` 页脚用 */
  tokenHint(): number {
    return estimateTokens(JSON.stringify(toolSpecs(this.active)))
  }

  async closeAll(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // 逐个关并吞掉异常：关不掉的子进程会挂住事件循环，但一个关失败不该挡住其余的去关
    await Promise.allSettled(
      [...this.clients.values()].map(async (c) => {
        try {
          await c.close()
        } catch {
          // 已经断了就算了
        }
      }),
    )
    this.clients.clear()
    this.pids.clear()
  }

  /**
   * 同步兜底：给 `process.exit` 之前没有 await 余地的地方用（`fail()` 那几条错误出口）。
   *
   * 正常退出走 `closeAll()` —— 它能让传输层把子进程树收拾干净。这里只能直接杀 pid，
   * 对 `npx` 这种自己还会再 spawn 一层的命令可能留下孙进程，所以它是兜底不是主路径。
   */
  closeAllSync(): void {
    this.closed = true
    for (const pid of this.pids.values()) {
      try {
        process.kill(pid)
      } catch {
        // 进程早就没了
      }
    }
    this.pids.clear()
    this.clients.clear()
  }

  /** 连一个服务器并把它声明的工具包成 clauda 的工具 */
  private async connectOne(name: string, cfg: McpServerConfig): Promise<Tool[]> {
    const transport = transportOf(cfg)
    const client = new Client(
      { name: 'clauda', version: this.opts.version },
      // MCP 服务器和 MCP 服务器之间可以互相打断，clauda 只是用户 —— 不声明任何能力，
      // 这样服务器不会反过来要我们采样（sampling）或要 roots，省掉一整类握手失败。
      { capabilities: {} },
    )

    // 声明在 try 外面：catch 里要读 stderr 尾部，放 try 里就出作用域了
    const t = createTransport(cfg, transport)
    const readStderr =
      t instanceof StdioClientTransport ? collectStderr(t.stderr, STDERR_TAIL) : () => ''

    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    try {
      await withTimeout(client.connect(t, {}), timeoutMs, `连接 MCP 服务器 ${name} 超时`)
      // pid 要 start() 之后才有，所以在这里取而不是构造时
      if (t instanceof StdioClientTransport && typeof t.pid === 'number') {
        this.pids.set(name, t.pid)
      }
      this.timeouts.set(name, timeoutMs)

      // 超时不能只罩住 connect：服务器握手成功却在 tools/list 上装死是常见故障，
      // 不设时限的话 clauda 从这里就起不来了（实测能挂到用户手动 Ctrl+C）。
      const listed = await withTimeout(
        client.listTools({}, {}),
        timeoutMs,
        `MCP 服务器 ${name} 响应 tools/list 超时`,
      )
      const specs = (listed.tools ?? []).filter((t) => allowed(cfg, t.name))
      // assign 按传入顺序返回，所以下标和 specs 一一对应
      const assigned = assignMcpToolNames(specs.map((t) => ({ server: name, tool: t.name })))

      const tools = specs.map((spec, i) => {
        const { name: finalName } = assigned[i]
        return makeMcpTool({
          name: finalName,
          // 名字经过消毒/截断，可能和服务器上的不一样，所以真实名单独带一份
          remoteName: spec.name,
          server: name,
          description: spec.description,
          inputSchema: spec.inputSchema,
          permission: cfg.permission ?? DEFAULT_PERMISSION,
          call: (toolName, args) => this.callTool(name, toolName, args),
        })
      })

      this.clients.set(name, client)
      return tools
    } catch (e) {
      // 连不上就把半开的连接还回去，否则 stdio 的子进程会一直挂着
      try {
        await client.close()
      } catch {
        // 本来就失败了，关不掉也没别的办法
      }
      const tail = readStderr()
      const base = describe(e)
      throw new Error(tail ? `${base}\n  服务器输出：${tail}` : base)
    }
  }

  /** 工具集是 perServer 减掉用户关掉的那些，顺序沿用配置里的书写顺序 */
  private rebuildActive(): void {
    const out: Tool[] = []
    for (const [name, tools] of this.perServer) {
      if (this.offByUser.has(name)) continue
      out.push(...tools)
    }
    this.active = out
  }

  private async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = this.clients.get(server)
    if (!client) throw new Error(`MCP 服务器 ${server} 未连接`)
    // 工具调用同样要有时限：一个卡住的服务器会把整轮对话吊在这儿，
    // 而且 agent 循环是串行的，后面所有工具都跟着停摆。
    return withTimeout(
      client.callTool({ name: tool, arguments: args }),
      this.timeouts.get(server) ?? DEFAULT_TIMEOUT_MS,
      `MCP 工具 ${tool} 调用超时`,
    )
  }
}

function transportOf(cfg: McpServerConfig): McpTransportKind {
  if (cfg.type) return cfg.type
  return cfg.url ? 'http' : 'stdio'
}

function createTransport(cfg: McpServerConfig, kind: McpTransportKind) {
  if (kind === 'http') {
    if (!cfg.url) throw new Error('HTTP 类型的 MCP 服务器缺少 url')
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    })
  }
  if (!cfg.command) throw new Error('stdio 类型的 MCP 服务器缺少 command')
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env,
    cwd: cfg.cwd,
    // 必须显式给 'pipe'：默认是 'inherit'，会把 npx 下载进度之类的噪音直接倒进 clauda；
    // 而且只有 'pipe' 才会建出 `transport.stderr` 让我们收集。
    stderr: 'pipe',
  })
}

function allowed(cfg: McpServerConfig, toolName: string): boolean {
  return cfg.tools === undefined || cfg.tools.includes(toolName)
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 收集子进程 stderr 的尾部。
 *
 * 不能直接把一个自建的 Writable 塞给 `spawn` 的 stdio —— Windows 上 Node 只接受
 * 带底层句柄的流，会直接报 `The argument 'stdio' is invalid`。用传输层自己的
 * `stderr` 流就没这个问题。
 *
 * 必须真的读走：不读的话 PassThrough 的缓冲满了会给子进程反向施压，把它卡住。
 */
function collectStderr(stream: Stream | null, limit: number): () => string {
  let buf = ''
  stream?.on('data', (chunk: Buffer | string) => {
    buf = (buf + String(chunk)).slice(-limit)
  })
  return () => buf.trim()
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
