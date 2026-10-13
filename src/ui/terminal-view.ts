import type { AssistantStream, TurnSummary, View } from '../agent/view.js'
import { formatMs } from '../util/text.js'
import { formatToolHeader, MarkdownStream, Spinner } from './render.js'
import { style, sym } from './theme.js'

const MAX_RESULT_LINES = 15

export interface TerminalViewOptions {
  /** 助手回答的输出流 */
  out?: NodeJS.WriteStream
  /** 状态、工具、错误等辅助信息的输出流 */
  err?: NodeJS.WriteStream
  showToolResults?: boolean
  showUsage?: boolean
  /**
   * 无头模式：工具调用信息改走 stderr，保证 stdout 上只有模型回答，
   * 这样 `clauda -p "..." > out.md` 拿到的文件是干净的。
   */
  quietTools?: boolean
  /**
   * 不把助手回答写到 out 上。`--output-format json` 时用，
   * 否则流式文本会混在 JSON 前面，管道下游就没法解析了。
   */
  silentAssistant?: boolean
}

export class TerminalView implements View {
  protected spinner: Spinner
  protected out: NodeJS.WriteStream
  protected err: NodeJS.WriteStream
  private showToolResults: boolean
  private showUsage: boolean
  private quietTools: boolean
  private silentAssistant: boolean
  private toolHeaderWritten = false

  constructor(opts: TerminalViewOptions = {}) {
    this.out = opts.out ?? process.stdout
    this.err = opts.err ?? process.stdout
    this.showToolResults = opts.showToolResults ?? true
    this.showUsage = opts.showUsage ?? true
    this.quietTools = opts.quietTools ?? false
    this.silentAssistant = opts.silentAssistant ?? false
    this.spinner = new Spinner(this.err)
  }

  thinking(label?: string): void {
    this.spinner.start(label ? truncate(label, 60) : undefined)
  }

  thinkingDone(): void {
    this.spinner.stop()
  }

  assistantStart(): AssistantStream {
    this.spinner.stop()
    if (this.silentAssistant) {
      return { write: () => {}, end: () => {} }
    }
    const md = new MarkdownStream(this.out)
    let wroteAnything = false
    return {
      write: (t: string) => {
        wroteAnything = true
        md.write(t)
      },
      end: () => {
        if (wroteAnything) {
          md.flush()
          this.out.write('\n')
        }
      },
    }
  }

  toolStart(name: string, summary: string): void {
    this.spinner.stop()
    this.toolHeaderWritten = true
    if (this.quietTools) {
      this.err.write(style.dim(`[${name}] ${summary.slice(0, 80)}\n`))
      return
    }
    this.out.write(formatToolHeader(name, summary) + '\n')
  }

  toolOutput(chunk: string): void {
    // bash 的实时输出原样透传，不加装饰，避免污染日志
    ;(this.quietTools ? this.err : this.out).write(chunk)
  }

  toolEnd(ok: boolean, result: string, elapsedMs: number): void {
    if (!this.toolHeaderWritten) return
    this.toolHeaderWritten = false
    if (this.quietTools) {
      const mark = ok ? sym.result : sym.cross
      this.err.write(style.dim(`  ${mark} ${firstLine(result)}\n`))
      return
    }

    if (!ok) {
      this.out.write(`  ${style.red(sym.result)} ${style.red(firstLine(result))}\n`)
      const rest = restLines(result, 4)
      if (rest) this.out.write(rest + '\n')
      return
    }
    if (!this.showToolResults) return

    const { text, omitted } = clip(result, MAX_RESULT_LINES)
    const elapsed = elapsedMs > 300 ? style.dim(` (${formatMs(elapsedMs)})`) : ''
    const head = text ? ` ${style.dim(text)}` : ''
    this.out.write(`  ${style.gray(sym.result)}${head}${elapsed}\n`)
    if (omitted > 0) {
      this.out.write(`  ${style.gray(sym.result)} ${style.dim(`... 另有 ${omitted} 行未显示`)}\n`)
    }
  }

  info(msg: string): void {
    this.spinner.stop()
    this.err.write(msg + '\n')
  }

  warn(msg: string): void {
    this.spinner.stop()
    this.err.write(`${style.yellow(sym.warn)} ${msg}\n`)
  }

  error(msg: string): void {
    this.spinner.stop()
    this.err.write(`${style.red(sym.cross)} ${msg}\n`)
  }

  turnEnd(summary: TurnSummary): void {
    if (!this.showUsage) return

    const parts: string[] = []
    if (summary.aborted) parts.push(style.yellow('已中断'))
    if (summary.compactions > 0) parts.push(style.dim(`压缩 ${summary.compactions} 次`))
    if (summary.usage.input || summary.usage.output) {
      parts.push(
        style.dim(`↑${formatNum(summary.usage.input)} ↓${formatNum(summary.usage.output)} tokens`),
      )
    }
    if (summary.cost > 0) parts.push(style.dim(`${summary.cost.toFixed(4)} ${summary.currency}`))
    if (parts.length === 0) return
    this.err.write(style.gray('  ' + parts.join(style.gray(' · '))) + '\n\n')
  }

  /** 供 REPL 在提示符前调用 */
  stopSpinner(): void {
    this.spinner.stop()
  }
}

// ------------------------------------------------------------------ helpers

function clip(text: string, maxLines: number): { text: string; omitted: number } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, omitted: 0 }
  return { text: lines.slice(0, maxLines).join('\n'), omitted: lines.length - maxLines }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text
  return line.length > 160 ? line.slice(0, 160) + '…' : line
}

function restLines(text: string, max: number): string {
  const lines = text.split('\n').slice(1).filter((l) => l.trim())
  if (lines.length === 0) return ''
  return lines
    .slice(0, max)
    .map((l) => `  ${style.gray(sym.result)} ${style.dim(l.slice(0, 160))}`)
    .join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function formatNum(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}
