import type { ClaudaConfig } from '../config.js'

/**
 * 把底层异常翻译成用户能照着做点什么的话。
 *
 * OpenAI SDK 的顶层 message 往往只有一句 "Connection error."，真正的原因
 * （ECONNREFUSED / ENOTFOUND）藏在 cause 链里，所以要一路翻下去。
 */
export function describeError(err: unknown, config?: ClaudaConfig): string {
  const e = err as { status?: number; message?: string; code?: string; cause?: unknown }
  const text = collectText(err)
  const base = e?.message ?? String(err)
  const endpoint = config ? `当前接口地址为 ${config.provider.baseUrl}` : ''

  if (e?.status === 401 || e?.status === 403) {
    return `认证失败（HTTP ${e.status}）。请检查 API Key 是否有效。${endpoint}`
  }
  if (e?.status === 404) {
    return `接口返回 404。请确认接口地址是否正确，大多数 OpenAI 兼容服务需要以 /v1 结尾。${endpoint}`
  }
  if (e?.status === 429) {
    return '触发限流（HTTP 429）。稍等片刻再试，或换用其他模型。'
  }
  if (/ECONNREFUSED/i.test(text)) {
    return `连接被拒绝。请确认服务已启动且地址端口正确。${endpoint}`
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return `域名解析失败。请检查网络与接口地址拼写。${endpoint}`
  }
  if (/ETIMEDOUT|timeout/i.test(text)) {
    return `请求超时。可能是网络问题，或服务端在长时间无响应。${endpoint}`
  }
  if (/Connection error/i.test(text)) {
    return `无法建立连接。请确认服务是否可访问。${endpoint}`
  }
  if (/socket hang up|premature close|ECONNRESET/i.test(text)) {
    return '连接被中途断开。可能是网络抖动或服务端重启，重试一次通常能好。'
  }
  return base
}

/** 顺着 cause 链把 message / code 都拼起来，用于模式匹配 */
function collectText(err: unknown): string {
  const parts: string[] = []
  let cur = err as { message?: string; code?: string; cause?: unknown } | undefined
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur.message) parts.push(String(cur.message))
    if (cur.code) parts.push(String(cur.code))
    cur = cur.cause as typeof cur
  }
  return parts.join(' | ')
}
