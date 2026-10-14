import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudaHome } from '../config.js'
import { parseFrontmatter } from './frontmatter.js'
import type { SkillMeta } from './types.js'

export const SKILL_FILENAME = 'SKILL.md'

/**
 * 技能名要能直接当斜杠命令敲，所以限制在一个保守的字符集里。
 * 名字不合规时退回目录名，而不是把这个技能丢掉 —— 内容还在，只是名字换了。
 *
 * `skills/writer.ts` 也用它校验「要新建的名字」，所以导出：两边各写一份正则，
 * 迟早出现「界面收下了、扫的时候又认不出」那种最难查的分歧。
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
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
  /** 扫描基准目录。**存下来**是为了 `refresh()` 能在原地重扫，见那里的注释 */
  private skills: SkillMeta[]

  private constructor(
    private readonly cwd: string,
    skills: SkillMeta[],
  ) {
    this.skills = skills
  }

  static discover(cwd: string): SkillRegistry {
    return new SkillRegistry(cwd, scanAll(cwd))
  }

  /**
   * 原地重扫。
   *
   * 注册表原先是**打开项目那一刻的一次性快照**。技能现在可以在设置页里、
   * 也可以在对话里新建和删除（`skills/writer.ts`），不重扫的话 `list()` 和靠它拼出来的
   * 「## 可用技能」会永远停在旧名单上 —— 新技能当场用不了，删掉的还留在提示词里。
   *
   * 和记忆那边对齐：`listMemories()` 就是每次重扫目录的。
   */
  refresh(): void {
    this.skills = scanAll(this.cwd)
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

/**
 * 扫出一份名单。顺序见类注释：全局先扫，再从最外层祖先扫到 cwd，**后者覆盖前者**。
 *
 * 从 `discover` 里提出来是因为 `refresh()` 要跑同一套 —— 两处各写一遍的话，
 * 「刷新出来的名单」和「首次发现的名单」迟早不一致。
 */
function scanAll(cwd: string): SkillMeta[] {
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

  /**
   * 路径归一：先 realpath，再按平台决定折不折大小写。
   *
   * realpath 不只是解 `..` —— 它在 Windows 上还会把 8.3 短名换成全名，而这一步是必需的：
   * `os.tmpdir()` 给出来的是 `C:\Users\ADMINI~1\AppData\Local\Temp\...`，于是祖先链上的
   * 家目录写作 `C:\Users\ADMINI~1`，和 `os.homedir()` 的 `C:\Users\Administrator` 字符串
   * 根本不等 —— 同一个文件夹被当成两处，下面那条「跳过家目录」就白写了（实测踩到过）。
   *
   * 大小写是另一半：不敏感的文件系统上 `C:\Users` 和 `c:\users` 是一处，得归一。别的
   * 平台只做 realpath，那边大小写是两回事。
   */
  const canon = (p: string): string => {
    const full = path.resolve(p)
    let real = full
    try {
      // 必须是 `.native`：普通 `fs.realpathSync` 只是把路径规整一下，**不展开 8.3 短名**
      // （实测 `realpathSync('C:/Users/ADMINI~1')` 原样返回，`.native` 才给出全名）。
      // 走系统调用的那个才是上面说的那一步。
      real = fs.realpathSync.native(full)
    } catch {
      // 拼出来的路径大多不存在（每个祖先下面都要有个 `.clauda/skills` 才怪），realpath
      // 会抛 —— 那就用拼出来的那份，反正它和别的路径也不会撞
    }
    return process.platform === 'win32' ? real.toLowerCase() : real
  }

  /** 同一个物理目录只扫一次。claudaHome() 自己可能就在 cwd 的祖先链上，不去重就扫两遍 */
  const seen = new Set<string>()
  const scanOnce = (root: string): void => {
    const key = canon(root)
    if (seen.has(key)) return
    seen.add(key)
    scan(root)
  }

  scanOnce(path.join(claudaHome(), 'skills'))

  const chain: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    chain.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  /**
   * 家目录**不算项目祖先**：那里的 `.clauda` 是全局配置目录，不是哪个项目的。
   *
   * 不排除的话，cwd 落在主目录下时 `~/.clauda/skills` 会从两条路各进来一次 —— 一次是
   * claudaHome() 那份，一次是「上层项目的 `.clauda/skills`」。正常用起来没差别（同名
   * 去重），但它让「CLAUDA_HOME 指向哪儿就用哪儿的技能」这条不成立：把 home 指到别处
   * 想造一个零技能环境时，真主目录的技能照样溜进来，而那种环境正是测试要的。
   */
  const home = canon(os.homedir())
  for (const d of chain.reverse()) {
    if (canon(d) === home) continue
    scanOnce(path.join(d, '.clauda', 'skills'))
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
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
