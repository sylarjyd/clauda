import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { claudaHome } from '../config.js'
import type { WireMessage } from '../types.js'
import type { SessionSnapshot } from './agent.js'

export interface SessionRecord {
  id: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  title: string
  messages: WireMessage[]
  todos: SessionSnapshot['todos']
  totalUsage: SessionSnapshot['totalUsage']
  cost: number
}

/** 每个工作目录一个子目录，避免不同项目的会话混在一起 */
function projectDir(cwd: string): string {
  const slug = path
    .resolve(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80)
  return path.join(claudaHome(), 'projects', slug || 'root')
}

export function newSessionId(): string {
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rand}`
}

/**
 * 会话 id 直接拼进文件路径，所以它必须是「生成得出、也验证得了」的形状。
 * 这里是 `newSessionId()` 的宽松版本：字母数字开头，后面允许 `-` / `_`。
 *
 * 关键不是收紧到什么规范，而是**挡掉路径分隔符、`.` 开头和绝对路径** ——
 * 也就是挡掉 `..` 穿越。id 有三个来源，都不能信：
 * - 桌面端 `session/resume` 的 IPC 载荷（renderer 给什么就是什么）；
 * - CLI 的 `--resume <id>` 与 repl 的 `/resume <id>`（用户手输）；
 * - **会话文件里的 `id` 字段**（`index.ts` 恢复后会接管它，磁盘上被改过就穿帮）。
 * 最后一条是为什么这道闸放在这里而不是只堵 IPC 口。
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id)
}

/** id 合法就给出会话文件路径，否则 `null`。**不合法时绝不能拼出一个路径**。 */
function sessionFile(cwd: string, id: string): string | null {
  if (!isSafeSessionId(id)) return null
  return path.join(projectDir(cwd), `${id}.json`)
}

export function saveSession(cwd: string, rec: SessionRecord): string {
  const file = sessionFile(cwd, rec.id)
  // 抛而不是静默跳过：返回一个「写好了」的路径却没写，调用方没法知道。
  // 正常流程走不到这里（id 是 newSessionId() 造的），到了就是有人在喂路径。
  if (!file) throw new Error(`非法会话 id：${rec.id}`)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8')
  return file
}

export function loadSession(cwd: string, id: string): SessionRecord | null {
  const file = sessionFile(cwd, id)
  if (!file) return null
  try {
    if (!fs.existsSync(file)) return null
    const rec: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 光解析成功不够：随便一个 `.json` 都能解析出来。形状不对就当没有 ——
    // 恢复会话的人拿 `messages` 直接用（`persistSession` 会读 `.length`），
    // 少一个字段就是运行期崩溃。
    return isSessionRecord(rec) ? rec : null
  } catch {
    return null
  }
}

export function listSessions(cwd: string): SessionRecord[] {
  const dir = projectDir(cwd)
  if (!fs.existsSync(dir)) return []
  const out: SessionRecord[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown
      // 光解析成功不够：手改坏或旧版本写下的文件可能缺 updatedAt，
      // 那样排序时的 localeCompare 会把整个 /sessions 打挂。形状不对就当坏文件跳过。
      if (isSessionRecord(rec)) out.push(rec)
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * 侧边栏用的轻量摘要：**不解析 `messages`**。
 *
 * 列表每次刷新都要读一遍全部会话文件，按整份历史对话去解析的话，会话攒多了会明显卡顿。
 * 这里只读元数据，所以连旧版本写下的、`messages` 结构已经不对的文件也能照常列出来
 * （`listSessions` 要求 `messages` 是数组，会把它们整个跳过）。
 */
export interface SessionSummary {
  id: string
  cwd: string
  model: string
  title: string
  createdAt: string
  updatedAt: string
}

export function listProjects(): { cwd: string; sessions: SessionSummary[] }[] {
  const root = path.join(claudaHome(), 'projects')
  if (!fs.existsSync(root)) return []

  // 目录名是 cwd 的 slug，**不可逆**（`[:\/]+` 一律换成 `-`），所以分组只能靠读文件里的 cwd 字段
  const byCwd = new Map<string, SessionSummary[]>()
  for (const slug of fs.readdirSync(root)) {
    const dir = path.join(root, slug)
    for (const summary of readSummaries(dir)) {
      const list = byCwd.get(summary.cwd)
      if (list) list.push(summary)
      else byCwd.set(summary.cwd, [summary])
    }
  }

  return [...byCwd.entries()]
    .map(([cwd, sessions]) => ({ cwd, sessions: sessions.sort(byUpdatedDesc) }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''))
}

export function listSessionSummaries(cwd: string): SessionSummary[] {
  return readSummaries(projectDir(cwd)).sort(byUpdatedDesc)
}

function byUpdatedDesc(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

function readSummaries(dir: string): SessionSummary[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  const out: SessionSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown> | null
      // 只要 id + updatedAt：排序和 key 都靠它们，其余字段缺失就降级，坏一个文件不该打挂整个列表
      if (!raw || typeof raw.id !== 'string' || typeof raw.updatedAt !== 'string') continue
      out.push({
        id: raw.id,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        title: typeof raw.title === 'string' ? raw.title : raw.id,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : raw.updatedAt,
        updatedAt: raw.updatedAt,
      })
    } catch {
      // 坏文件跳过
    }
  }
  return out
}

function isSessionRecord(v: unknown): v is SessionRecord {
  const r = v as Record<string, unknown> | null
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    typeof r.updatedAt === 'string' &&
    typeof r.title === 'string' &&
    Array.isArray(r.messages)
  )
}

export function latestSessionId(cwd: string): string | null {
  return listSessions(cwd)[0]?.id ?? null
}

/** 从对话历史里挑一句话当标题，给 /sessions 用 */
export function deriveTitle(messages: WireMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return '(空会话)'
  const line = firstUser.content.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 60 ? line.slice(0, 60) + '…' : line
}

/** 会话文件内容指纹，用于确认「同一个会话」 */
export function sessionFingerprint(cwd: string, id: string): string {
  return createHash('sha1').update(`${cwd}::${id}`).digest('hex').slice(0, 8)
}
