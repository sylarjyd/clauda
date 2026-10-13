/**
 * 极简 glob → RegExp 编译器，避免为了 Grep/Glob 两个工具引入 ripgrep 依赖。
 *
 * 支持：`*`（不跨目录）、`**`（跨目录）、`?`、`{a,b}`、`[abc]`。
 */
export function globToRegExp(
  glob: string,
  opts: { caseInsensitive?: boolean } = {},
): RegExp {
  const s = glob.replace(/\\/g, '/')
  let re = ''
  let i = 0

  while (i < s.length) {
    const c = s[i]

    if (c === '*') {
      if (s[i + 1] === '*') {
        // `**/` 匹配任意层级目录（可以一层都没有），其余 `**` 退化为 `.*`
        if (s[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
      continue
    }

    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }

    if (c === '{') {
      const end = s.indexOf('}', i)
      if (end > 0) {
        const alts = s
          .slice(i + 1, end)
          .split(',')
          .map((a) => escapeRe(a))
        re += `(?:${alts.join('|')})`
        i = end + 1
        continue
      }
    }

    if (c === '[') {
      const end = s.indexOf(']', i)
      if (end > 0) {
        re += s.slice(i, end + 1)
        i = end + 1
        continue
      }
    }

    re += escapeRe(c)
    i += 1
  }

  return new RegExp(`^${re}$`, opts.caseInsensitive ? 'i' : '')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 不含 `/` 的模式按 basename 匹配，含 `/` 的按相对路径匹配 */
export function matchesGlob(
  pattern: string,
  relPath: string,
  caseInsensitive = false,
): boolean {
  const p = pattern.replace(/\\/g, '/')
  const rel = relPath.replace(/\\/g, '/')
  const re = globToRegExp(p, { caseInsensitive })
  if (p.includes('/')) return re.test(rel)
  return re.test(rel.split('/').pop() ?? rel)
}

/** 目录遍历时默认跳过的重目录 */
export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
])

export const DEFAULT_IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'Cargo.lock',
])

/** 明显是二进制/压缩包的扩展名，读取和搜索时跳过 */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.wasm',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3',
])
