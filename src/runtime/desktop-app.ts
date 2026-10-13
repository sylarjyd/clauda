import { isSafeSessionId, listProjects, listSessionSummaries, loadSession } from '../agent/session.js'
import type { PermissionMode } from '../config.js'
import { findVendor } from '../provider/vendors.js'
import { ingestAttachments, sanitizeAttachments } from './attachment.js'
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
          // 附件在这里**只核形状**：字节早在 `attachment/ingest` 那一步就读好了，
          // 用户拖进来之后把源文件删掉也不影响发送
          const raw = field(payload, 'attachments')
          const attachments = sanitizeAttachments(raw)
          // 形状不对的会被静默丢掉（见 sanitizeAttachments）。丢几个要说一声 ——
          // 「chip 明明在输入框上、发出去却没有」是那种能查一整晚的问题
          const dropped = Array.isArray(raw) ? Math.max(0, raw.length - attachments.length) : 0
          const res = await this.manager.send(str(payload, 'sessionId'), str(payload, 'text'), attachments)
          return res.ok ? { ok: true, dropped: dropped || undefined } : { ok: false, reason: res.reason }
        }

        case 'attachment/ingest': {
          // 拖拽 / 粘贴 / 选文件都先过这里：读字节、判大小、判路径，返回的不合规项
          // 由 renderer 立刻报进通知栏。发送时不再读盘
          const { attachments, rejected } = await ingestAttachments(field(payload, 'items'))
          return { ok: true, attachments, rejected }
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

        case 'mcp/set-enabled': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          // 不包 try：连不上时 `McpManager.setEnabled` 会抛，正是外层的 catch 把它翻成
          // `{ ok:false, reason }`。在这里吞掉的话，界面会显示「已接入」而工具一个没多
          await this.manager.setMcpEnabled(cwd, str(payload, 'name'), bool(payload, 'enabled'))
          return { ok: true }
        }

        case 'project/info':
          return withSession(this.manager, payload, (session) => {
            const info = this.manager.projectInfo(session.id)
            return info ? { ok: true, info } : { ok: false, reason: '项目运行时还没就绪' }
          })

        /**
         * 改**某一份档案**的接口地址 / 默认模型。`profileKey` 是设置页左栏选中的那份，
         * 不带就落到当前使用的那份上。
         */
        case 'project/set-default-model': {
          const model = str(payload, 'model').trim()
          if (!model) return { ok: false, reason: '模型名不能为空' }
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setProfileField(cwd, { model }, str(payload, 'profileKey')),
          }))
        }

        case 'project/set-base-url': {
          const baseUrl = str(payload, 'baseUrl').trim()
          if (!baseUrl) return { ok: false, reason: '接口地址不能为空' }
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setProfileField(cwd, { baseUrl }, str(payload, 'profileKey')),
          }))
        }

        /**
         * 添加一份厂商档案。地址与模型从预置表取，于是和从前一样不存在「写一个界面没
         * 提供过的地址」这条路径；自定义那份地址留空，由用户手填（走 `set-base-url`）。
         *
         * **认不出的 key 一律按自定义处理** —— `__custom__` 走的就是这条（`findVendor`
         * 里没有它）。真要做成「未知厂商报错」，那个哨兵值就得在这一层再认一次。
         */
        case 'project/add-profile': {
          const key = str(payload, 'vendorKey')
          if (!key) return { ok: false, reason: '缺少参数 vendorKey' }
          return withStr(payload, 'cwd', (cwd) => {
            const added = this.manager.addProfile(cwd, findVendor(key) ?? null)
            return { ok: true, file: added.file, key: added.key }
          })
        }

        /**
         * 切换当前使用的档案。**这条才是「换厂商」**，`project/add-profile` 只加不改。
         *
         * 参数不合法由 `setActiveProfile` 抛，外层 catch 翻成 `{ok:false, reason}` ——
         * 「档案不存在」「还缺接口地址」那几句人话就是用户看到的提示。
         */
        case 'project/set-active-provider':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setActiveProfile(cwd, str(payload, 'profileKey')),
          }))

        /** 删掉一份档案。当前使用的那份删不了（理由见 `SessionManager.removeProfile`） */
        case 'project/remove-profile':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.removeProfile(cwd, str(payload, 'profileKey')),
          }))

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
    // 这层拦一道是为了给出人话错误。真正的兜底在 session.ts —— 那边的 id 还可能
    // 来自会话文件内容，只堵 IPC 是堵不住的
    if (id && !isSafeSessionId(id)) return { ok: false, reason: `非法会话 id：${id}` }
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
    // id 会一路流到 `saveSession` 的写路径（`persist.ts` 用同一个 id 续写文件），
    // 所以这里挡的不是「读错文件」，是「写到别处去」
    if (!isSafeSessionId(id)) return { ok: false, reason: `非法会话 id：${id}` }

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

/** 取原始字段。附件那两条 channel 收的就是未知形状（renderer 从 DataTransfer 里抄来的） */
function field(payload: unknown, key: string): unknown {
  return (payload as Record<string, unknown> | null)?.[key]
}

function str(payload: unknown, key: string): string {
  const value = field(payload, key)
  return typeof value === 'string' ? value : ''
}

function num(payload: unknown, key: string): number {
  const value = field(payload, key)
  return typeof value === 'number' ? value : 0
}

function bool(payload: unknown, key: string): boolean {
  return field(payload, key) === true
}
