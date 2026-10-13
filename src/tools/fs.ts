import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import {
  BINARY_EXTENSIONS,
  DEFAULT_IGNORED_DIRS,
  DEFAULT_IGNORED_FILES,
  matchesGlob,
} from '../util/glob.js'
import { formatBytes, isBinary, numberLines } from '../util/text.js'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  requireStringOrEmpty,
  type Tool,
} from './types.js'

const MAX_READ_LINES = 2000
const MAX_SCAN_FILES = 30_000

function resolve(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

/**
 * 相对 cwd 展示，短一点。
 * 统一用正斜杠：模型拿到的路径和 glob 模式写法一致，Windows 上也不会
 * 出现 `src\a.ts` 这种和 `src/**` 对不上的形式。
 */
function display(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs)
  const chosen = rel && !rel.startsWith('..') ? rel : abs
  return chosen.replace(/\\/g, '/')
}

interface WalkOptions {
  ignoreDirs?: Set<string>
  ignoreFiles?: Set<string>
  signal?: AbortSignal
  maxFiles?: number
}

async function* walk(dir: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORED_DIRS
  const ignoreFiles = opts.ignoreFiles ?? DEFAULT_IGNORED_FILES
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES
  let count = 0
  const stack: string[] = [dir]

  while (stack.length > 0) {
    if (opts.signal?.aborted) return
    const cur = stack.pop()!
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue // 权限不足或目录已消失，跳过
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue
        stack.push(full)
      } else if (e.isFile()) {
        if (ignoreFiles.has(e.name)) continue
        if (++count > maxFiles) return
        yield full
      }
      // 符号链接一律不跟随，避免环
    }
  }
}

// ---------------------------------------------------------------- read_file

interface ReadArgs {
  path: string
  offset?: number
  limit?: number
}

export const readFileTool: Tool<ReadArgs> = {
  name: 'read_file',
  description:
    '读取文件内容，返回带行号的文本（行号以 Tab 分隔，便于后续 edit 定位）。' +
    '默认最多读 2000 行，可用 offset/limit 分段读取大文件。' +
    '不要用它读二进制文件或 node_modules 里的依赖源码。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对当前工作目录或绝对路径' },
      offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      limit: { type: 'number', description: '最多读取的行数，默认 2000' },
    },
    required: ['path'],
  },
  summary: (a) => a?.path ?? '',
  async run(args, ctx) {
    const abs = resolve(ctx.cwd, requireString(args as any, 'path'))
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) throw new Error(`文件不存在：${abs}`)
    if (stat.isDirectory()) throw new Error(`${abs} 是目录，请用 glob 或 grep 列出内容`)

    const buf = await fs.readFile(abs)
    if (isBinary(buf)) {
      throw new Error(`这是二进制文件（${formatBytes(stat.size)}），无法以文本读取`)
    }

    const startLine = Math.max(1, optionalNumber(args as any, 'offset') ?? 1)
    const limit = Math.min(optionalNumber(args as any, 'limit') ?? MAX_READ_LINES, MAX_READ_LINES)

    const lines = buf.toString('utf8').split('\n')
    if (startLine > lines.length) {
      return `文件共 ${lines.length} 行，起始行 ${startLine} 超出范围。`
    }
    const slice = lines.slice(startLine - 1, startLine - 1 + limit)
    const numbered = numberLines(slice.join('\n'), startLine)

    const endLine = startLine + slice.length - 1
    const truncated = endLine < lines.length
    const header = truncated
      ? `（共 ${lines.length} 行，本段 ${startLine}-${endLine}，续读请用 offset=${endLine + 1}）\n`
      : ''
    return header + numbered
  },
}

// --------------------------------------------------------------- write_file

interface WriteArgs {
  path: string
  content: string
}

export const writeFileTool: Tool<WriteArgs> = {
  name: 'write_file',
  description:
    '把内容整体写入文件，父目录不存在会自动创建，同名文件会被覆盖。' +
    '修改已有文件的局部内容请优先用 edit_file —— 整文件覆盖容易丢失你没读到的部分。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  summary: (a) => a?.path ?? '',
  async run(args, ctx) {
    const abs = resolve(ctx.cwd, requireString(args as any, 'path'))
    const content = typeof args.content === 'string' ? args.content : ''
    const existed = fsSync.existsSync(abs)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    const rel = display(ctx.cwd, abs)
    return `${existed ? '已覆盖' : '已创建'} ${rel}（${Buffer.byteLength(content, 'utf8')} 字节，${content.split('\n').length} 行）`
  },
}

// ---------------------------------------------------------------- edit_file

interface EditArgs {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const editFileTool: Tool<EditArgs> = {
  name: 'edit_file',
  description:
    '把文件中的 old_string 精确替换为 new_string。old_string 必须在文件中唯一出现，' +
    '否则会报错——此时请补足上下文使其唯一，或把 replace_all 设为 true 替换全部。' +
    'old_string 要逐字符匹配（含缩进），请先用 read_file 看清原文。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文，需唯一' },
      new_string: { type: 'string', description: '替换后的新内容' },
      replace_all: { type: 'boolean', description: '是否替换所有出现处，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  summary: (a) => a?.path ?? '',
  async run(args, ctx) {
    const abs = resolve(ctx.cwd, requireString(args as any, 'path'))
    const oldStr = requireString(args as any, 'old_string')
    const newStr = requireStringOrEmpty(args as any, 'new_string')
    const replaceAll = optionalBoolean(args as any, 'replace_all') ?? false

    const original = await fs.readFile(abs, 'utf8')
    if (oldStr === newStr) throw new Error('old_string 与 new_string 完全相同，无需修改')

    const first = original.indexOf(oldStr)
    if (first === -1) {
      // 常见失误：缩进或行尾空白对不上，给点线索而不是干巴巴报错
      const hint = original.includes(oldStr.trim())
        ? '（去掉首尾空白后能找到，多半是缩进不一致）'
        : '（在文件中完全找不到，请重新 read_file 确认原文）'
      throw new Error(`old_string 未匹配到内容 ${hint}`)
    }

    const occurrences = countOccurrences(original, oldStr)
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string 在文件中出现了 ${occurrences} 次，无法确定改哪一处。` +
          '请扩大上下文使其唯一，或将 replace_all 设为 true。',
      )
    }

    const updated = replaceAll
      ? original.split(oldStr).join(newStr)
      : original.slice(0, first) + newStr + original.slice(first + oldStr.length)

    await fs.writeFile(abs, updated, 'utf8')

    const rel = display(ctx.cwd, abs)
    const replaced = replaceAll ? occurrences : 1
    return `已修改 ${rel}（替换 ${replaced} 处）\n\n${renderDiff(oldStr, newStr)}`
  },
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * 只做「公共前缀/后缀行裁剪」的轻量 diff —— 足够展示改动点，
 * 又不会像完整 LCS 那样在长文本上炸掉复杂度。
 */
function renderDiff(oldStr: string, newStr: string): string {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const maxShow = 12
  const out: string[] = []
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)

  if (head > 0) out.push(`  ${head} 行未变`)
  for (const l of removed.slice(0, maxShow)) out.push(`- ${l}`)
  if (removed.length > maxShow) out.push(`  ... 还有 ${removed.length - maxShow} 行被删除`)
  for (const l of added.slice(0, maxShow)) out.push(`+ ${l}`)
  if (added.length > maxShow) out.push(`  ... 还有 ${added.length - maxShow} 行新增`)
  if (tail > 0) out.push(`  ${tail} 行未变`)
  return out.join('\n')
}

// -------------------------------------------------------------------- glob

interface GlobArgs {
  pattern: string
  path?: string
}

export const globTool: Tool<GlobArgs> = {
  name: 'glob',
  description:
    '按文件名模式查找文件，返回按修改时间倒序排列的路径。' +
    '支持 `**` 跨目录、`*`、`?`、`{a,b}`。例如 `src/**/*.ts`、`**/*.{json,yml}`。' +
    '只想按内容搜索时用 grep。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 `src/**/*.ts`' },
      path: { type: 'string', description: '搜索根目录，默认当前工作目录' },
    },
    required: ['pattern'],
  },
  summary: (a) => a?.pattern ?? '',
  async run(args, ctx) {
    const pattern = requireString(args as any, 'pattern')
    const root = resolve(ctx.cwd, optionalString(args as any, 'path') ?? '.')

    const hits: { abs: string; mtime: number }[] = []
    for await (const file of walk(root, { signal: ctx.signal })) {
      const rel = path.relative(root, file).replace(/\\/g, '/')
      if (!matchesGlob(pattern, rel)) continue
      const stat = await fs.stat(file).catch(() => null)
      if (stat) hits.push({ abs: file, mtime: stat.mtimeMs })
      if (hits.length >= 300) break
    }

    if (hits.length === 0) return `没有匹配 \`${pattern}\` 的文件（搜索根目录：${display(ctx.cwd, root)}）`

    hits.sort((a, b) => b.mtime - a.mtime)
    const shown = hits.slice(0, 100)
    const lines = shown.map((h) => display(ctx.cwd, h.abs))
    const more = hits.length > shown.length ? `\n... 仅显示前 ${shown.length} 个，共 ${hits.length} 个` : ''
    return lines.join('\n') + more
  },
}

// -------------------------------------------------------------------- grep

type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

interface GrepArgs {
  pattern: string
  path?: string
  glob?: string
  output_mode?: GrepOutputMode
  case_insensitive?: boolean
  head_limit?: number
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  description:
    '用正则表达式在文件内容中搜索（纯 JS 实现，语法为 JS RegExp，不是 PCRE）。' +
    'output_mode: content 返回匹配行（带行号），files_with_matches 只返回文件路径，count 返回每个文件的命中数。' +
    '可用 glob 限定文件类型，如 `*.ts`。自动跳过 node_modules、.git、dist 等目录。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式，如 `function\\s+\\w+`' },
      path: { type: 'string', description: '搜索根目录或单个文件，默认当前工作目录' },
      glob: { type: 'string', description: '文件过滤，如 `*.ts` 或 `src/**/*.ts`' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: '默认 files_with_matches',
      },
      case_insensitive: { type: 'boolean', description: '忽略大小写' },
      head_limit: { type: 'number', description: '最多返回多少条结果，默认 100' },
    },
    required: ['pattern'],
  },
  summary: (a) => `/${a?.pattern ?? ''}/`,
  async run(args, ctx) {
    const pattern = requireString(args as any, 'pattern')
    const root = resolve(ctx.cwd, optionalString(args as any, 'path') ?? '.')
    const fileGlob = optionalString(args as any, 'glob')
    const mode: GrepOutputMode = (args.output_mode as GrepOutputMode) ?? 'files_with_matches'
    const headLimit = Math.max(1, Math.min(optionalNumber(args as any, 'head_limit') ?? 100, 1000))

    let re: RegExp
    try {
      re = new RegExp(pattern, optionalBoolean(args as any, 'case_insensitive') ? 'i' : '')
    } catch (e) {
      throw new Error(`正则表达式无效：${(e as Error).message}`)
    }

    const stat = await fs.stat(root).catch(() => null)
    if (!stat) throw new Error(`路径不存在：${root}`)

    const files: string[] = []
    if (stat.isFile()) {
      files.push(root)
    } else {
      for await (const f of walk(root, { signal: ctx.signal })) {
        if (fileGlob && !matchesGlob(fileGlob, path.relative(root, f).replace(/\\/g, '/'))) continue
        files.push(f)
      }
    }

    const contentOut: string[] = []
    const fileHits: string[] = []
    const counts: string[] = []
    let totalMatches = 0

    for (const file of files) {
      if (ctx.signal.aborted) break
      if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
      let text: string
      try {
        const buf = await fs.readFile(file)
        if (isBinary(buf)) continue
        text = buf.toString('utf8')
      } catch {
        continue
      }
      if (!re.test(text)) continue

      const rel = display(ctx.cwd, file)
      const lines = text.split('\n')
      let fileCount = 0
      const matchedLines: string[] = []
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i])) {
          fileCount++
          if (mode === 'content') matchedLines.push(`${rel}:${i + 1}:${lines[i]}`)
        }
      }
      if (fileCount === 0) continue

      totalMatches += fileCount
      if (mode === 'files_with_matches') fileHits.push(rel)
      else if (mode === 'count') counts.push(`${rel}: ${fileCount}`)
      else {
        for (const l of matchedLines) {
          if (contentOut.length >= headLimit) break
          contentOut.push(l)
        }
      }
      if (mode === 'files_with_matches' && fileHits.length >= headLimit) break
      if (mode === 'count' && counts.length >= headLimit) break
      if (mode === 'content' && contentOut.length >= headLimit) break
    }

    if (totalMatches === 0) return `没有匹配 \`${pattern}\` 的内容`

    if (mode === 'content') {
      const more = totalMatches > contentOut.length ? `\n... 共 ${totalMatches} 处命中，仅显示前 ${contentOut.length} 处` : ''
      return contentOut.join('\n') + more
    }
    if (mode === 'count') return counts.join('\n')
    return fileHits.join('\n')
  },
}
