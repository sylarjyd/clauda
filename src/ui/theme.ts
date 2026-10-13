/** 终端配色与符号。尊重 NO_COLOR / 非 TTY 环境，管道输出时自动关闭颜色。 */

export const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1')

function wrap(open: number, close: number): (s: string) => string {
  if (!colorEnabled) return (s: string) => s
  const pre = `\x1b[${open}m`
  const post = `\x1b[${close}m`
  return (s: string) => (s.includes(pre) ? s : pre + s + post)
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  brightCyan: wrap(96, 39),
}

export const sym = {
  bullet: '⏺',
  result: '⎿',
  check: '✔',
  cross: '✖',
  warn: '⚠',
  pointer: '❯',
  spark: '✻',
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function terminalWidth(): number {
  const cols = process.stdout.columns
  return cols && cols > 20 ? cols : 80
}
