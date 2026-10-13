import type { SessionSnapshot } from '../agent/agent.js'
import { deriveTitle, loadSession, saveSession } from '../agent/session.js'

export interface PersistOptions {
  cwd: string
  sessionId: string
  model: string
  snapshot: SessionSnapshot
}

/**
 * 会话落盘。CLI 和桌面端共用一份，免得两边对「什么时候该写、写什么」有不同理解。
 *
 * 两个容易写错的地方：
 * - **`createdAt` 要从既有文件里读回来**。每轮都写 `new Date()` 的话它恒等于
 *   `updatedAt`，「按创建时间排序」就整个失真了。
 * - **只有系统提示词（`messages.length <= 1`）时不写**：那是刚建好还没说过话的会话，
 *   落盘只会让侧边栏塞满空条目。
 */
export function persistSession(opts: PersistOptions): void {
  const { snapshot } = opts
  if (snapshot.messages.length <= 1) return

  try {
    const previous = loadSession(opts.cwd, opts.sessionId)
    const now = new Date().toISOString()
    saveSession(opts.cwd, {
      id: opts.sessionId,
      cwd: opts.cwd,
      model: opts.model,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      title: deriveTitle(snapshot.messages),
      messages: snapshot.messages,
      todos: snapshot.todos,
      totalUsage: snapshot.totalUsage,
      cost: snapshot.cost,
    })
  } catch {
    // 会话落盘失败不该影响主流程
  }
}
