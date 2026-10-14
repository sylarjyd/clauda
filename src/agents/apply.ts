import type { ClaudaConfig, PermissionMode } from '../config.js'
import { normalizeToolName } from '../permissions.js'
import type { SkillMeta, SkillSource } from '../skills/types.js'
import type { AgentSpec, HasSkills, HasTools, ResolvedAgent } from './types.js'

/**
 * 「把一份智能体折进会话」的那几件事。
 *
 * 放在一个模块里而不是各调用点各写各的，理由同 `tools-assembly.ts` 那条注释：装配配方
 * 一旦分叉，桌面端和 CLI 就会用上两份不一样的智能体语义。
 */

/**
 * 把解析好的智能体**就地**折进会话配置。逐键各管各的：**写了就盖，没写就沿用**。
 *
 * 顺序有意如此：先用档案铺一层基线（`profile` 指的那份不是当前在用的那份，整件事的意义
 * 就在这儿 —— 「用 DeepSeek 但换一个模型」），再用 `model` / `temperature` 盖上。
 *
 * 取的是 `config.profiles[profile]` 里**已经解析过**的那份（`loadConfig` 跑过
 * `resolveProfiles`，端点归一化、厂商环境变量回退都做完了），所以这里**绝不能重跑
 * `loadConfig`** —— 那会读一遍磁盘、还可能把项目的其它覆盖盖掉。
 *
 * `profile` 指向一份不存在的档案时**什么都不做**（退回项目当前那份），由
 * `agentProfileProblem()` 出一条提示让界面标出来：静默换档案会让人对着一个「明明配了
 * DeepSeek 却在跑 Kimi」的会话查半天。
 */
export function applyAgentToConfig(config: ClaudaConfig, spec: AgentSpec): void {
  const profile = spec.profile ? config.profiles[spec.profile] : undefined
  if (profile) {
    config.provider.baseUrl = profile.baseUrl
    config.provider.apiKey = profile.apiKey
    config.provider.model = profile.model
    config.provider.temperature = profile.temperature
    config.provider.maxTokens = profile.maxTokens
  }
  if (spec.model) config.provider.model = spec.model
  // `!== undefined` 不是真值判断：写了 0 是有效配置，按真值判会静默变成「用档案的温度」
  if (spec.temperature !== undefined) config.provider.temperature = spec.temperature

  if (spec.permission !== undefined) config.permissions.mode = spec.permission
  // `[]` 也是有效值（显式清空），所以同样按 undefined 判
  if (spec.allow !== undefined) config.permissions.allow = [...spec.allow]
  if (spec.deny !== undefined) config.permissions.deny = [...spec.deny]
}

/**
 * 这个工具在不在该智能体的手上。
 *
 * 判据和 `permissions.ts` 的 `matchOne` 前缀规则同源：`mcp__linear` 盖住
 * `mcp__linear__create_issue`，`mcp` 盖住所有 MCP 工具。两边都过 `normalizeToolName`，
 * 于是 `read_file` / `Read` / `readfile` 是同一个名字。**不支持 `(pattern)` 参数级规则**
 * （MCP 工具本就不支持）。
 *
 * 白名单为空 = 不限制。
 */
export function agentAllowsTool(agent: HasTools | undefined, name: string): boolean {
  const list = agent?.tools
  if (!list || list.length === 0) return true
  const normTool = normalizeToolName(name)
  return list.some((n) => {
    const norm = normalizeToolName(n)
    return norm.length > 0 && (norm === normTool || normTool.startsWith(norm + '__'))
  })
}

/**
 * 按智能体的技能白名单收窄出来的**技能视图**。
 *
 * 视图是**委托**：`list/get/has/read` 全部转发给项目那份真注册表再按名字过滤，所以真注册表
 * `refresh()` 之后视图自动跟着变，不用单独刷。白名单为空（或没有智能体）时**原样返回**
 * 真注册表 —— 这时不该多一层转发。
 *
 * `skillsSection()` 和 `makeSkillTool()` 因此一行都不用改：它们拿到的就是个「只有这些技能的
 * 注册表」。收窄的效果是双份的 —— 提示词里的「可用技能」索引和 `skill` 工具能载入的范围。
 */
export function scopedSkills(skills: SkillSource, agent: HasSkills | undefined): SkillSource {
  const allow = agent?.skills
  if (!allow || allow.length === 0) return skills
  const wanted = new Set(allow)
  return {
    list: (): SkillMeta[] => skills.list().filter((s) => wanted.has(s.name)),
    get: (name: string): SkillMeta | undefined => (wanted.has(name) ? skills.get(name) : undefined),
    has: (name: string): boolean => wanted.has(name) && skills.has(name),
    read: (name: string): string | null => (wanted.has(name) ? skills.read(name) : null),
  }
}

/**
 * 解析好的一份 ——→ 随会话落盘的冻结快照。
 *
 * 只搬装配用得到的字段：`dir` / `file` / `scope` / `description` 是注册表和界面的事，
 * 会话快照里留着它们只会让会话文件变大，还多一份要跟着 `AGENT.md` 走样的东西。
 * **端点与密钥一个字都不进来**（见 `AgentSpec` 的注释）。
 */
export function toSpec(r: ResolvedAgent): AgentSpec {
  return {
    name: r.name,
    prompt: r.body,
    profile: r.profile || undefined,
    model: r.model || undefined,
    temperature: r.temperature,
    permission: r.permission,
    allow: r.allow,
    deny: r.deny,
    // 空数组 = 不限制，和「没这个字段」一个意思，没必要落进会话文件
    tools: r.tools.length > 0 ? [...r.tools] : undefined,
    skills: r.skills.length > 0 ? [...r.skills] : undefined,
    questions: r.questions.length > 0 ? [...r.questions] : undefined,
  }
}

/**
 * `AgentSpec` 里的档案名在不在。不在就返回一句人话，界面把它标在那一行下面 ——
 * **不能让用户自己发现**自己配的档案没了。
 */
export function agentProfileProblem(
  meta: { profile: string },
  profiles: Record<string, unknown>,
): string {
  if (!meta.profile) return ''
  return meta.profile in profiles ? '' : `档案 ${meta.profile} 不存在，用的是项目当前那份`
}

/**
 * 把磁盘上读回来的一个 `agent` 键过一遍形状。**坏数据降级，不崩**。
 *
 * 会话文件是明文 JSON、手改得坏，而 `isSessionRecord`（`agent/session.ts`）刻意不验它
 * —— 所以坏的那一份必须在这里被挡住，退回「这条会话没有智能体」。缺 `name` 或 `prompt`
 * 就当没有：没有名字没法显示、没有正文这份快照就没有意义。
 */
export function readAgentSpec(v: unknown): AgentSpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name.length === 0) return undefined
  if (typeof o.prompt !== 'string') return undefined

  const spec: AgentSpec = { name: o.name, prompt: o.prompt }
  if (typeof o.profile === 'string' && o.profile) spec.profile = o.profile
  if (typeof o.model === 'string' && o.model) spec.model = o.model
  if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) {
    spec.temperature = o.temperature
  }
  const p = o.permission
  if (p === 'default' || p === 'auto' || p === 'plan') spec.permission = p as PermissionMode

  for (const key of ['allow', 'deny', 'tools', 'skills', 'questions'] as const) {
    const raw = o[key]
    if (!Array.isArray(raw)) continue
    const list = raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
    if (list.length > 0) spec[key] = list
  }
  return spec
}
