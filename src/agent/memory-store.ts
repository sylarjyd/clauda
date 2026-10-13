import fs from 'node:fs'
import path from 'node:path'
import { claudaHome } from '../config.js'
import { parseFrontmatter } from '../skills/frontmatter.js'

/**
 * 记忆库：模型在会话里**自己学到**的事实，跨会话复用。
 *
 * 和 `CLAUDA.md` 是两套东西，别混：
 *   - `CLAUDA.md` —— 人写、项目级、全文注入。用户显式认可的约定。
 *   - 记忆库    —— 模型写、全局、**只注入索引**。正文靠 `memory_read` 按需取。
 *
 * 索引是**扫目录扫出来的**，不维护 `MEMORY.md` 之类的索引文件：手写索引迟早会和目录
 * 内容漂移，而目录本身才是真值。要给人看的话，`/memories` 随时现算一份就够。
 */

/** 类别决定这条事实是关于谁的，也提示了它该不该长期留着 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryMeta {
  name: string
  description: string
  type: MemoryType
  file: string
}

export interface MemoryIndex {
  entries: MemoryMeta[]
  /** 目录里实际有多少篇。超过 MAX_MEMORIES 时 entries 会被截断 */
  total: number
}

/** 记忆名既要当文件名又要当工具参数，沿用技能那套保守字符集 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const MAX_DESCRIPTION = 200

/** 常驻注入的索引不能无限长 */
export const MAX_MEMORIES = 200
/** 单篇正文上限：记忆是一句话量级的事实，写不下的应该拆成几篇 */
export const MAX_BODY_BYTES = 4096

const DEFAULT_TYPE: MemoryType = 'project'

export function memoryDir(): string {
  return path.join(claudaHome(), 'memory')
}

/**
 * 扫目录得出索引。读不了的直接跳过 —— 和 `loadMemory` / 技能发现同一个原则：
 * 坏一个文件不该中断整个会话。
 */
export function listMemories(): MemoryIndex {
  const dir = memoryDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return { entries: [], total: 0 } // 目录还没建，属于正常情况
  }

  const entries: MemoryMeta[] = []
  for (const file of names) {
    const meta = readMeta(path.join(dir, file), path.basename(file, '.md'))
    if (meta) entries.push(meta)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  // total 报的是文件数而不是解析成功数：解析失败的文件也占着目录，
  // 只报成功数会让「明明有 300 篇却说 200 篇」这种困惑没法解释
  return { entries: entries.slice(0, MAX_MEMORIES), total: names.length }
}

export function readMemory(name: string): { meta: MemoryMeta; body: string } | null {
  if (!NAME_RE.test(name)) return null
  // 直接按名字拼路径，不走 listMemories：索引有条数上限，而按名读取不该被上限挡住
  const file = path.join(memoryDir(), `${name}.md`)
  const meta = readMeta(file, name)
  if (!meta) return null
  try {
    const body = parseFrontmatter(fs.readFileSync(file, 'utf8')).body
    return { meta, body: truncateBytes(body, MAX_BODY_BYTES) }
  } catch {
    return null
  }
}

/**
 * 写入一条记忆。同名即覆盖 —— 更新一条已知事实的正常路径就是再写一遍，
 * 留版本历史只会让索引膨胀，而没人会回头看旧版本。
 */
export function writeMemory(input: {
  name: string
  description: string
  type?: string
  body: string
}): { file: string; created: boolean; name: string } {
  const name = slugify(input.name)
  if (!NAME_RE.test(name)) {
    throw new Error(`记忆名 "${input.name}" 无法转成合法 slug（需要 [a-z0-9][a-z0-9-]*，可用英文、数字和短横线）`)
  }

  const body = input.body.trim()
  if (!body) throw new Error('记忆正文不能为空')

  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `记忆正文 ${bytes} 字节，超过 ${MAX_BODY_BYTES} 字节上限。一条记忆只放一个事实，` +
        '内容多的话拆成几条分别写。',
    )
  }

  const file = path.join(memoryDir(), `${name}.md`)
  const created = !fs.existsSync(file)
  const type = normalizeType(input.type)

  // frontmatter 只支持单行 key: value，换行会把格式撑破，所以先压平
  const description = flatten(input.description).slice(0, MAX_DESCRIPTION)
  const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`

  fs.mkdirSync(memoryDir(), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { file, created, name }
}

function readMeta(file: string, fallbackName: string): MemoryMeta | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const { data, body } = parseFrontmatter(raw)

  // 文件名才是真值：它是调用 memory_read 时唯一稳定的标识。
  // frontmatter 里的 name 只在文件名不合规时才用来救场。
  const fromFile = slugify(fallbackName)
  const declared = slugify(data.name ?? '')
  const name = NAME_RE.test(fromFile) ? fromFile : NAME_RE.test(declared) ? declared : ''
  if (!name) return null

  return {
    name,
    description: truncate(flatten(data.description ?? '').trim() || firstMeaningfulLine(body), MAX_DESCRIPTION),
    type: normalizeType(data.type),
    file,
  }
}

function normalizeType(v: string | undefined): MemoryType {
  const t = (v ?? '').trim().toLowerCase()
  return (MEMORY_TYPES as readonly string[]).includes(t) ? (t as MemoryType) : DEFAULT_TYPE
}

/** 压平换行，免得撑破 frontmatter 的单行格式 */
function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    return t.replace(/^[-*]\s+/, '')
  }
  return ''
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** UTF-8 起始字节 → 该序列总长。孤立的续字节按 1 处理，交给解码器出替换字符 */
function seqLength(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xf0) return 4
  if (lead >= 0xe0) return 3
  if (lead >= 0xc0) return 2
  return 1
}

function truncateBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s

  // 按字节切会把多字节字符劈开，所以要退到一个完整的字符边界。
  // 不能简单地「丢尾部续字节」——**完整字符的末字节同样满足 10xxxxxx**，
  // 那样会一路把前面所有字符都吃掉，最后只剩开头几个 ASCII 字符。
  // 正确做法是从后往前逐个序列地判断：这个序列整个落在切点之内吗？不是就丢掉它再试。
  let end = max
  while (end > 0) {
    let start = end - 1
    while (start > 0 && (buf[start] & 0xc0) === 0x80) start-- // 退到起始字节
    if (start + seqLength(buf[start]) <= end) break
    end = start
  }
  return buf.subarray(0, end).toString('utf8') + '\n…（已截断）'
}
