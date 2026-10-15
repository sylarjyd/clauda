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

/**
 * 一份厂商档案：端点 + 这一家用的模型参数。**档案名就是 key**（一般正好是厂商 key；
 * 手填地址、自建网关这种认不出来的，用 `default`）。
 *
 * 和 `provider` 段的分工：档案装「跟谁说话」（地址、密钥、模型、温度、最大输出），
 * `provider` 段只剩「怎么说话」（`includeUsage` / `timeoutMs` / `maxRetries` / `extraHeaders`）——
 * 传输策略是这个项目的属性，不是哪一家的属性，换厂商不该把它一起换掉。
 */
export interface ProviderProfile {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
}

/**
 * 档案里会覆盖 `provider` 段的字段。抽成常量是为了「老文件第一次落笔」那一步能精确地
 * 把这组键从 `provider` 段搬进档案 —— 手抄一遍键名，将来加一个 `topP` 两边就不同步了。
 */
const PROFILE_FIELDS = ['baseUrl', 'apiKey', 'model', 'temperature', 'maxTokens'] as const

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
  /**
   * **当前生效的**那份端点配置。它由「内置默认值 + `profiles[activeProvider]` +
   * `provider` 段 + 环境变量 + 命令行」解析而来（见 `resolveProfiles`）。
   *
   * 所以读取点（`agent`/`repl`/`session-manager` 里那十来处 `cfg.provider.model`）
   * 一个字都不用改 —— 多厂商并没有把「当前用哪个模型」变成一个要到处传的概念。
   */
  provider: ProviderConfig
  /**
   * 全部厂商档案，key 是档案名。**同时保存多个，当前生效的那个由 `activeProvider` 指。**
   *
   * 解析后的每个档案都是**完整**的（缺的字段按内置默认值补齐），界面拿到就能画，
   * 不用再猜哪一个字段可能是 undefined。
   */
  profiles: Record<string, ProviderProfile>
  /**
   * 当前用哪个档案。空串只在一种情况下出现：配置里压根还没有这个概念（老文件），
   * 那时 `resolveProfiles` 会就地补一份出来，读完 `loadConfig` 就不是空串了。
   */
  activeProvider: string
  /**
   * 「本项目默认用哪个智能体」，空串 = 没设。
   *
   * **只在开新会话时起作用**：设置页那个下拉框的初始值、CLI 启动时读一次。会话一旦建好就
   * 自带冻结的快照，之后改这个键不会动到任何已开的会话 —— 同「模型 / 端点只对新会话生效」。
   */
  defaultAgent: string
  permissions: PermissionsConfig
  pricing: PricingConfig
  /**
   * 本次不用的技能名（`SkillRegistry` 的 `name`，也就是 `/` 后面那串）。
   *
   * 技能的正文是**按需载入**的，每轮请求只付「名字 + 一句话说明」的钱；但它有 103 个时
   * 这份索引本身就值 5k token。开关只是让这一条**不出现在索引里**，`SKILL.md` 一个字不动
   * —— 所以它和「删除」是两回事，删了要重新找回来就得有原件。
   *
   * 全局与项目的这两份取**并集**（见 `merge()`），不是在哪儿禁用就在哪儿生效。
   */
  disabledSkills: string[]
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

/**
 * 「跟谁说话」的那一组默认值。单独抽出来是因为它有**两个**用处：`defaultConfig` 拿它铺
 * 当前生效那份，档案补全时也拿它铺 —— 两边共一份，就不会出现「新建的档案地址是内置默认
 * 地址、而当前生效那份是另一个」这种自相矛盾。
 */
const DEFAULT_ENDPOINTS: ProviderProfile = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 8192,
}

function defaultConfig(): ClaudaConfig {
  return {
    provider: {
      ...DEFAULT_ENDPOINTS,
      includeUsage: true,
      timeoutMs: 120_000,
      maxRetries: 3,
    },
    profiles: {},
    activeProvider: '',
    defaultAgent: '',
    permissions: {
      mode: 'default',
      allow: [],
      deny: [],
    },
    pricing: { input: 0, output: 0, currency: 'USD' },
    disabledSkills: [],
    contextWindow: 128_000,
    autoCompact: true,
    compactThreshold: 0.75,
    maxSteps: 40,
  }
}

/** 磁盘上一份档案的形状：允许只写一部分，剩下的由合并或默认值补 */
type RawProfiles = Record<string, Partial<ProviderProfile>>

/**
 * 磁盘上的配置形状。和 `Partial<ClaudaConfig>` 只差一处：档案允许是半份
 * （例如项目里只想盖掉一个 model），解析完才补成完整的。
 */
type RawConfig = Omit<Partial<ClaudaConfig>, 'profiles'> & { profiles?: RawProfiles }

function readJsonIfExists(file: string): RawConfig {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw) as RawConfig
  } catch (e) {
    process.stderr.write(`[clauda] 配置文件解析失败，已忽略：${file} — ${(e as Error).message}\n`)
    return {}
  }
}

function merge(base: ClaudaConfig, patch: RawConfig): ClaudaConfig {
  return {
    ...base,
    ...patch,
    provider: { ...base.provider, ...(patch.provider ?? {}) },
    // 同 `mcpServers` 必须显式列出：`...patch` 是浅合并，项目配置里只要出现 profiles
    // 这整个键，全局配的那些档案就会被整张顶掉。
    //
    // 但**合并粒度不一样**：`mcpServers` 是「同名整条替换」，档案是**逐字段**合并的。
    // 因为档案是一组平铺的字段，项目里只想换掉 `model` 时整条替换会把地址和密钥一起
    // 抹成内置默认值 —— 那是一个「改一个模型，端点悄悄变成 OpenAI」的坑。
    // 这里合出来的是**半份**档案（项目里可能只盖了一个 model），类型上先当作完整的 ——
    // 唯一补齐它的是 `resolveProfiles`，`loadConfig` 返回前必定跑过一次
    profiles: mergeProfiles(base.profiles, patch.profiles) as Record<string, ProviderProfile>,
    activeProvider: patch.activeProvider ?? base.activeProvider,
    // 新顶层键一律**显式列出**：`...patch` 是浅合并，靠它兜底的话，哪天有个调用方给了
    // `defaultAgent: undefined`（TS 上完全合法），这个键就会被无声抹成 undefined 而不是空串
    defaultAgent: patch.defaultAgent ?? base.defaultAgent,
    permissions: { ...base.permissions, ...(patch.permissions ?? {}) },
    pricing: { ...base.pricing, ...(patch.pricing ?? {}) },
    // **并集**，不是 `??` 覆盖：禁用是「限制」，限制只该越合越紧。覆盖语义下同一个技能
    // 在全局禁过、又被项目那份的整张列表顶掉，结果取决于哪一份后读 —— 没人说得清。
    // 代价是**启用必须两份都清**，否则另一份还说着「禁用」，开关弹不回去（见 setSkillDisabled）
    disabledSkills: [
      ...new Set([...(base.disabledSkills ?? []), ...(patch.disabledSkills ?? [])]),
    ],
    // 必须显式列出：`...patch` 是浅合并，项目配置里只要出现 mcpServers 这一整个键，
    // 全局配的那些服务器就会被整个顶掉。这里按**服务器名**合并，同名时项目级的整体
    // 替换全局的（不做字段级深合并）—— 想改全局某个服务器的单个字段，得把它整个重写。
    mcpServers: { ...(base.mcpServers ?? {}), ...(patch.mcpServers ?? {}) },
  }
}

/**
 * 按档案名逐字段合并：同名档案里给过的字段压过全局那份，没给过的留着。
 *
 * 不写成 `{...base, ...patch}` 是因为那样同名档案会被整条替换，而档案是平铺字段 ——
 * 项目里只想改个模型，结果地址和密钥跟着变成内置默认值，是真会发生的。
 */
function mergeProfiles(base: RawProfiles, patch: RawProfiles | undefined): RawProfiles {
  const out: RawProfiles = { ...base }
  for (const [key, profile] of Object.entries(patch ?? {})) {
    if (!profile || typeof profile !== 'object') continue
    out[key] = { ...(out[key] ?? {}), ...profile }
  }
  return out
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

  // 放在最后：档案要压过 `provider` 段，而命令行参数要压过档案 —— 优先级保持
  // 「默认值 < env < 全局 < 项目 < 命令行」不变，档案是配置文件那一层的产物
  resolveProfiles(cfg)
  return cfg
}

/**
 * 把「档案 + `provider` 段」解析成当前生效的那一份，并把每个档案补成完整的一份。
 *
 * 关键的一步是**把 `provider` 段里那组端点字段折进同名档案**：
 *
 * - 老配置里它们就是全部（那时还没有档案这个概念），按 baseUrl 反推一个名字 (`deepseek`)
 *   折进去，于是老用户升级之后**不写盘也不会丢东西** —— 明文 key、`${DEEPSEEK_API_KEY}`
 *   占位符、项目级 `provider.model` 覆盖、`temperature` 全都照旧生效。这也是 `merge` 里
 *   那个逐字段合的 `provider` 段一直留着的原因。
 * - 折在档案**底下**（`{...遗留, ...档案}`），因为档案是更明确的意图：用户点名了要哪一家。
 * - 折进**同名**那份，而不是垫在当前生效那份下面 —— 后者会让 `profiles.kimi` 从
 *   DeepSeek 那一段继承到地址和密钥，切过去就是把 A 家的 key 发给 B 家。
 *
 * 然后当前那份 = 内置默认值 + `profiles[activeProvider]`，**端点类字段一概以档案为准**，
 * `provider` 段只剩传输旋钮（`includeUsage` / `timeoutMs` / …）。
 *
 * **只在内存里折，绝不写盘。** 打开应用不该改用户的文件；真的要写盘时由
 * `ensureProfileShape` 做同一件事的落盘版本。
 */
function resolveProfiles(cfg: ClaudaConfig): void {
  const declared = cfg.profiles as unknown as RawProfiles

  const legacy = profileFieldsOf(cfg.provider)
  const legacyKey = deriveProfileKey(legacy.baseUrl)
  declared[legacyKey] = { ...legacy, ...declared[legacyKey] }

  // 一个档案都没有过（纯老配置）、或者 activeProvider 指了个不存在的档案（手写 config 的
  // 常见笔误）—— 两种都落到那份遗留档案上。不这么兜的话，当前端点会静默退回内置默认值，
  // 症状是「配置里写着 DeepSeek，跑起来打的是 OpenAI」
  if (!cfg.activeProvider || !declared[cfg.activeProvider]) cfg.activeProvider = legacyKey

  // 缺的字段取内置默认值，**不再回落到 `provider` 段**：那一层已经折进同名档案了，
  // 再回落一次就是把遗留那份的密钥借给别的厂商
  const active = completeProfile(declared[cfg.activeProvider])
  active.baseUrl = normalizeBaseUrl(active.baseUrl)
  // 段里的传输旋钮留着；端点类字段一律以当前档案为准
  cfg.provider = { ...cfg.provider, ...active }

  // 厂商专属环境变量回退，落在**当前这份**上：只在「一个 key 都没配到」时生效 ——
  // 配置文件里写了 key 的永远赢。没有这条，界面上那句「该厂商读 DEEPSEEK_API_KEY」就是假的
  applyVendorEnvKey(cfg.provider)

  const resolved: Record<string, ProviderProfile> = {}
  for (const [key, profile] of Object.entries(declared)) {
    // 当前那份用**解析后的结果**：界面显示的必须就是「切过去会用的那一份」，两边各算
    // 一遍迟早会分叉。其余档案按自己的字段 + 内置默认值补全 —— 上一步已经保证它们
    // 不会继承别人家的端点
    const filled = key === cfg.activeProvider ? profileFieldsOf(cfg.provider) : completeProfile(profile)
    filled.baseUrl = normalizeBaseUrl(filled.baseUrl)
    applyVendorEnvKey(filled)
    resolved[key] = filled
  }
  cfg.profiles = resolved
}

/**
 * 档案 key 由 baseUrl 反推 —— **和 `ProjectInfo.provider.vendorKey` 同一套判据**
 * （`vendorByBaseUrl`，单射）。反推不到就是 `default`：用户手填了地址或用了自建网关，
 * 没有厂商名可用，但档案总得有个名字。
 */
export function deriveProfileKey(baseUrl: string): string {
  return vendorByBaseUrl(baseUrl)?.key ?? 'default'
}

function profileFieldsOf(src: ProviderConfig): ProviderProfile {
  return {
    baseUrl: src.baseUrl,
    apiKey: src.apiKey,
    model: src.model,
    temperature: src.temperature,
    maxTokens: src.maxTokens,
  }
}

/**
 * 把一份**半份**档案补成完整的：给过的字段留着，没给过的取内置默认值。
 *
 * 导出来是给 `SessionManager` 用的 —— 它在内存里也维护着一份档案表（新会话的模板），
 * 加一份档案时得补出同一个形状。两边各补一套的话，设置页显示的字段和真正发出去的
 * 请求会分叉，而症状是「界面上明明没填地址、跑起来却打到了 OpenAI」。
 */
export function completeProfile(profile: Partial<ProviderProfile>): ProviderProfile {
  return { ...DEFAULT_ENDPOINTS, ...profile }
}

/**
 * 档案没写密钥时回落到该厂商的环境变量名。
 *
 * 老代码只在**当前**这份上做这件事，档案多了以后照旧只做当前那份的话，界面会在每个档案
 * 上都说「该厂商读 DEEPSEEK_API_KEY」，而切过去真的不读 —— 又是「照着设了变量然后对着
 * 401 不知道哪儿错了」。本地部署那条 envKey 是空串，天然跳过。
 */
function applyVendorEnvKey(profile: ProviderProfile): void {
  if (profile.apiKey) return
  const envKey = vendorByBaseUrl(profile.baseUrl)?.envKey
  if (envKey) profile.apiKey = process.env[envKey] ?? ''
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
 * 把「接口地址 / 默认模型」写进**某个档案**，返回写到了哪个文件。
 *
 * **必须操作磁盘上的原始文本，不能拿 `loadConfig()` 的结果回写。** 那个结果已经过
 * `expandEnvRefs`，`${MY_KEY}` 在那儿是真实密钥 —— 回写等于把密钥明文落盘。
 * 这里的值只可能来自 `VENDORS` 常量或界面上的手填，从不经过 `loadConfig`。
 *
 * 只改那个档案里给定的键，档案的其它键和文件里别的内容一律原样保留。
 * 文件存在但解析不了时**报错返回、不覆盖**：手滑写坏一个逗号就丢掉整份配置，
 * 比「改了没生效」难受得多。
 *
 * `profileKey` 由调用方给（`SessionManager` 才有「合并之后当前是哪个档案」这个信息）：
 * 不填就落到文件自己声明的那个档案上。这个区分不是洁癖 —— 当前档案定义在**全局**配置里
 * 时，项目这份文件往往连 `profiles` 都没有，落在「文件自己声明的那个」上就成了
 * 往一个空档案里写，用户看到的是改了没反应。
 */
export function writeProjectProvider(
  cwd: string,
  patch: ProjectProviderPatch,
  profileKey?: string,
): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)

  // 没给值的键不要碰：`{ model: undefined }` 展开进去会把磁盘上原有的 model 抹掉
  const given = stripUndefined(patch)

  const key = ensureProfileShape(raw, { profileKey, newBaseUrl: patch.baseUrl })
  const profiles = asObject(raw.profiles)
  profiles[key] = { ...asObject(profiles[key]), ...given }
  raw.profiles = profiles
  // 文件里一个当前档案都没声明过（上面刚补出来的，或干脆是新文件）就认这份
  if (!raw.activeProvider) raw.activeProvider = key

  writeJson(file, raw)
  return file
}

/**
 * 新增（或整体覆盖）一份档案。「添加厂商」走这里。
 *
 * **绝不改当前厂商。** 添加一个厂商不该顺手把正在用的那个换掉 —— 那正是「同时配置多个
 * 厂商」不成立的开始（配 B 之前得先把 B 变成当前，那还叫什么并存）。真要换是
 * `writeActiveProfile` 的事，界面上对应一个显式按钮。
 *
 * `activeKey` 是**合并之后**当前生效的档案名，由调用方给：项目文件里往往没有当前档案
 * （全局配的），第一次落笔得把当时实际生效的那个名字写进去，否则下一次加载会落到
 * 「文件里第一个档案」上 —— 换了一个厂商，而用户什么都没点。
 */
export function writeProjectProfile(
  cwd: string,
  key: string,
  profile: Partial<ProviderProfile>,
  activeKey?: string,
): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)
  ensureProfileShape(raw, { profileKey: key, newBaseUrl: profile.baseUrl, activeKey })

  const profiles = asObject(raw.profiles)
  profiles[key] = { ...asObject(profiles[key]), ...stripUndefined(profile) }
  raw.profiles = profiles

  writeJson(file, raw)
  return file
}

/**
 * 记下「本项目默认用哪个智能体」，空串 = 取消默认。
 *
 * 形状照 `writeActiveProfile`：经 `readJsonObjectForWrite` 读**磁盘原文**（解析不了就抛、
 * 绝不覆盖）、只动 `defaultAgent` 这一个键、**不拿 `loadConfig()` 的结果回写**（那里面
 * `${VAR}` 已经换成真密钥了）。
 *
 * 刻意**不**调 `ensureProfileShape`：那会顺手补出 `profiles` / `activeProvider`，
 * 而这里只该动一个键 —— 用户只是想标个默认智能体，不该发现配置文件多出一截。
 *
 * 存的是**名字**不是路径：智能体可能来自全局目录，也可能被项目里同名的盖掉，
 * 「这一个名字现在指的是哪份文件」是 `AgentRegistry` 的事。
 */
export function writeDefaultAgent(cwd: string, name: string): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)
  raw.defaultAgent = name
  writeJson(file, raw)
  return file
}

/** 切换当前使用的档案。地址与模型本来就是「这一份档案」的属性，不用另外搬 */
export function writeActiveProfile(cwd: string, key: string): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)
  ensureProfileShape(raw, { activeKey: key })
  raw.activeProvider = key
  writeJson(file, raw)
  return file
}

/**
 * 删掉一份档案。**调用方必须先确认它不是当前那份**：把当前档案删掉之后，`activeProvider`
 * 就指向一个不存在的名字，配置会静默退回内置默认值（OpenAI + gpt-4o-mini）。
 */
export function removeProjectProfile(cwd: string, key: string): string {
  const file = configPath(cwd)
  const raw = readJsonObjectForWrite(file)
  const profiles = asObject(raw.profiles)
  delete profiles[key]
  raw.profiles = profiles
  writeJson(file, raw)
  return file
}

/**
 * 新增（或整体覆盖）一个 MCP 服务器，返回写到了哪个文件。
 *
 * `file` 由调用方给（项目级是 `configPath(cwd)`，全局是 `<claudaHome>/config.json`）——
 * 同 `writeProjectProvider` 的 `profileKey`：写哪个文件是调用方才知道的事。
 *
 * 和那份档案写路径共用同一套底线：读**磁盘原文**（`readJsonObjectForWrite`，解析不了就抛、
 * 不覆盖）、只动 `mcpServers[name]` 这一个键、**绝不拿 `loadConfig()` 的结果回写** ——
 * 那里面 `${MY_TOKEN}` 已经被 `expandEnvRefs` 换成了真密钥，回写就是把密钥明文落盘。
 *
 * 同名时**整条替换**，粒度跟 `merge()` 一致（见那里对 mcpServers 的注释）：改一个既有服务器
 * 就是重写它，不做字段级深合并 —— 半覆盖会让「删掉一个 args」变成不可能表达的事。
 */
export function writeMcpServer(file: string, name: string, config: McpServerConfig): string {
  const raw = readJsonObjectForWrite(file)
  const servers = asObject(raw.mcpServers)
  // 没给值的键不要碰：`{ args: undefined }` 展开进去会把磁盘上原有的 args 抹掉
  servers[name] = stripUndefined(config)
  raw.mcpServers = servers
  writeJson(file, raw)
  return file
}

/**
 * 删掉一个服务器，返回**是不是真的删到了**（文件里本来没有这个名字就是 `false`）。
 *
 * 返回布尔值而不是文件路径，是因为调用方要按优先级找文件：服务器可能定义在项目配置里，
 * 也可能只定义在全局配置里，而 `mcpServers` 在 `merge()` 里是「按名字合并」的 ——
 * 合并之后看不出某一条来自哪个文件。项目那份没有就落到全局那份上找。
 *
 * 没删到时**不写盘**：一是没必要为了一个空操作碰用户的文件，二是「两个文件都没有」
 * 这个事实本身就是调用方要的判断依据。
 *
 * 名字不在时不抛 —— 调用方的意图是「删完之后它不在了」，而结果正好如此，重复点一下删除
 * 不该报错。真正的「这个名字压根不存在」由 `McpManager.removeServer` 去抛（它同时管运行期）。
 */
export function removeMcpServer(file: string, name: string): boolean {
  const raw = readJsonObjectForWrite(file)
  const servers = asObject(raw.mcpServers)
  if (!(name in servers)) return false
  delete servers[name]
  raw.mcpServers = servers
  writeJson(file, raw)
  return true
}

/**
 * 把某个服务器从**两处配置**里清掉：先看项目那份，项目里没有才落到全局那份。
 *
 * 为什么要按优先级找而不是让调用方指定：`mcpServers` 在 `merge()` 里是「按名字合并」的，
 * 合并之后**看不出某一条来自哪个文件**，而删除必须落到真正写着它的那一份上 —— 往项目文件
 * 里删一个其实定义在全局的服务器，结果是「点了删除，重启又回来了」。
 *
 * 项目优先而不是全局优先，是为了让「项目里覆盖了全局的同名服务器」这种情况删得干净：
 * 同名时项目那份是生效的那份，用户的「删掉它」指的也是它。
 *
 * 返回真正删到的那个文件；两处都没有则返回 `''`（此时一个字节都没写）。
 */
export function removeMcpServerAnywhere(cwd: string, name: string): string {
  const projectFile = configPath(cwd)
  if (removeMcpServer(projectFile, name)) return projectFile
  const globalFile = path.join(claudaHome(), 'config.json')
  return removeMcpServer(globalFile, name) ? globalFile : ''
}

/**
 * 改一个服务器的工具白名单，返回**这个文件里有没有那一台**。
 *
 * 返回值是「有没有」而不是「写没写」：没写的两种情况是「这台不在这个文件里」（该去下一份
 * 找）和「本来就长这样」（找对了，不必再找）—— 把后者报成 `false` 会让调用方接着去全局
 * 那份找，那里可能正好有个同名的**另一台**服务器，于是改错了对象。
 *
 * 单独一个函数而不是复用 `writeMcpServer`：那个是**整条替换**，只传 `{ tools }` 进去会把
 * `command` / `args` / `env` 一起抹掉 —— 那些是用户手写的，抹掉等于把他配的服务器删了。
 * 这里只碰 `tools` 一个键。底线同 `writeMcpServer`：读磁盘原文、绝不拿 `loadConfig()` 的
 * 结果回写（那里面 `${MY_TOKEN}` 已经变成真密钥了）。
 *
 * `tools` 给 `undefined` 是**删掉这个键**（= 不设白名单，该服务器的工具全接）。注意这不等于
 * 给空数组：`[]` 在 `allowed()` 里是「一个都不许」，那是个能表达的意思，别替用户合并掉。
 */
export function setMcpServerTools(file: string, name: string, tools: string[] | undefined): boolean {
  const raw = readJsonObjectForWrite(file)
  const servers = asObject(raw.mcpServers)
  const entry = servers[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false

  const server = { ...(entry as Record<string, unknown>) }
  const current = Array.isArray(server.tools) ? (server.tools as unknown[]) : undefined
  if (!sameTools(current, tools)) {
    if (tools === undefined) delete server.tools
    else server.tools = tools
    servers[name] = server
    raw.mcpServers = servers
    writeJson(file, raw)
  }
  return true
}

/**
 * 白名单改到**真正定义着那一台**的那份配置里：先看项目那份，项目里没有才落到全局那份。
 *
 * 和 `removeMcpServerAnywhere` 同一条理由：`mcpServers` 在 `merge()` 里按名字合并，合并之后
 * 看不出某一条来自哪个文件 —— 往项目文件里写一个其实定义在全局的服务器，结果是
 * 「改了，重启又变回去了」。返回真正写着它的那个文件；两处都没有则返回 `''`。
 */
export function setMcpServerToolsAnywhere(
  cwd: string,
  name: string,
  tools: string[] | undefined,
): string {
  const projectFile = configPath(cwd)
  if (setMcpServerTools(projectFile, name, tools)) return projectFile
  const globalFile = path.join(claudaHome(), 'config.json')
  return setMcpServerTools(globalFile, name, tools) ? globalFile : ''
}

/** 磁盘上那个值（可能压根没有）和要给的值是不是一回事。空数组和「没设」不是一回事 */
function sameTools(current: unknown[] | undefined, next: string[] | undefined): boolean {
  if (current === undefined || next === undefined) return current === next
  return current.length === next.length && current.every((v, i) => v === next[i])
}

/**
 * 打开 / 关掉一个技能（技能页每行那个开关）。返回**真正改到的文件**，一个都没改就是空数组。
 *
 * 两处不对称，都是被 `merge()` 里那条并集逼出来的：
 *
 * - **关掉只写 `scope` 指的那一份**：用户的动作是「在这个范围里别用它」，写出去的就是这个意思。
 * - **打开要把两份都清掉**。并集语义下「这个名字来自哪一份」在合并之后**看不出来**，只清一份
 *   的话另一份还在说着「禁用」，于是开关弹回去又自己弹回来 —— 同 `removeMcpServerAnywhere`
 *   那条「合并之后看不出某一条来自哪个文件」的教训。
 *
 * 已经是目标状态时**一个字节都不写**（返回空数组）：开关重画时不该顺手碰用户的文件。
 *
 * `scope` 只在「关掉」时有意义 —— 「打开」本来就是「两份都别再说它被禁用」，没有范围可挑。
 */
export function writeSkillDisabled(
  files: { global: string; project: string },
  scope: 'global' | 'project',
  name: string,
  disabled: boolean,
): string[] {
  const targets = disabled ? [files[scope]] : [files.global, files.project]
  const changed: string[] = []
  for (const file of targets) {
    if (toggleDisabledSkill(file, name, disabled)) changed.push(file)
  }
  return changed
}

/**
 * 只动 `disabledSkills` 这一个键，读的是**磁盘原文**（解析不了就抛，不覆盖）——
 * 同 `writeMcpServer` 那套底线：绝不拿 `loadConfig()` 的结果回写，那里面 `$VAR` 已经
 * 被换成真密钥了。
 *
 * 列表空了就把这个键**删掉**而不是留一个 `[]`：配置文件是给人看的，一个空数组只会
 * 让人以为「这里配过什么」。
 */
function toggleDisabledSkill(file: string, name: string, disabled: boolean): boolean {
  const raw = readJsonObjectForWrite(file)
  const current = Array.isArray(raw.disabledSkills)
    ? raw.disabledSkills.filter((x): x is string => typeof x === 'string')
    : []
  if (current.includes(name) === disabled) return false

  const next = disabled ? [...current, name] : current.filter((n) => n !== name)
  if (next.length > 0) raw.disabledSkills = next
  else delete raw.disabledSkills
  writeJson(file, raw)
  return true
}

/**
 * 保证文件里已经有 `profiles` / `activeProvider`，返回该往哪个档案写。
 *
 * 老文件只有 `provider` 段里那组端点字段。第一次落笔时把它们**原样搬**进新档案、并从段里
 * 删掉（段里只留 `timeoutMs` 这类传输旋钮）。搬的是磁盘上的原文，所以
 * `"${DEEPSEEK_API_KEY}"` 搬过去还是占位符，不会变成明文 —— 这是整条写回路径上最要紧的一条。
 *
 * 迁移**只在真的要写盘时**发生（用户点了「存为」/「添加厂商」）。打开应用不该改用户的文件，
 * 所以 `loadConfig` 那条路上一个字节都不写。
 */
function ensureProfileShape(
  raw: Record<string, unknown>,
  opts: { profileKey?: string; newBaseUrl?: string; activeKey?: string } = {},
): string {
  const profiles = asObject(raw.profiles)
  const migrated = Object.keys(profiles).length === 0 ? migrateLegacyProfile(raw, profiles) : ''

  // 往哪个档案写，按可靠性排：调用方给的那个（它知道合并之后当前是谁）> 文件自己声明的
  // > 文件里已有的第一个档案 > 刚迁移出来的那个 > 拿新地址反推。
  //
  // 前两个之外的都是兜底：档案完全可以定义在**别的**文件里（全局配的档案 + 项目里
  // 只盖一个地址），那时「这份文件自己声明的」和「当前生效的」根本不是一回事
  const target =
    opts.profileKey ||
    (typeof raw.activeProvider === 'string' ? raw.activeProvider : '') ||
    Object.keys(asObject(raw.profiles))[0] ||
    migrated ||
    deriveProfileKey(opts.newBaseUrl ?? '')

  // 文件里从来没声明过当前档案才补一个，而且**认调用方说的那个**（合并之后的真相）：
  // 顺手写成 `target` 的话，「给 B 存个地址」会把项目当前厂商悄悄换成 B
  if (!raw.activeProvider) raw.activeProvider = opts.activeKey || target
  return target
}

/**
 * 老文件（端点还住在 `provider` 段里、没有 `profiles`）第一次落笔时的形态迁移：
 * 把那组端点字段**原样搬**进一份新档案并从句里删掉，段里只留 `timeoutMs` 这类传输旋钮。
 *
 * 搬的是磁盘上的原文，所以 `"${DEEPSEEK_API_KEY}"` 搬过去还是占位符，不会变成明文 ——
 * 这是整条写回路径上最要紧的一条。返回搬出来的档案名（没搬就是空串）。
 */
function migrateLegacyProfile(raw: Record<string, unknown>, profiles: Record<string, unknown>): string {
  const section = asObject(raw.provider)
  const moved: Record<string, unknown> = {}
  for (const field of PROFILE_FIELDS) {
    if (section[field] === undefined) continue
    moved[field] = section[field]
    delete section[field]
  }
  if (Object.keys(moved).length === 0) return ''
  raw.provider = section
  const key = deriveProfileKey(String(moved.baseUrl ?? ''))
  profiles[key] = moved
  raw.profiles = profiles
  return key
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * 写回磁盘。文件不存在时连目录一起建（第一次改配置很常见），缩进与尾换行和
 * `writeConfigTemplate` 保持一致 —— 用户会直接读这个文件。
 */
function writeJson(file: string, raw: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
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
    // 想再加一家就照着这个形状往 profiles 里添一份，key 随便起（界面按 key 认档案）。
    // 密钥写成 `${DEEPSEEK_API_KEY}` 这种占位符就不会明文落盘，运行时从环境变量取
    profiles: {
      [preset.key]: {
        baseUrl: preset.baseUrl,
        apiKey: 'sk-替换成你的 key',
        model: preset.models[0],
        temperature: 0,
        maxTokens: 8192,
      },
    },
    // 当前用的是上面哪一份。同时配好几家之后，改这里就等于换厂商（界面上的按钮干的就是这件事）
    activeProvider: preset.key,
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
