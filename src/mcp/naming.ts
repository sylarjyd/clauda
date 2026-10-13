import { createHash } from 'node:crypto'

/**
 * MCP 工具名到后端函数名的映射。
 *
 * 后端的函数名有硬约束（`openai.ts` 会校验 `^[a-zA-Z0-9_-]{1,64}$`），而 MCP 工具名
 * 是服务器自己起的，可能是 `item.get`、`github/search`、中文，随便什么。所以必须消毒。
 *
 * 用双下划线作分隔符是有讲究的：`mcp__filesystem` 这样一条「整个 server」的权限规则，
 * 靠 `tool.name.startsWith(rule + '__')` 就能匹配上（见 `permissions.ts`）。换成单下划线
 * 或冒号，这个白捡的能力就没了。
 */

/** 消毒后仍可能撞名（截断、替换都会），所以真实名字一律以 `buildMcpToolNames` 的映射为准 */
export interface McpToolRef {
  server: string
  tool: string
}

export const MCP_PREFIX = 'mcp__'

const MAX_NAME = 64
/** 截断时尾部留的哈希长度，`_` + 6 位十六进制 */
const HASH_LEN = 6
const ILLEGAL = /[^A-Za-z0-9_-]/g

export function sanitize(part: string): string {
  return part.replace(ILLEGAL, '_')
}

/**
 * 超长就截断，但尾部换成整串内容的哈希 —— 直接 `slice` 会让两个只在尾部不同的长名字
 * 撞成同一个，而 MCP 工具名撞名比名字丑要严重得多。
 */
function fit(raw: string): string {
  if (raw.length <= MAX_NAME) return raw
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, HASH_LEN)
  return raw.slice(0, MAX_NAME - HASH_LEN - 1) + '_' + hash
}

export function mcpToolName(server: string, tool: string): string {
  return fit(`${MCP_PREFIX}${sanitize(server)}__${sanitize(tool)}`)
}

/**
 * 给一批工具分配最终名字，**按传入顺序**返回。
 *
 * 消毒和截断都是不可逆的，所以最终名和服务器上的真实名之间必须有这样一份显式对应，
 * 不能靠反推。撞名时追加 `_2` `_3`。
 */
export function assignMcpToolNames(entries: McpToolRef[]): McpToolRefWithName[] {
  const used = new Set<string>()
  const out: McpToolRefWithName[] = []
  for (const entry of entries) {
    const base = mcpToolName(entry.server, entry.tool)
    let name = base
    let n = 2
    while (used.has(name)) {
      name = fit(`${base}_${n}`)
      n++
    }
    used.add(name)
    out.push({ name, server: entry.server, tool: entry.tool })
  }
  return out
}

export interface McpToolRefWithName extends McpToolRef {
  name: string
}

/** 上者的 Map 视图，按最终名反查真实工具用 */
export function buildMcpToolNames(entries: McpToolRef[]): Map<string, McpToolRef> {
  const out = new Map<string, McpToolRef>()
  for (const e of assignMcpToolNames(entries)) out.set(e.name, { server: e.server, tool: e.tool })
  return out
}

/** 后端接受的名字形状，测试和运行期自检都用它 */
export const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
