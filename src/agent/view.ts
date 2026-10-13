import type { Usage } from '../types.js'

/** 助手文本的流式渲染句柄 */
export interface AssistantStream {
  write(text: string): void
  end(): void
}

export interface TurnSummary {
  steps: number
  usage: Usage
  totalUsage: Usage
  cost: number
  currency: string
  aborted: boolean
  compactions: number
}

/**
 * Agent 与终端之间的唯一接口。
 * 交互式 REPL 和 `-p` 无头模式各有一套实现，Agent 本身不关心长什么样。
 */
export interface View {
  assistantStart(): AssistantStream
  toolStart(name: string, summary: string): void
  /** 子进程实时输出（bash 工具） */
  toolOutput(chunk: string): void
  toolEnd(ok: boolean, result: string, elapsedMs: number): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  turnEnd(summary: TurnSummary): void
  /** 等待模型首个 token 时的提示，可空实现 */
  thinking(label?: string): void
  thinkingDone(): void
}
