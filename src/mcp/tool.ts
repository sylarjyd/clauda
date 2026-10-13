import type { CallToolResult } from '@modelcontextprotocol/client'
import type { JSONSchema, ToolPermission } from '../types.js'
import { truncateMiddle } from '../util/text.js'
import type { Tool } from '../tools/types.js'

/** 调一次 MCP 工具，由 McpManager 提供 —— 工具本身不持有连接，连接的生命周期只有一处 */
export type McpCaller = (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>

/**
 * 把一个 MCP 工具包成 clauda 的 `Tool`。
 *
 * 传 `call` 回调而不是 Client 实例：一是单测能不起真服务器就验证拍平逻辑，
 * 二是连接归 McpManager 独占，工具拿着连接迟早会拿到一个已经关掉的。
 */
export function makeMcpTool(opts: {
  /** 后端侧的函数名，已经消毒过 */
  name: string
  /** 服务器上的真实工具名，调用时要还原回去 */
  remoteName: string
  server: string
  description?: string
  inputSchema: unknown
  permission: ToolPermission
  call: McpCaller
}): Tool {
  return {
    name: opts.name,
    description: opts.description?.trim() || `MCP 服务器 ${opts.server} 提供的工具 ${opts.remoteName}`,
    parameters: toJsonSchema(opts.inputSchema),
    permission: opts.permission,
    source: { kind: 'mcp', server: opts.server, tool: opts.remoteName },
    summary: (args) => {
      const s = safeJson(args)
      return s === '{}' ? '' : truncateMiddle(s, 80)
    },
    async run(args) {
      const result = await opts.call(opts.remoteName, (args ?? {}) as Record<string, unknown>)
      const text = flatten(result)
      // isError 是「工具跑了但失败了」，返回错误文本而不是抛异常 —— 让模型看见失败
      // 并自我纠正，这才是 MCP 定义 isError 的本意。抛异常会被 agent 循环统一转成
      // 「错误：…」，模型看不出这是服务器说的还是 clauda 自己拦的。
      return result.isError ? `错误：${text || '工具执行失败，未返回详情'}` : text
    },
  }
}

/**
 * clauda 的 `JSONSchema` 要求 `type: 'object'` 且 `properties` 必填，MCP 的 schema 类型上
 * 也是这么声明的（v2 SDK 在解析 `tools/list` 时就会强校验，服务器漏写会整个被拒）。
 *
 * 所以这里正常情况是**原样透传**，补默认值只是兜底：万一哪天 SDK 放松了校验，
 * 我们要的是少一个字段而不是整个服务器的工具都装不上。其余键（`required`、
 * `additionalProperties` 等）一律保留。
 */
function toJsonSchema(input: unknown): JSONSchema {
  const s = (input ?? {}) as Record<string, unknown>
  const properties = (s.properties ?? {}) as Record<string, unknown>
  return { ...s, type: 'object', properties }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return ''
  }
}

/**
 * `content` 是块数组，拍成一段文本给模型。
 *
 * 图片和音频只留占位符：clauda 是纯文本 CLI，把 base64 内联进对话除了烧 token 没有任何用处
 * —— 一个 4KB 的截图编码后就是几千 token，而模型反正也「看」不到它。
 * 结构化结果（`structuredContent`）同理，序列化后附在末尾，让模型至少能拿到数据。
 */
export function flatten(result: CallToolResult): string {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push(`[图片内容，已省略：${block.mimeType}]`)
        break
      case 'audio':
        parts.push(`[音频内容，已省略：${block.mimeType}]`)
        break
      case 'resource_link':
        parts.push(`[资源] ${block.name}${block.mimeType ? ` (${block.mimeType})` : ''} ${block.uri}`)
        break
      case 'resource':
        // 二进制资源只有 blob，没法塞进文本对话，退回给个 uri 让模型自己决定要不要读
        parts.push('text' in block.resource ? block.resource.text : `[资源] ${block.resource.uri}`)
        break
    }
  }

  const structured = result.structuredContent
  if (structured !== undefined && structured !== null) {
    const json = safeJson(structured)
    // content 已经有同样的文本时就不再重复一遍，省 token
    if (json && json !== '{}' && !parts.some((p) => p.includes(json))) {
      parts.push(json)
    }
  }

  return parts.join('\n').trim()
}
