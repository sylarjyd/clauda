/** 文本处理的零散工具 */

/**
 * 粗略估算 token 数。
 * 中日韩字符约 1 字 1 token，拉丁文约 4 字符 1 token，取折中系数。
 * 只用于决定何时触发压缩，不需要精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、假名、谚文
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++
    }
  }
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  const omitted = text.length - maxChars
  return (
    text.slice(0, head) +
    `\n\n... [已省略 ${omitted} 个字符] ...\n\n` +
    text.slice(text.length - tail)
  )
}

/**
 * 按 token 预算截断，保留头尾、砍掉中间。
 *
 * 工具结果按「行数」或「字符数」截断都不靠谱：同样 2000 行，代码和中文说明的
 * token 数能差好几倍。这里二分出满足预算的字符长度，保证估算值确实落在预算内。
 */
export function capByTokens(
  text: string,
  maxTokens: number,
  hint = '',
): { text: string; truncated: boolean; omittedChars: number } {
  if (maxTokens <= 0 || estimateTokens(text) <= maxTokens) {
    return { text, truncated: false, omittedChars: 0 }
  }

  const notice = (omitted: number) =>
    `\n\n... [已省略 ${omitted} 个字符：超出单次工具结果上限] ...` +
    (hint ? `\n提示：${hint}` : '')

  // 提示语本身也占预算。省略的字数位数会撑长这句，按最坏情况（整个文本都被省略）
  // 留出余量，否则截完还会超出一两个 token。
  const budget = Math.max(1, maxTokens - estimateTokens(notice(text.length)))
  const head = (keep: number) => Math.floor(keep * 0.6)
  const build = (keep: number) => text.slice(0, head(keep)) + text.slice(text.length - (keep - head(keep)))

  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(build(mid)) <= budget) lo = mid
    else hi = mid - 1
  }

  return {
    text: text.slice(0, head(lo)) + notice(text.length - lo) + text.slice(text.length - (lo - head(lo))),
    truncated: true,
    omittedChars: text.length - lo,
  }
}

export function truncateLines(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  }
}

export function safeJsonParse<T = unknown>(
  raw: string,
  fallback: T,
): { value: T; error?: string } {
  if (!raw || !raw.trim()) return { value: fallback }
  try {
    return { value: JSON.parse(raw) as T }
  } catch (e) {
    return { value: fallback, error: (e as Error).message }
  }
}

/** 把多行字符串前缀上 `cat -n` 风格的行号 */
export function numberLines(text: string, startLine = 1): string {
  const lines = text.split('\n')
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((l, i) => `${String(startLine + i).padStart(width, ' ')}\t${l}`)
    .join('\n')
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
