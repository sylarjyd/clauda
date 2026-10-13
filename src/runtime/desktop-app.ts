import { listProjects, listSessionSummaries, loadSession } from '../agent/session.js'
import type { PermissionMode } from '../config.js'
import type { PermissionDecision } from './permission-bridge.js'
import { SessionManager, type EventSink, type Session, type SessionProject } from './session-manager.js'

/**
 * 一条 channel 的返回值。**多带索引签名是有意的**：`desktop/main.js` 只负责把这坨东西
 * 原样丢回 renderer，不该认识任何具体 channel 的字段名 —— 认识一个就会长出第二个。
 */
export interface ChannelResult {
  ok: boolean
  reason?: string
  [key: string]: unknown
}

/** 会话的可序列化快照。renderer 拿到它就能画中栏顶栏和整个右栏 */
export interface SessionInfo {
  id: string
  cwd: string
  model: string
  mode: PermissionMode
  tools: string[]
  todos: unknown
  contextTokens: number
  contextRatio: number
}

export interface DesktopAppOptions {
  version: string
  sink: EventSink
  /** 按 cwd 建项目运行时。抽成参数是为了让 `desktop-app` 不依赖 MCP、能被单独测 */
  openProject(cwd: string): SessionProject | Promise<SessionProject>
}

/**
 * 桌面端的全部逻辑，**一行 Electron 都没有**。
 *
 * `desktop/main.js` 只做三件事：建窗口、把 `ipcMain.handle` 转成这里的 `handle`、
 * 把 `webContents.send` 适配成 `EventSink`。这样窗口之外的所有行为都还能被
 * `tests/desktop-driver.mjs` 以子进程的方式跑一遍 —— 见 CLAUDA.md 里那条架构约束。
 *
 * 每个 channel 都返回 `{ ok }` 而不是抛异常：IPC 那头的 catch 拿不到堆栈，
 * 抛出去 renderer 只会看到一句「Error invoking remote method」，什么也定位不了。
 */
export class DesktopApp {
  private readonly manager: SessionManager

  constructor(opts: DesktopAppOptions) {
    this.manager = new SessionManager({ sink: opts.sink, openProject: opts.openProject })
  }

  async handle(channel: string, payload?: unknown): Promise<ChannelResult> {
    try {
      switch (channel) {
        case 'project/list':
          return { ok: true, projects: listProjects() }

        case 'session/list':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            sessions: listSessionSummaries(cwd),
          }))

        case 'session/open':
          return await this.openSession(payload)

        case 'session/resume':
          return await this.resumeSession(payload)

        case 'session/state':
          return withSession(this.manager, payload, (session) => ({
            ok: true,
            session: infoOf(session),
          }))

        case 'session/send': {
          const res = await this.manager.send(str(payload, 'sessionId'), str(payload, 'text'))
          return res.ok ? { ok: true } : { ok: false, reason: res.reason }
        }

        case 'session/abort':
          this.manager.abort(str(payload, 'sessionId'))
          return { ok: true }

        case 'session/close':
          await this.manager.closeSession(str(payload, 'sessionId'))
          return { ok: true }

        case 'session/set-model':
          return withSession(this.manager, payload, (session) => {
            this.manager.setModel(session.id, str(payload, 'model'))
            return { ok: true }
          })

        case 'session/set-mode':
          return withSession(this.manager, payload, (session) => {
            this.manager.setMode(session.id, str(payload, 'mode') as PermissionMode)
            return { ok: true }
          })

        case 'permission/reply':
          this.manager.replyPermission(
            str(payload, 'sessionId'),
            num(payload, 'requestId'),
            str(payload, 'decision') as PermissionDecision,
          )
          return { ok: true }

        case 'mcp/set-enabled':
          return withStr(payload, 'cwd', (cwd) => {
            this.manager.setMcpEnabled(cwd, str(payload, 'name'), bool(payload, 'enabled'))
            return { ok: true }
          })

        case 'app/quit':
          await this.manager.disposeAll()
          return { ok: true }

        default:
          return { ok: false, reason: `未知通道：${channel}` }
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  private async openSession(payload: unknown): Promise<ChannelResult> {
    const cwd = str(payload, 'cwd')
    if (!cwd) return { ok: false, reason: 'session/open 需要 cwd' }
    const id = str(payload, 'id')
    const session = await this.manager.openSession(cwd, id ? { id } : {})
    return { ok: true, session: infoOf(session) }
  }

  /**
   * 从历史里打开一个会话。**沿用原来的 id**：换一个 id 的话续聊会写成新文件，
   * 被恢复的那个会话永不更新（CLAUDA.md 里点名的坑，CLI 的 `--resume` 同）。
   *
   * 连消息一起返回：renderer 要把当初的对话重画出来。`session/state` 不带 messages
   * 是有意的 —— 那个通道每轮都调一次，捎上整份历史纯属浪费。
   */
  private async resumeSession(payload: unknown): Promise<ChannelResult> {
    const cwd = str(payload, 'cwd')
    const id = str(payload, 'id')
    if (!cwd || !id) return { ok: false, reason: 'session/resume 需要 cwd 和 id' }

    const rec = loadSession(cwd, id)
    if (!rec) return { ok: false, reason: `找不到会话：${id}` }

    // 同一个 id 已经开着就先关掉。直接覆盖 Map 里的条目会让项目的引用计数永远归不了零，
    // 那个项目的 MCP 子进程就再也 dispose 不掉了
    if (this.manager.getSession(id)) await this.manager.closeSession(id)

    const session = await this.manager.openSession(cwd, {
      id,
      snapshot: {
        messages: rec.messages,
        todos: rec.todos ?? [],
        totalUsage: rec.totalUsage ?? { input: 0, output: 0 },
        cost: rec.cost ?? 0,
      },
    })
    return { ok: true, session: infoOf(session), messages: rec.messages }
  }
}

function infoOf(session: Session): SessionInfo {
  return {
    id: session.id,
    cwd: session.cwd,
    model: session.config.provider.model,
    mode: session.permissions.mode,
    tools: session.agent.listTools().map((t) => t.name),
    todos: session.agent.todos.toJSON(),
    contextTokens: session.agent.contextTokens(),
    contextRatio: session.agent.contextUsageRatio(),
  }
}

/** 会话类 channel 的共同前戏：拿不到会话就没必要往下走，统一在这里返回失败 */
function withSession(
  manager: SessionManager,
  payload: unknown,
  fn: (session: Session) => ChannelResult,
): ChannelResult {
  const session = manager.getSession(str(payload, 'sessionId'))
  if (!session) return { ok: false, reason: '会话不存在' }
  return fn(session)
}

function withStr(payload: unknown, key: string, fn: (value: string) => ChannelResult): ChannelResult {
  const value = str(payload, key)
  if (!value) return { ok: false, reason: `缺少参数 ${key}` }
  return fn(value)
}

function str(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function num(payload: unknown, key: string): number {
  const value = (payload as Record<string, unknown> | null)?.[key]
  return typeof value === 'number' ? value : 0
}

function bool(payload: unknown, key: string): boolean {
  return (payload as Record<string, unknown> | null)?.[key] === true
}
