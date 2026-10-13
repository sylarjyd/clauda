import type { SessionSnapshot } from '../agent/agent.js'
import { deriveTitle, loadSession, saveSession } from '../agent/session.js'
import { formatBytes } from '../util/text.js'

/** 会话文件超过这个体积就在 stderr 上说一句。带图的会话会撞到，正常对话不会 */
const BIG_SESSION_BYTES = 20 * 1024 * 1024

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

  // 带图的会话里 base64 会随每轮整份重写。超了就说一声 —— 否则用户只会看到「保存越来越慢」
  // 而不知道账单记在图片头上（图片按设计留在历史里，见 README 的「已知限制」）
  const bytes = JSON.stringify(snapshot.messages).length
  if (bytes > BIG_SESSION_BYTES) {
    process.stderr.write(
      `[clauda] 会话 ${opts.sessionId} 已到 ${formatBytes(bytes)}（附件里的图片会随每轮重写），` +
        `继续追加会越来越慢\n`,
    )
  }

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
