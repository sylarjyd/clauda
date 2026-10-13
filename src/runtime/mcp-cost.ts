import type { McpServerStatus } from '../mcp/manager.js'
import type { Tool } from '../tools/types.js'

/** 只要这三个方法，好让这段逻辑不依赖真的 `McpManager`（它会起子进程） */
export interface McpCostSource {
  tokenHint(): number
  status(): McpServerStatus[]
  tools(): Tool[]
}

export interface McpCostNotice {
  tokens: number
  /** 只数连上的服务器 —— failed 的没占上下文，算进去会误导 */
  servers: number
  tools: number
  /** 已接入的提示。没有 MCP 工具时是空串 */
  infoText: string
  /** 占比过高的告警。未超阈值时是空串 */
  warnText: string
}

/** 超过这个比例就告警：schema 每轮都要付，占掉四分之一已经会明显提前触发压缩 */
const WARN_RATIO = 0.25

/**
 * MCP 工具的上下文开销提示。CLI（`index.ts`）和桌面端共用。
 *
 * **只返回纯文本，不带任何 ANSI 转义** —— 终端那边自己用 `style` 包一层颜色，
 * 桌面端要的是能直接进 DOM 的字符串。混进转义码的话桌面端会显示成一堆乱码。
 */
export function mcpCostNotice(mcp: McpCostSource, contextWindow: number): McpCostNotice {
  const tokens = mcp.tokenHint()
  const servers = mcp.status().filter((s) => s.state === 'connected').length
  const tools = mcp.tools().length

  if (tokens <= 0) return { tokens, servers, tools, infoText: '', warnText: '' }

  const infoText = `已接入 MCP：${servers} 个服务器 / ${tools} 个工具，约 +${tokens} token 上下文`
  const warnText =
    tokens > WARN_RATIO * contextWindow
      ? `MCP 工具的 schema 已经占掉上下文窗口的 ${Math.round((tokens / contextWindow) * 100)}%，` +
        '会明显提前触发压缩。用 /mcp off <名字> 摘掉暂时不用的。'
      : ''

  return { tokens, servers, tools, infoText, warnText }
}
