import type { PermissionMode } from '../config.js'

/**
 * 智能体的形状。和技能那边同构（`skills/types.ts`），区别只在字段多得多。
 *
 * **智能体是什么**：一整套「你是谁 + 用哪个模型 + 能用哪些工具和技能 + 什么权限 + 开口问
 * 什么」的配方，一个目录一份 `AGENT.md`，在设置页里增删改，**开新会话时绑定**。
 */

/**
 * `list()` 的产物：**不含正文**。
 *
 * 正文要读文件，而 `list()` 会被 `project/info` 每轮拖着走（徽标要显示智能体个数）——
 * 把正文塞进去等于每轮重读一遍所有 `AGENT.md`。要正文走 `resolve()`。
 */
export interface AgentMeta {
  /** 归一化后的名字，同时也是目录名 */
  name: string
  description: string
  /** AGENT.md 所在目录 */
  dir: string
  file: string
  /** 全局那份在 `~/.clauda/agents` 下；项目级在某个 `.clauda/agents` 下 */
  scope: 'global' | 'project'
  /**
   * `config.json` 的 `profiles` 里的 key。空串 = 没写，用项目当前那份。
   * **只有名字，没有端点也没有密钥** —— 智能体文件是要能提交进 git、发给别人的。
   */
  profile: string
  /** 覆盖档案里的模型名。空串 = 不覆盖。模型 id 里真的会带斜杠（`Qwen/Qwen3-32B`） */
  model: string
  /**
   * `undefined` = 没写这个键（用档案的值），**区别于「写了 0」**。
   * 这个区分是逐键覆盖规则的基础，别为了省事把它折成 `0`。
   */
  temperature?: number
  /** `undefined` = 不覆盖，用项目配置的 `permissions.mode` */
  permission?: PermissionMode
  /** 免问规则。`undefined` = 不覆盖；`[]` = 显式清空（文件里写了这个键但没给值） */
  allow?: string[]
  /** 禁用规则。同 `allow` */
  deny?: string[]
  /** 工具名白名单。**空数组 = 不限制**（和 `allow` 的语义不同，那边空是「清空」） */
  tools: string[]
  /** 技能名白名单。空数组 = 不限制 */
  skills: string[]
  /** 新会话空态里的可点问题。空数组 = 不显示空态 */
  questions: string[]
}

/** `resolve()` 的产物：`list()` 那份 + 正文（就是提示词里那一段） */
export interface ResolvedAgent extends AgentMeta {
  body: string
}

/** `ProjectInfo.agents` 的元素：`AgentMeta` 加两个只有拿着项目配置才算得出的字段 */
export interface AgentInfo extends AgentMeta {
  /** 是不是本项目 `config.json` 的 `defaultAgent` */
  isDefault: boolean
  /** 降级提示（如「档案 x 找不到，用的是 y」），空串 = 没事 */
  problem: string
}

/**
 * **建会话那一刻解析好的**智能体，随会话落盘。
 *
 * 存的是快照而不是名字：用户选定的规则是「改一个智能体只影响之后新开的会话」，按名字
 * 重读磁盘会让「我把审查员调紧了一点」在所有老会话上一起生效。冻结还顺手买到两件事 ——
 * 删掉一个智能体之后老会话照样原样打开，恢复路径也少一次磁盘 IO。
 *
 * **绝不能出现 `apiKey` / `baseUrl`**：会话文件是磁盘上的明文 JSON，而 `config.json` 里的
 * 密钥可能正是 `${DEEPSEEK_KEY}` 这种占位符 —— 抄一份进去等于把「密钥只留在一处」当面拆掉。
 * 端点与密钥照旧在恢复时从**当时的** config 取，所谓「冻结」只发生在一次活着的会话内部。
 */
export interface AgentSpec {
  name: string
  /** `AGENT.md` 的正文，就是系统提示词里那一段 */
  prompt: string
  profile?: string
  model?: string
  temperature?: number
  permission?: PermissionMode
  allow?: string[]
  deny?: string[]
  /** 空 / 缺省表示不限制 */
  tools?: string[]
  /** 同上 */
  skills?: string[]
  questions?: string[]
}

/** 宽接口：`AgentSpec` 和 `AgentMeta` / `ResolvedAgent` 都能直接喂进来（只读 `tools`） */
export interface HasTools {
  tools?: string[]
}

/** 同上，只读 `skills` */
export interface HasSkills {
  skills?: string[]
}
