import { TerminalView } from './terminal-view.js'

export interface PlainViewOptions {
  /** `--output-format json` 时打开：stdout 上只留最终的 JSON */
  silentAssistant?: boolean
}

/**
 * `-p` 无头模式：stdout 只留模型回答，工具调用与错误信息全部走 stderr。
 * 这样 `clauda -p "..." > out.md` 得到的是干净的回答，同时终端上仍能看到进度。
 */
export class PlainView extends TerminalView {
  constructor(opts: PlainViewOptions = {}) {
    super({
      out: process.stdout,
      err: process.stderr,
      quietTools: true,
      showToolResults: false,
      showUsage: false,
      silentAssistant: opts.silentAssistant ?? false,
    })
  }
}
