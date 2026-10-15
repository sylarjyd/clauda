export interface SkillMeta {
  /** 归一化后的技能名，同时也直接当斜杠命令用 */
  name: string
  description: string
  /** SKILL.md 所在目录 */
  dir: string
  file: string
  /**
   * 被 `config.disabledSkills` 关掉了。**`list()` 里恒为 false** —— 关掉的技能根本不在
   * 那份名单里，只有 `listAll()` 会给到 `true`。设置页要靠后者才能把它关回去。
   *
   * 标在 meta 上而不是让每个调用点自己查一遍，是因为「关掉的算不算存在」要在**一个**地方
   * 回答：提示词、`skill` 工具、斜杠命令、设置页四处各查一遍，迟早有一处忘了。
   */
  disabled: boolean
}

/**
 * 「一批只读的技能」。
 *
 * `SkillRegistry` 天然满足它（四个方法都是公开的，私有字段不挡结构赋值）；而**按智能体
 * 白名单收窄出来的技能视图**也满足它 —— `skillsSection()` 和 `skill` 工具因此一行都不用改，
 * 它们拿到的就是个「只有这些技能的注册表」。
 *
 * 不含 `refresh()`：那是**改**注册表，而收窄出来的视图没有自己的名单可刷（它每次转发给
 * 项目那份真注册表，那边刷了它自动跟着变）。所以增删技能的两个工具仍旧直接收
 * `SkillRegistry`。
 */
export interface SkillSource {
  list(): SkillMeta[]
  get(name: string): SkillMeta | undefined
  has(name: string): boolean
  read(name: string): string | null
}

/**
 * 设置页和「增删技能」那几个口子。**刻意不并进 `SkillSource`**：那个接口是给「喂给模型的
 * 那一份」用的，而按智能体白名单收窄出来的视图它也是 `SkillSource` —— 视图没有「全部」可言，
 * 转发 `listAll()` 只会得到一份不完整、看着却像完整的名单；`setDisabled()` 更离谱，
 * 那是在改注册表，视图连自己的开关都没有。所以只有真注册表满足这个接口。
 */
export interface SkillAdmin {
  /** 连关掉的一起列。设置页要靠它把关掉的再打开 */
  listAll(): SkillMeta[]
  /** 不管开没开都找得到。删除路径用 —— `get()` 对关掉的返回 undefined，会让它删不掉 */
  find(name: string): SkillMeta | undefined
  /** 当场生效（落盘由调用方负责） */
  setDisabled(names: string[]): void
}
