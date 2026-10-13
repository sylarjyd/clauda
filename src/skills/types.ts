export interface SkillMeta {
  /** 归一化后的技能名，同时也直接当斜杠命令用 */
  name: string
  description: string
  /** SKILL.md 所在目录 */
  dir: string
  file: string
}
