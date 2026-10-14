import type { PermissionsConfig } from './config.js'
import type { Tool } from './tools/types.js'
import { matchesGlob } from './util/glob.js'

export interface PermissionResult {
  ok: boolean
  reason?: string
}

/** 询问用户的回调；返回 true 表示放行 */
export type Asker = (label: string, detail?: string) => Promise<boolean>

/**
 * 权限闸门。
 *
 * 判定顺序：deny 规则 → allow 规则 → 模式（plan 只读 / auto 全放 / default 按工具类型询问）。
 * 显式规则优先于模式，这样 `--permission-mode auto` 下也能保留兜底黑名单。
 */
export class PermissionManager {
  private sessionAllow = new Set<string>()

  constructor(
    private cfg: PermissionsConfig,
    private ask: Asker,
  ) {}

  get mode(): PermissionsConfig['mode'] {
    return this.cfg.mode
  }

  setMode(mode: PermissionsConfig['mode']): void {
    this.cfg.mode = mode
  }

  /** 本会话内放行该类调用（用户选「本次会话总是允许」时使用） */
  allowForSession(label: string): void {
    this.sessionAllow.add(label)
  }

  async check(tool: Tool, args: unknown): Promise<PermissionResult> {
    const label = formatLabel(tool, args)

    if (this.matchesRule(this.cfg.deny, tool, args)) {
      return { ok: false, reason: `该调用命中拒绝规则（deny），已阻止：${label}` }
    }
    if (this.matchesRule(this.cfg.allow, tool, args)) return { ok: true }
    if (this.sessionAllow.has(label) || this.sessionAllow.has(tool.name)) return { ok: true }

    if (this.cfg.mode === 'plan' && tool.permission !== 'read') {
      return {
        ok: false,
        reason:
          '当前处于 plan（只读）模式，不允许执行修改类操作。请先把方案讲清楚，等用户确认后再动手。',
      }
    }
    if (this.cfg.mode === 'auto' || tool.permission === 'read') return { ok: true }

    const yes = await this.ask(label, describeRisk(tool, args))
    return yes
      ? { ok: true }
      : { ok: false, reason: `用户拒绝了对 ${label} 的授权，请不要重试同一调用，先与用户确认。` }
  }

  private matchesRule(rules: string[], tool: Tool, args: unknown): boolean {
    for (const rule of rules) {
      if (matchOne(rule, tool, args)) return true
    }
    return false
  }
}

function formatLabel(tool: Tool, args: unknown): string {
  return `${tool.name}(${tool.summary(args)})`
}

function describeRisk(tool: Tool, args: unknown): string {
  // 工具自己声明了风险就用它的，**放在最前面**：下面几条都是按类猜的通用文案，而只有
  // 工具自己知道这次调用具体要害在哪里。典型的例子是 `mcp_add` —— 它归在 exec 类里，
  // 通用文案对它返回的是空串，弹出来会是一个只有标题、看不出在批准什么的框。
  if (tool.risk) return tool.risk(args)
  // MCP 工具放在最前面：它默认是 exec，但用户可以按服务器改成 write，
  // 那时会掉进下面那条「将修改文件」，而实际改什么完全不在我们掌握之中。
  if (tool.source?.kind === 'mcp') {
    return `来自 MCP 服务器「${tool.source.server}」的工具「${tool.source.tool}」，其行为不在 clauda 的管控范围内`
  }
  if (tool.name === 'bash' || tool.name === 'Bash') {
    const cmd = (args as { command?: string })?.command ?? ''
    return cmd
  }
  if (tool.permission === 'write') {
    return `将修改文件：${tool.summary(args)}`
  }
  return ''
}

/**
 * 规则语法：
 *   `Bash`               → 匹配工具名（并前缀匹配 `Bash__*` 这类派生命名）
 *   `Bash(npm run:*)`    → 匹配工具名 + 参数 glob（:后是通配，`,` 分隔多个参数时按整体匹配）
 *   `Read(src/**)`       → 文件类工具按路径匹配
 *   `mcp__linear`        → 放行该 MCP 服务器的全部工具
 *   `mcp`                → 放行所有 MCP 工具
 *
 * 工具名先归一化再比对：Claude Code 的 `Read`/`Write`/`TodoWrite` 要能对上 clauda 的
 * `read_file`/`write_file`/`todo_write`。只做大小写不敏感比较的话，这些多词名字永远
 * 等不上 snake_case 工具名 —— 配置模板里写的 `allow: ['Read', 'TodoWrite']` 会变成
 * 两条死规则，用户以为放行了其实没有，这是最危险的一类 bug。
 */
/**
 * Claude Code 里名字对不上 clauda 的那几个工具。键和值都取归一化后的形式，
 * 所以右边统一写「去掉单下划线的小写」而不是原始工具名。
 *
 * 表格只需要覆盖**拼写对不上**的：`Bash`/`Glob`/`Grep` 靠大小写不敏感就重合了，
 * `TodoWrite`、`Write`、`Edit` 去掉下划线后也自动对上，都不必列进来。
 */
const TOOL_ALIASES: Record<string, string> = {
  read: 'readfile',
  write: 'writefile',
  edit: 'editfile',
}

/**
 * 归一化工具名，让规则名和工具名能对上。
 *
 * 三步：小写化 → 去掉**单个**下划线 → 查别名表。规则名和工具名走同一个函数，
 * 于是 `TodoWrite`、`todo_write` 都落成 `todowrite`；`Read` 靠别名表落成 `readfile`，
 * 与 `read_file` 重合。关键是两边规则一致：只给工具名去下划线而保留规则名的话，
 * `read_file` 会化简成 `read`，照样等不上 `readfile` —— 这个对称性别弄丢。
 *
 * **双下划线原样保留**：前缀匹配靠 `mcp__` 区分「服务器名」和「工具名」，
 * 抹掉它 `mcp__linear` 就会退化成「任意以 `mcplinear` 开头」，前缀匹配的范围就失控了。
 *
 * MCP 工具名里的连字符不在这里处理 —— 那是名字本身的一部分，不是分隔符。
 */
export function normalizeToolName(name: string): string {
  const collapsed = name.toLowerCase().replace(/(?<!_)_(?!_)/g, '')
  return TOOL_ALIASES[collapsed] ?? collapsed
}

function matchOne(rule: string, tool: Tool, args: unknown): boolean {
  // 工具名部分要允许数字和短横线：MCP 工具名是 `mcp__server1__create-issue` 这种形状，
  // 老正则会把它整条判为非法规则，于是 deny 规则静默失效 —— 这是最危险的一类 bug。
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return false

  const [, name, pattern] = m
  const toolName = tool.name
  const normName = normalizeToolName(name)
  const normTool = normalizeToolName(toolName)
  const bare = pattern === undefined || pattern === ''
  const exact = normName === normTool
  // 不带参数的规则额外允许前缀匹配，双下划线是硬要求 —— 少了它 `bash` 会去匹配 `bashx`。
  // 白捡两条能力：`mcp__linear` 管住整个 server，`mcp` 管住所有 MCP 工具。
  const prefixed = bare && normTool.startsWith(normName + '__')
  if (!exact && !prefixed) return false
  if (bare) return true

  const target = ruleTarget(tool, args)
  if (target === null) return false

  // Claude Code 风格 `cmd:*` 前缀通配
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2)
    return target.toLowerCase().startsWith(prefix.toLowerCase())
  }
  return matchesGlob(pattern, target, true) || pattern === '*' || target === pattern
}

/**
 * 取参数级规则要比对的那个值。
 *
 * MCP 工具刻意落进 default 分支返回 `null`，也就是**不支持参数级规则**（`mcp__x__y(path)`
 * 这类写法不会生效）。因为从任意 JSON schema 里猜「哪个参数是路径」没有可靠办法，
 * 猜错的方向恰恰是「以为拦住了其实没拦」。要收窄就按服务器配 `permission`，
 * 或者用白名单 `tools`。
 */
function ruleTarget(tool: Tool, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  switch (tool.name) {
    case 'bash':
      return typeof a.command === 'string' ? a.command : null
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return typeof a.path === 'string' ? a.path : null
    case 'grep':
    case 'glob':
      return typeof a.path === 'string' ? a.path : null
    default:
      return null
  }
}

/** 明显危险的命令，任何模式下都拦一道（除非用户显式 allow 覆盖） */
const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?\s+\/(\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bchmod\s+-R\s+777\s+\/(\s|$)/,
]

export function isDangerousCommand(cmd: string): boolean {
  const normalized = cmd.replace(/\s+/g, ' ').trim()
  return DANGEROUS.some((re) => re.test(normalized))
}
