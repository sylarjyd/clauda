import { spawn } from 'node:child_process'
import { isDangerousCommand } from '../permissions.js'
import { ConsoleDecoder } from '../util/console-decoder.js'
import { formatMs, truncateMiddle } from '../util/text.js'
import { optionalNumber, requireString, type Tool } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 30_000

interface BashArgs {
  command: string
  timeout?: number
  description?: string
}

export const bashTool: Tool<BashArgs> = {
  name: 'bash',
  description:
    '在工作目录下执行 shell 命令并返回合并后的 stdout/stderr。' +
    '适合跑测试、构建、git、包管理器等。' +
    '注意：每次调用都是全新的 shell，工作目录和导出的变量不会跨调用保留，' +
    '需要保持状态时请用 `cd /path && cmd` 这种单行写法，或直接用专用的读写文件工具。' +
    'timeout 单位为毫秒，默认 120000，上限 600000。输出过长会被截断。',
  permission: 'exec',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      description: { type: 'string', description: '一句话说明这条命令在做什么（展示给用户看）' },
      timeout: { type: 'number', description: '超时毫秒数，默认 120000' },
    },
    required: ['command'],
  },
  // description 拼进摘要里给用户看。它必须落在这里：schema 里对模型承诺了「展示给用户看」，
  // 系统提示词也要求模型填，但 execute() 那边从来没人读它 —— 不接上的话这个参数纯属白填。
  summary: (a) => {
    const cmd = a?.command ?? ''
    const desc = a?.description?.trim()
    return desc ? `${cmd} —— ${desc}` : cmd
  },
  async run(args, ctx) {
    const command = requireString(args as any, 'command')

    if (isDangerousCommand(command)) {
      throw new Error(
        `该命令被判定为危险操作，已拒绝执行：${command}\n` +
          '如果确实需要，请先向用户说明风险并取得明确同意。',
      )
    }

    const timeoutMs = Math.min(
      Math.max(optionalNumber(args as any, 'timeout') ?? DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS,
    )

    const started = Date.now()
    const result = await execute(command, {
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      shell: ctx.config.shell,
      onOutput: ctx.onOutput,
    })
    const elapsed = Date.now() - started

    const parts: string[] = []
    const body = truncateMiddle(result.output.trimEnd(), MAX_OUTPUT_CHARS)
    if (body) parts.push(body)
    else parts.push('（无输出）')

    if (result.timedOut) {
      parts.push(`\n[命令在 ${formatMs(timeoutMs)} 后超时并被终止]`)
    } else if (result.aborted) {
      parts.push('\n[命令被用户中断]')
    }
    parts.push(`\n[退出码 ${result.code ?? 'null'}，耗时 ${formatMs(elapsed)}]`)

    return parts.join('\n')
  },
}

interface ExecOptions {
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  shell?: string
  onOutput?: (chunk: string) => void
}

interface ExecResult {
  output: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

function execute(command: string, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      resolve(r)
    }

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: opts.shell || true,
      windowsHide: true,
      env: { ...process.env, CLAUDA: '1', FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
    })

    let output = ''
    // 两个流各持一个解码器：它们是两条独立的字节流，共用一个的话，一个流末尾那半截
    // 字符会和另一个流的字节拼在一起
    const decoders = [new ConsoleDecoder(), new ConsoleDecoder()]
    const onData = (decoder: ConsoleDecoder) => (chunk: Buffer) => {
      const text = decoder.push(chunk)
      if (!text) return
      output += text
      opts.onOutput?.(text)
    }
    child.stdout?.on('data', onData(decoders[0]!))
    child.stderr?.on('data', onData(decoders[1]!))

    /** 收尾：把解码器里压着的半截吐出来。error 和 close 都会到这儿，flush 是幂等的 */
    const drain = () => {
      const tail = decoders.map((d) => d.flush()).join('')
      if (!tail) return
      output += tail
      opts.onOutput?.(tail)
    }

    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, opts.timeoutMs)

    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      drain()
      done({ output: output + `\n[启动命令失败：${err.message}]`, code: null, timedOut, aborted })
    })

    child.on('close', (code) => {
      drain()
      done({ output, code, timedOut, aborted })
    })
  })
}

/** 杀整棵进程树，否则 `npm run x` 的子进程会继续挂着 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}
