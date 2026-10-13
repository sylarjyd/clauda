import fs from 'node:fs'
import path from 'node:path'
import { claudaHome } from '../config.js'
import { parseFrontmatter } from './frontmatter.js'
import type { SkillMeta } from './types.js'

export const SKILL_FILENAME = 'SKILL.md'

/**
 * 技能名要能直接当斜杠命令敲，所以限制在一个保守的字符集里。
 * 名字不合规时退回目录名，而不是把这个技能丢掉 —— 内容还在，只是名字换了。
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const MAX_DESCRIPTION = 200

/**
 * 技能发现顺序（后扫到的覆盖先扫到的）：
 *   1. `~/.clauda/skills/*\/SKILL.md` —— 全局技能
 *   2. 从最外层祖先目录到 cwd 的 `.clauda/skills/*\/SKILL.md`
 *
 * 也就是**离 cwd 越近越优先**，和「更具体的配置压过更通用的」直觉一致。
 *
 * 注意这与 CLAUDA.md 的排序方向相反：那边全局排在最后、被当作更权威，
 * 因为项目记忆是拼成一段文本喂给模型读的（靠后≈更新）。技能是按名查找而非拼接，
 * 两者语义本就不同，别当成不一致去「统一」。
 */
export class SkillRegistry {
  private constructor(private readonly skills: SkillMeta[]) {}

  static discover(cwd: string): SkillRegistry {
    const byName = new Map<string, SkillMeta>()

    const scan = (root: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        return // 目录不存在或没权限，跳过
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const file = path.join(root, e.name, SKILL_FILENAME)
        if (!fs.existsSync(file)) continue
        const meta = readMeta(file, e.name)
        if (meta) byName.set(meta.name, meta)
      }
    }

    scan(path.join(claudaHome(), 'skills'))

    const chain: string[] = []
    let dir = path.resolve(cwd)
    for (;;) {
      chain.push(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const d of chain.reverse()) scan(path.join(d, '.clauda', 'skills'))

    return new SkillRegistry([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }

  list(): SkillMeta[] {
    return this.skills
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.find((s) => s.name === name)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** 取技能正文（已剥掉 frontmatter）。读不到返回 null，由调用方决定怎么提示 */
  read(name: string): string | null {
    const meta = this.get(name)
    if (!meta) return null
    try {
      return parseFrontmatter(fs.readFileSync(meta.file, 'utf8')).body
    } catch {
      return null
    }
  }
}

function readMeta(file: string, dirName: string): SkillMeta | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null // 读不了就跳过，不值得为一个坏技能中断会话
  }

  const { data, body } = parseFrontmatter(raw)

  const declared = (data.name ?? '').trim().toLowerCase()
  const name = NAME_RE.test(declared) ? declared : slugify(dirName)
  if (!NAME_RE.test(name)) return null

  const description = (data.description ?? '').trim() || firstMeaningfulLine(body)
  return {
    name,
    description: truncate(description, MAX_DESCRIPTION),
    dir: path.dirname(file),
    file,
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 没写 description 时的兜底：拿正文第一句有意义的话顶上 */
function firstMeaningfulLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue // 标题只是复述名字，当描述没信息量
    return t.replace(/^[-*]\s+/, '')
  }
  return ''
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
