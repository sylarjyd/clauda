/**
 * 最小 YAML frontmatter 解析器 —— 只认 SKILL.md 用得到的那点语法。
 *
 * 为了读 `name` / `description` 两个标量引一整个 YAML 库不划算，而 frontmatter
 * 写得花哨也不该让技能消失，所以这里的策略是「看不懂就当没有」，绝不抛异常。
 *
 * 明确不支持（遇到就按字面文本收下或跳过该行）：嵌套 map、列表值、块标量（`|` `>`）、
 * 多行值、行内 `#` 注释、锚点/别名、类型转换（值一律是字符串）。重复键后者覆盖前者。
 */

export interface Frontmatter {
  data: Record<string, string>
  body: string
}

const FENCE = '---'
const KEY_VALUE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/

export function parseFrontmatter(raw: string): Frontmatter {
  // 剥 BOM 用码点判断而不是把 BOM 写进正则字面量：后者在编辑器里完全不可见，
  // 一旦被谁「清理空白」删掉就静默失效，而这样写永远看得见。
  // 顺带归一化 CRLF —— Windows 上手写的 SKILL.md 十有八九是 CRLF。
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (lines[start]?.trim() !== FENCE) return { data: {}, body: text }

  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      end = i
      break
    }
  }
  // 围栏没闭合，当成「没有 frontmatter」更安全：否则正文会被整段吞掉
  if (end === -1) return { data: {}, body: text }

  const data: Record<string, string> = {}
  for (let i = start + 1; i < end; i++) {
    const m = KEY_VALUE.exec(lines[i])
    if (m) data[m[1]] = unquote(m[2].trim())
  }

  return { data, body: lines.slice(end + 1).join('\n').trim() }
}

function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v[v.length - 1]) {
    return v.slice(1, -1)
  }
  return v
}
