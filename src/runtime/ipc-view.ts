import type { AssistantStream, TurnSummary, View } from '../agent/view.js'

export type ViewEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant-end' }
  | { type: 'tool-start'; name: string; summary: string }
  | { type: 'tool-output'; chunk: string }
  | { type: 'tool-end'; ok: boolean; result: string; elapsedMs: number }
  | { type: 'info'; msg: string }
  | { type: 'warn'; msg: string }
  | { type: 'error'; msg: string }
  | { type: 'thinking'; label?: string }
  | { type: 'thinking-done' }
  | { type: 'turn-end'; summary: TurnSummary }

/**
 * 事件的去处。做成接口是为了让这层不依赖 Electron —— 主进程里是 `webContents.send`，
 * 测试里是个往数组里 push 的假实现。
 *
 * sessionId 每条都带：多会话并行时最容易出的错就是把 A 的流式增量发进 B 的窗口，
 * 而主进程只有一个 sink，只能靠事件自己标明归属。
 */
export interface ViewEventSink {
  send(sessionId: string, event: ViewEvent): void
}

/** `View` 的桌面端实现：每个回调翻译成一条可过 IPC 的事件。 */
export class IpcView implements View {
  constructor(
    private readonly sessionId: string,
    private readonly sink: ViewEventSink,
  ) {}

  private emit(event: ViewEvent): void {
    this.sink.send(this.sessionId, event)
  }

  assistantStart(): AssistantStream {
    this.emit({ type: 'assistant-start' })
    return {
      write: (text) => this.emit({ type: 'assistant-delta', text }),
      end: () => this.emit({ type: 'assistant-end' }),
    }
  }

  toolStart(name: string, summary: string): void {
    this.emit({ type: 'tool-start', name, summary })
  }

  toolOutput(chunk: string): void {
    this.emit({ type: 'tool-output', chunk })
  }

  toolEnd(ok: boolean, result: string, elapsedMs: number): void {
    this.emit({ type: 'tool-end', ok, result, elapsedMs })
  }

  info(msg: string): void {
    this.emit({ type: 'info', msg })
  }

  warn(msg: string): void {
    this.emit({ type: 'warn', msg })
  }

  error(msg: string): void {
    this.emit({ type: 'error', msg })
  }

  turnEnd(summary: TurnSummary): void {
    this.emit({ type: 'turn-end', summary })
  }

  thinking(label?: string): void {
    this.emit({ type: 'thinking', label })
  }

  thinkingDone(): void {
    this.emit({ type: 'thinking-done' })
  }
}
