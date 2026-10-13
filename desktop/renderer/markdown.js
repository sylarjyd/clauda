/**
 * 最小 markdown → HTML。刻意只支持模型实际会写的那几种：围栏代码块、行内代码、
 * 粗体、一~三级标题、无序列表。
 *
 * **安全上只有一条规矩：先整段转义，再往上套标签。** 模型输出是不可信内容
 * （它可能照抄了用户仓库里某个文件的正文），这里又直接 `innerHTML` 出去，
 * 顺序反了就是一个 XSS。所以任何新增语法都必须在转义**之后**处理 ——
 * 别为了「少转义一点」开后门。
 *
 * 代价是代码块和行内代码得先用占位符摘出来，否则里面的 `**` / `#` 会被当成语法。
 * 占位符借 NUL / SOH 两个控制字符。**输入里要先把这两个字符删掉**：`escape` 不动它们，
 * 所以「转义过的正文里不可能出现」这句本身不成立 —— 模型直接吐一个 ` 0 ` 就能伪造出
 * 一个占位符。伪造的后果只是内容被重复或挪位置（换进去的 `blocks[i]` / `codes[i]` 都是
 * 转义过的字符串，注不进标签），但这套保证是靠占位符的唯一性撑着的，前提不成立就不该留。
 */

const BLOCK_MARK = '\u0000'
const CODE_MARK = '\u0001'
const BLOCK_LINE_RE = new RegExp(`^${BLOCK_MARK}(\\d+)${BLOCK_MARK}$`)
const CODE_RE = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g')

export function markdown(src) {
  const text = escape(String(src ?? '').replace(/[\u0000\u0001]/g, ''))
  const blocks = []

  // 先把围栏代码块整个摘走，正文里只留一个占位符
  const body = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`)
    return `${BLOCK_MARK}${blocks.length - 1}${BLOCK_MARK}`
  })

  const out = []
  let list = null
  const flushList = () => {
    if (!list) return
    out.push(`<ul>${list.join('')}</ul>`)
    list = null
  }

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    const placeholder = BLOCK_LINE_RE.exec(line.trim())
    if (placeholder) {
      flushList()
      out.push(blocks[Number(placeholder[1])])
      continue
    }
    if (!line.trim()) {
      flushList()
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list) list = []
      list.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    flushList()
    out.push(`<p>${inline(line)}</p>`)
  }
  flushList()

  return out.join('\n')
}

/** 行内规则。`inline code` 同样要先摘出来，不然里面的 `**` 会被加粗 */
function inline(text) {
  const codes = []
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return out.replace(CODE_RE, (_, i) => `<code>${codes[Number(i)]}</code>`)
}

function escape(text) {
  // `&` 必须最先换，否则会把后面换出来的实体再转一遍（`&lt;` 变成 `&amp;lt;`）
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
