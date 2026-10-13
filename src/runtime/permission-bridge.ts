import type { Asker } from '../permissions.js'

export type PermissionDecision = 'allow' | 'deny' | 'allow-session'

export interface PermissionRequestEvent {
  type: 'permission-request'
  requestId: number
  label: string
  detail?: string
}

export interface PermissionRequestSink {
  send(sessionId: string, event: PermissionRequestEvent): void
}

export interface PermissionBridgeHandlers {
  /**
   * 用户选了「本次会话内总是允许」。由调用方落到对应会话的 `PermissionManager` 上，
   * 桥本身不认识权限模块。
   */
  onAllowForSession?: (sessionId: string, label: string) => void
}

interface Pending {
  requestId: number
  label: string
  resolve: (value: boolean) => void
}

/** `write_file(a.txt)` → `write_file`。规则按工具名匹配，按整条 label 匹配只能命中同一个调用 */
export function toolNameOf(label: string): string {
  const idx = label.indexOf('(')
  return idx > 0 ? label.slice(0, idx) : label
}

/**
 * 把「等用户点授权按钮」从同步的终端问答变成可跨 IPC 的一问一答。
 *
 * 这里的核心风险是 **Promise 结不掉**：`PermissionManager` 的 `ask` 不监听 signal
 * （`permissions.ts:58`），一旦用户没回复、会话被关、或 renderer 崩了，挂着的 `runTurn`
 * 就永远不返回。所以每条退出路径都必须显式过一遍 `denyAll()`。
 *
 * **每会话至多一个待决请求** —— 工具是串行执行的，同一会话不可能同时问两次。
 * 复用这个前提，`requestId` 只需要在会话内单调递增，就能把陈旧回复挡在外面。
 */
export class PermissionBridge {
  private readonly pending = new Map<string, Pending>()
  private readonly onAllowForSession: (sessionId: string, label: string) => void
  private seq = 0

  constructor(
    private readonly sink: PermissionRequestSink,
    handlers: PermissionBridgeHandlers = {},
  ) {
    this.onAllowForSession = handlers.onAllowForSession ?? (() => {})
  }

  /** 交给 `PermissionManager` 的 `Asker`。**必须晚绑定到具体会话**，不能复用同一个实例 */
  askerFor(sessionId: string): Asker {
    return (label, detail) => this.ask(sessionId, label, detail)
  }

  ask(sessionId: string, label: string, detail?: string): Promise<boolean> {
    // 正常情况下到不了这里（工具串行）。真到了就先把旧的拒掉 —— 见类注释的「结不掉」
    this.settle(sessionId, false)

    const requestId = ++this.seq
    return new Promise<boolean>((resolve) => {
      // 先存再发：send 有可能同步就把回复送回来（测试里就是），反过来写的话
      // 这条回复会因为查不到 pending 被当成陈旧回复丢掉，于是永远挂着
      this.pending.set(sessionId, { requestId, label, resolve })
      this.sink.send(sessionId, { type: 'permission-request', requestId, label, detail })
    })
  }

  reply(sessionId: string, requestId: number, decision: PermissionDecision): void {
    const pending = this.pending.get(sessionId)
    // 陈旧或重复的回复直接丢：晚到的「允许」不能替已经被顶掉的请求放行
    if (!pending || pending.requestId !== requestId) return

    this.pending.delete(sessionId)
    if (decision === 'allow-session') this.onAllowForSession(sessionId, pending.label)
    pending.resolve(decision !== 'deny')
  }

  /**
   * 结清某会话的待决授权（按拒绝处理）。
   * abort、关会话、renderer 崩溃三条路径都要走它。
   */
  denyAll(sessionId: string): void {
    this.settle(sessionId, false)
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  private settle(sessionId: string, value: boolean): void {
    const pending = this.pending.get(sessionId)
    if (!pending) return
    this.pending.delete(sessionId)
    pending.resolve(value)
  }
}
