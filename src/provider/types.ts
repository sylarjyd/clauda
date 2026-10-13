import type { ToolCall, ToolSpec, Usage, WireMessage } from '../types.js'

export interface StreamOptions {
  messages: WireMessage[]
  tools: ToolSpec[]
  model: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export type StreamEvent =
  | { type: 'text'; text: string }
  /** 一个完整的工具调用参数拼装完毕后才发出 */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string | null }

export interface Provider {
  readonly model: string
  stream(opts: StreamOptions): AsyncGenerator<StreamEvent>
}

/** 判断错误是否值得重试 */
export function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string }
  if (e?.status === 429) return true
  if (typeof e?.status === 'number' && e.status >= 500) return true
  const code = e?.code ?? ''
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true
  const msg = e?.message ?? ''
  return /fetch failed|socket hang up|terminated|premature close/i.test(msg)
}
