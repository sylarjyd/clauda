import type { SkillRegistry } from '../skills/registry.js'
import { requireString, type Tool } from './types.js'

/**
 * 让模型按需载入技能正文 —— 系统提示词里只有名字和用途，正文走这里取。
 *
 * permission 用 'read' 而不是 'exec'：它只读用户自己写在本地的 markdown，没有副作用。
 * 技能正文里若指示模型去改文件、跑命令，那些动作仍会各自过一遍权限闸门，
 * 所以这里放行不会绕过任何检查；设成 exec 只会让每次用技能都白弹一次授权。
 */
export function makeSkillTool(skills: SkillRegistry): Tool<{ name: string }> {
  return {
    name: 'skill',
    description:
      '载入指定技能的完整操作指引。系统提示词的「可用技能」一节列出了所有技能名与用途，' +
      '当任务与其中某个技能相符时调用本工具，然后严格按返回的内容执行。' +
      '不要凭用途描述猜测技能内容。',
    permission: 'read',
    source: { kind: 'skill' },
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名，取自「可用技能」列表' },
      },
      required: ['name'],
    },
    summary: (a) => a?.name ?? '',
    async run(args) {
      const name = requireString(args as any, 'name')
      const meta = skills.get(name)
      const body = meta ? skills.read(name) : null
      if (!meta || body === null) {
        const available = skills.list().map((s) => s.name)
        throw new Error(
          available.length > 0
            ? `不存在名为 "${name}" 的技能。可用技能：${available.join('、')}`
            : `不存在名为 "${name}" 的技能，当前没有任何可用技能。`,
        )
      }
      return `## 技能：${meta.name}\n\n${body}`
    },
  }
}
