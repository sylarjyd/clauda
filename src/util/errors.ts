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
    // 两个 404 的常见来源，都会在换厂商时撞上：地址的**路径前缀**不对，或者模型名在
    // 这个端点上根本不存在（拿 gpt-4o-mini 去问 DeepSeek 就是这一类）
    return `接口返回 404。请确认接口地址与模型名都对得上：路径各家不同 —— 百炼是 /compatible-mode/v1、方舟是 /api/v3、智谱是 /api/paas/v4，不是一律 /v1；模型名也要是这一家的。${endpoint}`
  }
  if (e?.status === 400) {
    // 400 的原因很多，但**这个应用自己**能造出来的那一种高度集中：带图的消息发给了
    // 不支持图片输入的端点（内置的那些厂商里，纯文本端点才是多数）。不点名的话用户
    // 只会看到 SDK 转述的一段原始报文，然后怀疑是自己操作错了。
    //
    // 刻意**不做「哪家厂商支持视觉」的能力表**：各家的说法变得比 models 列表还快，
    // 写死了就会像上一轮的 Kimi 型号那样变成一条假信息。让端点自己拒，我们把话翻对。
    return `接口返回 400（请求被拒）。刚发过图片的话，多半是这个端点不支持图片输入 —— 换一个多模态模型，或者改用文字把图里的信息描述出来。${endpoint}`
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
