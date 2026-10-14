export interface SkillMeta {
  /** 归一化后的技能名，同时也直接当斜杠命令用 */
  name: string
  description: string
  /** SKILL.md 所在目录 */
  dir: string
  file: string
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
