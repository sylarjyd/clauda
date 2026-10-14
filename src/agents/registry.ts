import fs from 'node:fs'
import path from 'node:path'
import { claudaHome, type PermissionMode } from '../config.js'
import { parseFrontmatter } from '../skills/frontmatter.js'
import { NAME_RE } from '../skills/registry.js'
import type { AgentMeta, ResolvedAgent } from './types.js'

export const AGENT_FILENAME = 'AGENT.md'
const MAX_DESCRIPTION = 200
/** 温度的合理区间。越界当作没写，而不是丢掉整条智能体 —— 一个温度写错了不该让一份好好的提示词用不了 */
const MAX_TEMPERATURE = 2

/**
 * 智能体发现顺序（后扫到的覆盖先扫到的）：
 *   1. `~/.clauda/agents/*\/AGENT.md` —— 全局智能体
 *   2. 从最外层祖先目录到 cwd 的 `.clauda/agents/*\/AGENT.md`
 *
 * 也就是**离 cwd 越近越优先**，和技能那边的规则一模一样（`skills/registry.ts` 那条注释
 * 解释得更细）。两边故意各留一份实现而不是抽公共扫描器：技能和智能体是两套独立的命名空间，
 * 将来任一边加一条自己的规则（比如智能体要认 `scope`）都会把公共的那份拧成四不像。
 */
export class AgentRegistry {
  private agents: AgentMeta[]
  /** 扫描基准目录。**存下来**是为了 `refresh()` 能在原地重扫 */
  private readonly cwd: string

  private constructor(cwd: string, agents: AgentMeta[]) {
    this.cwd = cwd
    this.agents = agents
  }

  static discover(cwd: string): AgentRegistry {
    return new AgentRegistry(cwd, scanAll(cwd))
  }

  /**
   * 原地重扫。理由和技能那边一模一样：设置页里刚建的智能体，不重扫的话当场开不了会话
   * —— 下拉框里没有它。
   */
  refresh(): void {
    this.agents = scanAll(this.cwd)
  }

  list(): AgentMeta[] {
    return this.agents
  }

  get(name: string): AgentMeta | undefined {
    return this.agents.find((a) => a.name === name)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /**
   * 读出**可装配的一整份**（含正文）。名字找不到返回 `null`，由调用方决定怎么提示
   * —— 建会话时找不到**不抛**：一个删掉的智能体不该让自动恢复的会话打不开。
   */
  resolve(name: string): ResolvedAgent | null {
    const meta = this.get(name)
    if (!meta) return null
    try {
      const { body } = parseFrontmatter(fs.readFileSync(meta.file, 'utf8'))
      return { ...meta, body }
    } catch {
      return null // 读不了就当作没有，不值得为一个坏文件中断会话
    }
  }
}

/**
 * 扫出一份名单。顺序见类注释：全局先扫，再从最外层祖先扫到 cwd，**后者覆盖前者**。
 *
 * 从 `discover` 里提出来是因为 `refresh()` 要跑同一套 —— 两处各写一遍的话，
 * 「刷新出来的名单」和「首次发现的名单」迟早不一致。
 */
function scanAll(cwd: string): AgentMeta[] {
  const byName = new Map<string, AgentMeta>()

  const scan = (root: string, scope: 'global' | 'project'): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return // 目录不存在或没权限，跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const file = path.join(root, e.name, AGENT_FILENAME)
      if (!fs.existsSync(file)) continue
      const meta = readMeta(file, e.name, scope)
      if (meta) byName.set(meta.name, meta)
    }
  }

  scan(path.join(claudaHome(), 'agents'), 'global')

  const chain: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    chain.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const d of chain.reverse()) scan(path.join(d, '.clauda', 'agents'), 'project')

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 读一条 `AGENT.md` 的 frontmatter。
 *
 * **校验的取向和技能一致：能退回默认的就退回并继续，不能退的才丢。** 具体见 `types.ts`
 * 的字段注释与 `CLAUDA.md` 的降级规则表 —— 关键是两条：
 * - 名字不合规 → 退回目录名；目录名也不合规 → **整条丢掉**（名字要当目录名用，含糊的名字
 *   比没有更麻烦）
 * - 其余字段（温度、权限、档案）不合规 → **只忽略这一项**，智能体本身照样在
 */
function readMeta(file: string, dirName: string, scope: 'global' | 'project'): AgentMeta | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
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
    scope,
    profile: (data.profile ?? '').trim(),
    // 模型名**原样保留**，不 slugify 也不去斜杠：硅基流动的 `Qwen/Qwen3-32B` 是合法模型 id
    model: (data.model ?? '').trim(),
    temperature: parseTemperature(data.temperature),
    permission: parsePermission(data.permission),
    allow: splitList(data.allow),
    deny: splitList(data.deny),
    tools: splitList(data.tools) ?? [],
    skills: splitList(data.skills) ?? [],
    questions: splitQuestions(data.questions),
  }
}

/** 数字；非数字 / 空值 / 越界一律 `undefined`（= 不覆盖）。写成 `''` 是因为 `Number('')` 是 0 */
function parseTemperature(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > MAX_TEMPERATURE) return undefined
  return n
}

function parsePermission(v: string | undefined): PermissionMode | undefined {
  const p = (v ?? '').trim()
  return p === 'default' || p === 'auto' || p === 'plan' ? p : undefined
}

/**
 * 逗号分隔的标识符列表。
 *
 * **键不在 → `undefined`，键在但为空 → `[]`**，两者是不同的意思（不覆盖 / 显式清空）。
 * 标识符永远不会含逗号，所以这边用逗号读起来最顺；散文（`questions`）用竖线。
 */
function splitList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 竖线分隔的散文列表。问题里本来就会带逗号（「跑测试要装什么，怎么装？」），逗号当分隔符会把它切成两半 */
function splitQuestions(v: string | undefined): string[] {
  if (v === undefined) return []
  const flat = v.replace(/\r?\n/g, ' ')
  return flat
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
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
