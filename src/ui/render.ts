import { colorEnabled, SPINNER_FRAMES, style, sym } from './theme.js'

/**
 * 极简流式 Markdown 渲染。
 *
 * 模型是按 token 往外吐的，所以只能按「行」为单位处理：攒够一整行再渲染，
 * 否则 `**` 这类跨 token 的标记会被切碎。
 * 非 TTY（管道输出）时原样输出，避免把 Markdown 标记当格式化指令吃掉。
 */
export class MarkdownStream {
  private buf = ''
  private inFence = false

  constructor(private out: NodeJS.WriteStream = process.stdout) {}

  write(text: string): void {
    if (!colorEnabled) {
      this.out.write(text)
      return
    }
    this.buf += text
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      this.out.write(this.renderLine(line) + '\n')
    }
  }

  /** 输出末尾没有换行的残留内容 */
  flush(): void {
    if (!colorEnabled) return
    if (this.buf) {
      this.out.write(this.renderLine(this.buf))
      this.buf = ''
    }
  }

  private renderLine(line: string): string {
    if (/^\s*```/.test(line)) {
      this.inFence = !this.inFence
      return style.gray(line)
    }
    if (this.inFence) return style.cyan(line)

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) return style.bold(heading[2])

    let out = this.renderInline(line)
    out = out.replace(/^(\s*)([-*+])\s/, (_, indent: string, m: string) => `${indent}${style.gray(m)} `)
    out = out.replace(/^(\s*)(\d+)\.\s/, (_, indent: string, n: string) => `${indent}${style.gray(n + '.')} `)
    return out
  }

  /**
   * 先按行内代码切开，只在非代码片段上套强调标记。
   * 比「先占位再还原」的写法少一层出错的可能。
   */
  private renderInline(line: string): string {
    return line
      .split(/(`[^`]*`)/)
      .map((part) => {
        if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
          return style.cyan(part.slice(1, -1))
        }
        return this.applyEmphasis(part)
      })
      .join('')
  }

  private applyEmphasis(text: string): string {
    let out = text
    out = out.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => style.bold(t))
    out = out.replace(
      /(^|[\s(])\*([^*\n]+)\*(?=[\s).,;!?]|$)/g,
      (_, pre: string, t: string) => pre + style.italic(t),
    )
    out = out.replace(/~~([^~]+)~~/g, (_, t: string) => style.dim(t))
    // 顺带把写在某处的「路径:行号」点亮，方便用户点击跳转
    out = out.replace(
      /(?<![\w/`])((?:[\w.@-]+[\\/])+[\w.@-]+\.\w{1,6}:\d+)(?![\w/])/g,
      (m) => style.cyan(m),
    )
    return out
  }
}

/** 等待首个 token 时的转圈提示。只在 TTY 下启用。 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null
  private frame = 0
  private label = ''
  private startedAt = 0

  constructor(
    private out: NodeJS.WriteStream = process.stdout,
    private enabled: boolean = colorEnabled && Boolean(process.stdout.isTTY),
  ) {}

  get active(): boolean {
    return this.timer !== null
  }

  start(label?: string): void {
    if (!this.enabled) return
    if (label) this.label = label
    if (this.timer) return
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.tick(), 80)
    this.timer.unref?.()
    this.tick()
  }

  update(label: string): void {
    this.label = label
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.out.write('\r\x1b[K')
  }

  private tick(): void {
    const frame = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(0)
    const label = this.label ? ` ${style.dim(this.label)}` : ''
    this.out.write(`\r\x1b[K${style.magenta(frame)}${label} ${style.dim(secs + 's')}`)
  }
}

/** 统一的工具调用展示，REPL 和无头模式共用 */
export function formatToolHeader(name: string, summary: string): string {
  const s = summary.length > 100 ? summary.slice(0, 100) + '…' : summary
  return `${style.green(sym.bullet)} ${style.bold(name)}${s ? style.dim('(') + s + style.dim(')') : ''}`
}
