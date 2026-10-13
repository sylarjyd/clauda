import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dotenv from 'dotenv'
import { findVendor, VENDORS, vendorByBaseUrl } from './provider/vendors.js'
import type { ToolPermission } from './types.js'

export type PermissionMode = 'default' | 'auto' | 'plan'

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /** 是否请求后端返回 usage（部分 OpenAI 兼容后端不支持，失败会自动降级） */
  includeUsage: boolean
  timeoutMs: number
  maxRetries: number
  extraHeaders?: Record<string, string>
}

export interface PermissionsConfig {
  mode: PermissionMode
  /** 规则形如 `Bash`、`Bash(npm run:*)`、`Read(src/**)` */
  allow: string[]
  deny: string[]
}

export interface PricingConfig {
  /** 美元 / 百万 token */
  input: number
  output: number
  cachedInput?: number
  currency: string
}

/**
 * 一个 MCP 服务器。
 *
 * stdio 用 `command`/`args`，HTTP 用 `url`；`type` 不填就按这两个字段推断。
 * `env` 和 `headers` 里的值会过 `expandEnvRefs`，所以密钥可以写成 `${MY_TOKEN}`
 * 留在环境里，不必明文落盘。
 */
export interface McpServerConfig {
  /** stdio：可执行文件，如 `npx` */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** HTTP：Streamable HTTP 端点 */
  url?: string
  headers?: Record<string, string>
  /** 不填则按 command/url 推断 */
  type?: 'stdio' | 'http'
  /** 默认 true */
  enabled?: boolean
  /**
   * 该服务器所有工具的权限级别，默认 `exec` —— 也就是 default 模式下逐个询问、
   * plan 模式下直接挡住。对来源不明的第三方服务器，这个保守默认是对的。
   */
  permission?: ToolPermission
  /** 可选白名单：只接入这几个工具。用来挡住工具特别多的服务器，省 schema token */
  tools?: string[]
  /** 连接握手超时，默认 15000 */
  timeoutMs?: number
}

export interface ClaudaConfig {
  provider: ProviderConfig
  permissions: PermissionsConfig
  pricing: PricingConfig
  /** MCP 服务器，key 是服务器名 */
  mcpServers?: Record<string, McpServerConfig>
  /** 模型上下文窗口，用于决定何时压缩 */
  contextWindow: number
  autoCompact: boolean
  /** 占用超过该比例时触发压缩 */
  compactThreshold: number
  /** 单轮最多几轮工具调用，防死循环 */
  maxSteps: number
  /** 单个工具结果的 token 上限；不填则按上下文窗口的 1/4 自动取值（上限 8000） */
  maxToolResultTokens?: number
  /** 自定义 shell 路径；不填则用系统默认 */
  shell?: string
}

export function claudaHome(): string {
  return process.env.CLAUDA_HOME || path.join(os.homedir(), '.clauda')
}

function defaultConfig(): ClaudaConfig {
  return {
    provider: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0,
      maxTokens: 8192,
      includeUsage: true,
      timeoutMs: 120_000,
      maxRetries: 3,
    },
    permissions: {
      mode: 'default',
      allow: [],
      deny: [],
    },
    pricing: { input: 0, output: 0, currency: 'USD' },
    contextWindow: 128_000,
    autoCompact: true,
    compactThreshold: 0.75,
    maxSteps: 40,
  }
}

function readJsonIfExists(file: string): Partial<ClaudaConfig> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw) as Partial<ClaudaConfig>
  } catch (e) {
    process.stderr.write(`[clauda] 配置文件解析失败，已忽略：${file} — ${(e as Error).message}\n`)
    return {}
  }
}

function merge(base: ClaudaConfig, patch: Partial<ClaudaConfig>): ClaudaConfig {
  return {
    ...base,
    ...patch,
    provider: { ...base.provider, ...(patch.provider ?? {}) },
    permissions: { ...base.permissions, ...(patch.permissions ?? {}) },
    pricing: { ...base.pricing, ...(patch.pricing ?? {}) },
    // 必须显式列出：`...patch` 是浅合并，项目配置里只要出现 mcpServers 这一整个键，
    // 全局配的那些服务器就会被整个顶掉。这里按**服务器名**合并，同名时项目级的整体
    // 替换全局的（不做字段级深合并）—— 想改全局某个服务器的单个字段，得把它整个重写。
    mcpServers: { ...(base.mcpServers ?? {}), ...(patch.mcpServers ?? {}) },
  }
}

export interface CliOverrides {
  model?: string
  baseUrl?: string
  apiKey?: string
  permissionMode?: PermissionMode
  maxTokens?: number
  contextWindow?: number
}

/**
 * 把配置里的 `$VAR` / `${VAR}` 换成环境变量值。
 *
 * 这样配置文件依然优先，但密钥本身可以留在环境里 —— 否则「用配置文件定端点、
 * 又不想把 key 明文落盘」的人只能二选一。取不到的环境变量原样保留，
 * 免得把含 `$` 的普通字符串（正则、权限规则）改坏。
 */
function expandEnvRefs<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (whole, name: string) => process.env[name] ?? whole,
    ) as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvRefs(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnvRefs(v)
    return out as unknown as T
  }
  return value
}

/**
 * 优先级（低 → 高）：
 *   内置默认值 < .env / 环境变量 < ~/.clauda/config.json < ./.clauda/config.json < 命令行参数
 *
 * 配置文件压过环境变量是有意为之：配置文件是跟着项目走、用户显式认可的意图，
 * 而环境变量常常是别的 shell 会话里残留的导出，容易在不该生效时悄悄换掉端点。
 * 需要临时盖过配置文件就用命令行参数，它永远最高。
 */
export function loadConfig(cwd: string, overrides: CliOverrides = {}): ClaudaConfig {
  dotenv.config({ path: path.join(cwd, '.env'), quiet: true })

  let cfg = defaultConfig()

  const env = process.env
  const envPatch: Partial<ClaudaConfig> = { provider: {} as ProviderConfig }
  const p = envPatch.provider as ProviderConfig

  const baseUrl = env.CLAUDA_BASE_URL || env.OPENAI_BASE_URL || env.OPENAI_API_BASE
  if (baseUrl) p.baseUrl = baseUrl
  const apiKey = env.CLAUDA_API_KEY || env.OPENAI_API_KEY
  if (apiKey) p.apiKey = apiKey
  if (env.CLAUDA_MODEL) p.model = env.CLAUDA_MODEL
  if (env.CLAUDA_TEMPERATURE) p.temperature = Number(env.CLAUDA_TEMPERATURE)
  if (env.CLAUDA_MAX_TOKENS) p.maxTokens = Number(env.CLAUDA_MAX_TOKENS)
  if (env.CLAUDA_CONTEXT_WINDOW) envPatch.contextWindow = Number(env.CLAUDA_CONTEXT_WINDOW)
  if (env.CLAUDA_PERMISSION_MODE) {
    envPatch.permissions = { mode: env.CLAUDA_PERMISSION_MODE as PermissionMode, allow: [], deny: [] }
  }
  cfg = merge(cfg, envPatch)

  cfg = merge(cfg, expandEnvRefs(readJsonIfExists(path.join(claudaHome(), 'config.json'))))
  cfg = merge(cfg, expandEnvRefs(readJsonIfExists(path.join(cwd, '.clauda', 'config.json'))))

  if (overrides.model) cfg.provider.model = overrides.model
  if (overrides.baseUrl) cfg.provider.baseUrl = overrides.baseUrl
  if (overrides.apiKey) cfg.provider.apiKey = overrides.apiKey
  if (overrides.maxTokens) cfg.provider.maxTokens = overrides.maxTokens
  if (overrides.contextWindow) cfg.contextWindow = overrides.contextWindow
  if (overrides.permissionMode) cfg.permissions.mode = overrides.permissionMode

  cfg.provider.baseUrl = normalizeBaseUrl(cfg.provider.baseUrl)

  // 厂商专属环境变量回退：只在**一个 key 都没配到**时生效 —— 配置文件里写了 key 的永远赢。
  // 没有这条，界面上那句「该厂商读 DEEPSEEK_API_KEY」就是假的：用户照设了照样 401。
  // 本地部署那条 envKey 是空串，天然跳过。
  if (!cfg.provider.apiKey) {
    const envKey = vendorByBaseUrl(cfg.provider.baseUrl)?.envKey
    if (envKey) cfg.provider.apiKey = process.env[envKey] ?? ''
  }
  return cfg
}

/**
 * 归一化接口地址：**只补一种情况** —— 路径为空或恰好是 `/` 时补 `/v1`。
 *
 * 凭空补全绝不碰已经有 path 的地址（`/compatible-mode/v1`、`/api/v3`、`/paas/v4`
 * 一律原样），却能救掉最常见的手填错误：`http://localhost:11434` → `…/v1`。
 * 补错的代价很大 —— 把方舟的 `/api/v3` 拼成 `/v3/v1` 是真实事故。
 *
 * **只在 `loadConfig` 解析时归一，绝不写回用户的文件原文** —— 和 `${VAR}` 只在解析时
 * 展开是同一条规矩。解析不了（不是 URL）就原样返回。
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/v1'
  // `URL.toString()` 会给带 path 的地址补尾斜杠，统一去掉（老行为就是去尾斜杠）
  return parsed.toString().replace(/\/+$/, '')
}

export function configPath(cwd: string): string {
  return path.join(cwd, '.clauda', 'config.json')
}

export interface ProjectProviderPatch {
  baseUrl?: string
  model?: string
}

/**
 * 把「接口地址 / 默认模型」写进项目配置文件，返回写到了哪个文件。
 *
 * **必须操作磁盘上的原始文本，不能拿 `loadConfig()` 的结果回写。** 那个结果已经过
 * `expandEnvRefs`，`${MY_KEY}` 在那儿是真实密钥 —— 回写等于把密钥明文落盘。
 * 这里的值只可能来自 `VENDORS` 常量或界面上的手填，从不经过 `loadConfig`。
 *
 * 只改 `provider` 里给定的键，`provider` 的其它键和文件里别的内容一律原样保留。
 * 文件存在但解析不了时**报错返回、不覆盖**：手滑写坏一个逗号就丢掉整份配置，
 * 比「改了没生效」难受得多。
 */
export function writeProjectProvider(cwd: string, patch: ProjectProviderPatch): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)

  // 没给值的键不要碰：`{ model: undefined }` 展开进去会把磁盘上原有的 model 抹掉
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))

  const provider = raw.provider
  raw.provider =
    provider && typeof provider === 'object' && !Array.isArray(provider)
      ? { ...(provider as Record<string, unknown>), ...given }
      : { ...given }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  return file
}

/** 改「默认模型」的薄封装 —— 性质见 `writeProjectProvider` */
export function writeProjectModel(cwd: string, model: string): string {
  return writeProjectProvider(cwd, { model })
}

/** 读一份「准备原样写回去」的 JSON 对象。和 `readJsonIfExists` 不同，这里解析不了要抛 */
function readJsonObjectForWrite(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON，没有改动：${file} — ${(e as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件顶层不是对象，没有改动：${file}`)
  }
  return parsed as Record<string, unknown>
}

/** 首次运行时生成一份注释齐全的配置模板 */
export function writeConfigTemplate(cwd: string): string {
  const file = configPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 模板默认给 DeepSeek —— 地址与模型名从预置表取，别在这里手抄一份（抄了就会跟表脱节）
  const preset = findVendor('deepseek') ?? VENDORS[0]
  const tpl = {
    provider: {
      baseUrl: preset.baseUrl,
      apiKey: 'sk-替换成你的 key',
      model: preset.models[0],
      temperature: 0,
      maxTokens: 8192,
    },
    permissions: {
      mode: 'default',
      allow: ['Read', 'Glob', 'Grep', 'TodoWrite'],
      deny: ['Bash(rm -rf /*)'],
    },
    pricing: { input: 0, output: 0, currency: 'CNY' },
    contextWindow: 128000,
    autoCompact: true,
    // 这里给的是一个默认关掉的示例 —— 想看效果就把 enabled 改成 true 或删掉这一行。
    // 每个服务器的工具 schema 每次请求都要付 token，所以 clauda 默认一个都不连，
    // 必须你显式列出来。
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        enabled: false,
        permission: 'read',
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + '\n', 'utf8')
  return file
}
