import path from 'node:path'
import {
  claudaHome,
  configPath,
  removeMcpServerAnywhere,
  writeMcpServer,
  type McpServerConfig,
} from '../config.js'
import type { ToolPermission } from '../types.js'
import { optionalString, requireString, type Tool } from './types.js'

/**
 * 让 agent 在对话里增删 MCP 服务器。
 *
 * **这两个工具和技能那两个不是一回事**：技能是往磁盘上落一段 markdown，MCP 服务器是
 * 「起一个子进程、把你给它的命令一直跑着，并把它的工具接到本次会话里」—— 等于把「执行任意
 * 命令」这条口子开到 clauda 自己身上。所以 `mcp_add` 用 `permission: 'exec'`：default 模式下
 * `permissions.ts` 里 `exec` 必然走到 `ask`，也就是**现成的授权弹窗**，不必为「先弹审批」
 * 另造一套机制（auto 模式直接放行，那是用户自己的选择，同 `memory_write` 的口径）。
 *
 * `risk` 必须给：`describeRisk` 对 `exec` 类工具返回的是空串（它只对 `bash` 有专门一条），
 * 不给的话弹出来会是一个只有标题、用户看不出在批准什么的框。
 *
 * 这两个工具需要的不只是 `tools()`，还要能从运行期增删服务器。收成一个窄接口，装配层因此
 * 不必认识整个 `McpManager`（它还会起子进程，不是随便谁都能造的）。
 */
export interface McpAdmin {
  addServer(name: string, cfg: McpServerConfig): Promise<void>
  removeServer(name: string): Promise<void>
}

/** `scope` 取值。和技能那边一致：agent 默认写**项目**，别动不动改到全局去 */
type McpScope = 'global' | 'project'

function mcpConfigFile(scope: McpScope, cwd: string): string {
  return scope === 'global' ? path.join(claudaHome(), 'config.json') : configPath(cwd)
}

function scopeOf(args: Record<string, unknown>): McpScope {
  return optionalString(args, 'scope') === 'global' ? 'global' : 'project'
}

/**
 * 把工具参数拼成一条 `McpServerConfig`。
 *
 * 校验写得比平时啰嗦，是因为这里的错误会**落进用户的配置文件**：一条既没有 url 也没有
 * command 的服务器写进去，表现是每次启动都白等一个连接超时。宁可当场拒绝。
 *
 * `type` 不填就按 url/command 推断 —— 和 `config.ts` 的 `transportOf` 同一套判据，
 * 所以这里**不需要**替不填 type 的人做决定，只要挡住自相矛盾的组合。
 */
function buildConfig(a: Record<string, unknown>): McpServerConfig {
  const url = optionalString(a, 'url')
  const command = optionalString(a, 'command')
  if (!url && !command) {
    throw new Error('必须给 command（本地命令，stdio）或 url（远程端点，http）其中之一，否则不知道该连什么')
  }
  if (url && command) {
    throw new Error('command 和 url 只能给一个：前者是本地命令，后者是远程端点')
  }

  const declared = optionalString(a, 'type')
  if (declared && declared !== 'stdio' && declared !== 'http') {
    throw new Error(`type 只能是 stdio 或 http，给的是 "${declared}"`)
  }
  if (declared === 'stdio' && !command) throw new Error('type=stdio 需要配 command')
  if (declared === 'http' && !url) throw new Error('type=http 需要配 url')

  const cfg: McpServerConfig = {}
  if (declared === 'stdio' || declared === 'http') cfg.type = declared
  if (command) {
    cfg.command = command
    const list = stringList(a.args, 'args')
    if (list.length > 0) cfg.args = list
  }
  if (url) cfg.url = url
  const env = stringMap(a.env, 'env')
  if (env) cfg.env = env
  const headers = stringMap(a.headers, 'headers')
  if (headers) cfg.headers = headers

  const permission = optionalString(a, 'permission')
  if (permission) {
    if (permission !== 'read' && permission !== 'write' && permission !== 'exec') {
      throw new Error(`permission 只能是 read / write / exec，给的是 "${permission}"`)
    }
    cfg.permission = permission as ToolPermission
  }
  // 显式写 true：用户是「加进来用」才加的，也免得写进文件的这一条看着像没配完
  cfg.enabled = true
  return cfg
}

function stringList(v: unknown, key: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`${key} 应该是字符串数组`)
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  if (out.length !== v.length) throw new Error(`${key} 里有非字符串的元素`)
  return out
}

/** 键值对参数（env / headers）。给空对象等于没给，省得往配置里写一个空壳 */
function stringMap(v: unknown, key: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key} 应该是「键: 值」对象`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') throw new Error(`${key}.${k} 应该是字符串`)
    out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 给授权弹窗和 `summary` 共用的一句「这次到底要连什么」 */
function targetOf(a: Record<string, unknown>): string {
  const url = optionalString(a, 'url')
  if (url) return `远程端点 ${url}`
  const command = optionalString(a, 'command')
  const list = Array.isArray(a.args) ? (a.args as unknown[]).filter((x) => typeof x === 'string') : []
  return `命令 ${[command, ...list].join(' ')}`
}

/**
 * 加一个 MCP 服务器：先写进配置文件，再当场连上。
 *
 * **顺序不能反**（先连后写）：写盘可能因为文件不是合法 JSON 而抛，那时已经建好的连接就
 * 成了一条谁也找不到的孤儿 —— 它还在占着子进程，而配置里没有它。先写后连的话，最坏情况
 * 是「配置里留了一条连不上的服务器」，那是个**看得见也删得掉**的状态（MCP 页会把它标成
 * 失败，点删除即可）。
 *
 * 连接失败时**不回滚配置**，正因为上面那句：用户需要看见自己填了什么，才能改对。错误信息
 * 里会说明配置已经写下去了，别让模型以为一切都回退了。
 */
export function makeMcpAddTool(
  mcp: McpAdmin,
  opts: { cwd: string },
): Tool<{
  name: string
  scope?: string
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  permission?: string
}> {
  return {
    name: 'mcp_add',
    description:
      '接入一个 MCP 服务器，把它提供的工具加进本次会话，并写进配置文件（下次启动自动接入）。' +
      '用户说「把某个 MCP 服务器加进来」时用它。要么给 command（本地命令，如 npx，stdio），' +
      '要么给 url（远程端点，http），两者只能给一个。默认写进当前项目，scope=global 写进用户主目录。' +
      '注意：这会起一个以你的身份运行、并把它的工具接到会话里的子进程 —— 确认服务器来自可信来源再调。',
    permission: 'exec',
    // 接上之后工具集**当场**要多出这个服务器的工具：不声明的话 `onToolsChanged` 不会被调，
    // agent 得等下一轮才看得见自己刚接上的东西 —— 「接上了但用不上」比报错更难查
    invalidatesTools: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器名，配置里的 key，也是重名时被覆盖的依据' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'project（默认）只在本项目生效；global 写进主目录，所有项目都能用',
        },
        type: {
          type: 'string',
          enum: ['stdio', 'http'],
          description: '不填则按给了 command 还是 url 推断',
        },
        command: { type: 'string', description: 'stdio：可执行文件，如 npx、node、uvx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'stdio：额外环境变量。密钥写成 ${VAR} 占位符，不必明文落盘',
        },
        url: { type: 'string', description: 'http：Streamable HTTP 端点，如 https://example.com/mcp' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'http：请求头。密钥同样建议写成 ${VAR} 占位符',
        },
        permission: {
          type: 'string',
          enum: ['read', 'write', 'exec'],
          description: '该服务器所有工具的权限级别，默认 exec（每次调用都问你）',
        },
      },
      required: ['name'],
    },
    summary: (a) => a?.name ?? '',
    risk: (a) => {
      const where = scopeOf(a as Record<string, unknown>) === 'global' ? '全局配置（所有项目）' : '本项目配置'
      return (
        `将把 MCP 服务器「${a?.name ?? ''}」写进${where}，并立刻连接 ${targetOf(a as Record<string, unknown>)}。\n` +
        '这个服务器会以你的身份运行，它声明的工具会被接入本次会话 —— 其行为不在 clauda 的管控范围内。' +
        '请确认它来自你信任的来源。'
      )
    },
    async run(args) {
      const a = args as Record<string, unknown>
      const name = requireString(a, 'name')
      const cfg = buildConfig(a)
      const file = writeMcpServer(mcpConfigFile(scopeOf(a), opts.cwd), name, cfg)
      try {
        await mcp.addServer(name, cfg)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(
          `服务器 "${name}" 已经写进 ${file}，但连接失败：${msg}\n` +
            '配置保留着（不是失败就回退了）—— 你可以在「MCP」设置页里改好参数或把它删掉。',
        )
      }
      return `已接入 MCP 服务器「${name}」，写在 ${file}。它的工具现在就能用。`
    },
  }
}

/**
 * 摘掉一个 MCP 服务器：从配置里删掉，并断开连接、撤掉它的工具。
 *
 * permission 用 'write' 而不是 'exec'：**它不执行任何东西**，只是把一条已有配置删掉并断开。
 * 沿用 exec 会让每次删除都白弹一次「将以你的身份运行」的授权框 —— 那句话对删除是假的。
 *
 * 先摘运行期、后改配置文件：名字不认识时 `removeServer` 会抛，那一步在碰磁盘之前就把
 * 错误的入参挡住了。反过来（先改盘）的话，一个打错的名字会把配置文件改坏还报「成功」。
 */
export function makeMcpRemoveTool(
  mcp: McpAdmin,
  opts: { cwd: string },
): Tool<{ name: string }> {
  return {
    name: 'mcp_remove',
    description:
      '移除一个 MCP 服务器：断开连接、撤掉它的工具，并从配置文件里删掉（下次启动不会再连）。' +
      '用户说「不要那个 MCP 了」时用它。删掉的是整个服务器，不是其中某个工具。',
    permission: 'write',
    // 同 `mcp_add`：摘掉之后那些工具当轮就得从集合里消失，否则 agent 会去调一个已经断开的服务器
    invalidatesTools: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器名，和加进来时用的那个名字一致' },
      },
      required: ['name'],
    },
    summary: (a) => a?.name ?? '',
    async run(args) {
      const name = requireString(args as any, 'name')
      // 运行期那份是**合并之后**的，先问它有没有这个名字 —— 它才是「现在到底有没有在用」的
      // 真相。配置里找不到但运行期有（比如名字是启动后加的）不该被当成不存在
      try {
        await mcp.removeServer(name)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`${msg}（没删任何东西，也没断开任何连接）`)
      }
      const file = removeMcpServerAnywhere(opts.cwd, name)
      return file
        ? `已移除 MCP 服务器「${name}」，并从 ${file} 里删掉了它的配置。`
        : `已断开并移除 MCP 服务器「${name}」，但它不在任何配置文件里（可能是运行时临时加的）。`
    },
  }
}
