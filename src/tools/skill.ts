import type { SkillRegistry } from '../skills/registry.js'
import type { SkillSource } from '../skills/types.js'
import { removeSkill, writeSkill, type SkillScope } from '../skills/writer.js'
import { optionalString, requireString, type Tool } from './types.js'

/**
 * 让模型按需载入技能正文 —— 系统提示词里只有名字和用途，正文走这里取。
 *
 * permission 用 'read' 而不是 'exec'：它只读用户自己写在本地的 markdown，没有副作用。
 * 技能正文里若指示模型去改文件、跑命令，那些动作仍会各自过一遍权限闸门，
 * 所以这里放行不会绕过任何检查；设成 exec 只会让每次用技能都白弹一次授权。
 */
export function makeSkillTool(skills: SkillSource): Tool<{ name: string }> {
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

/** `scope` 参数的取值。给 agent 用时**默认 `project`**，理由见 `makeSkillWriteTool` */
function scopeOf(args: Record<string, unknown>): SkillScope {
  return optionalString(args, 'scope') === 'global' ? 'global' : 'project'
}

/**
 * 让 agent 把一套流程攒成技能。
 *
 * permission 用 'write'：它往磁盘上落一个文件，而且**跨会话留着**。默认模式下值得弹一次
 * 授权；auto 模式直接放行，那是用户自己的选择（同 `memory_write` 的口径）。
 *
 * `invalidatesPrompt` + `invalidatesTools` **都要**：提示词里的「## 可用技能」索引变了，
 * 而且零技能时 `skill` 工具压根不在集合里（见 `tools-assembly.ts` 的条件注入），
 * 不重算的话「刚建的技能当场用不了」。
 *
 * **`scope` 默认 `project`，和设置页表单默认全局正好相反**，这是有意的：用户填表时眼睛
 * 就看着「范围」那一栏，改起来没有成本；agent 是在人不在场的时候动手，往 `~/.clauda/skills`
 * 里塞东西会影响到**每一个**项目 —— 一次误判的半径差着一个数量级。要全局它会显式说。
 */
export function makeSkillWriteTool(skills: SkillRegistry, opts: { cwd: string }): Tool<{
  name: string
  description: string
  body: string
  scope?: string
}> {
  return {
    name: 'skill_write',
    description:
      '把一套可复用的操作流程写成技能（一个 markdown 文件），之后系统提示词的「可用技能」里会出现它，' +
      '需要时用 skill 工具载入。用户说「把这个记成技能」时用它；或你发现自己反复做同一套多步流程，' +
      '也可以主动写。默认写进当前项目（.clauda/skills，跟着项目走、可以提交进 git），' +
      'scope=global 则写进用户主目录的全局技能（所有项目都能用）。同名会**整份覆盖**。' +
      '正文是给以后的你看的操作指引，写清楚步骤和判断依据，别写成一段介绍。',
    permission: 'write',
    source: { kind: 'skill' },
    invalidatesPrompt: true,
    invalidatesTools: true,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名，只能用小写字母、数字和短横线，以字母或数字开头（如 weekly-report）',
        },
        description: { type: 'string', description: '一句话说明这个技能干什么，会进提示词的技能索引' },
        body: { type: 'string', description: '技能正文：具体步骤、命令、判断依据' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'project（默认）只在本项目生效；global 写进主目录，所有项目都能用',
        },
      },
      required: ['name', 'description', 'body'],
    },
    summary: (a) => a?.name ?? '',
    async run(args) {
      const a = args as Record<string, unknown>
      const name = requireString(a, 'name')
      const result = writeSkill({
        scope: scopeOf(a),
        cwd: opts.cwd,
        name,
        description: requireString(a, 'description'),
        body: requireString(a, 'body'),
      })
      // 写完立刻重扫：下面 `invalidatesTools` 触发的重新装配读的就是这份注册表，
      // 漏了这一步会得到一个「文件写了、工具集合里没有」的中间态
      skills.refresh()
      const where = result.created ? '已新建技能' : '已覆盖同名技能'
      return `${where}「${name}」，写在 ${result.file}。现在就能用 skill 工具载入它。`
    },
  }
}

/**
 * 让 agent 删掉一个技能。入参是**名字**不是路径：设置页手里有 `SkillMeta.file`，
 * 而模型只知道「可用技能」列表里的名字，让它拼路径迟早拼错。
 *
 * permission 用 'write' —— 它删的是用户磁盘上的东西，删错了没有回收站。
 *
 * 路径取 `SkillMeta.file`，护栏在 `skills/writer.ts` 的 `removeSkill` 里：目标必须是某个
 * `skills` 根的直接子目录、而且里面真有 SKILL.md。所以这里**不需要**再挡一次 —— 就算
 * 模型瞎报一个名字，走到的也只是「查不到这个名字」。
 */
export function makeSkillRemoveTool(skills: SkillRegistry): Tool<{
  name: string
}> {
  return {
    name: 'skill_remove',
    description:
      '删掉一个技能（连同它的目录）。用户说「不要那个技能了」、或你发现自己刚写坏了一个技能时用它。' +
      '名字取自「可用技能」列表。这是**真删**，没有回收站 —— 确定是这个技能再删。',
    permission: 'write',
    source: { kind: 'skill' },
    invalidatesPrompt: true,
    invalidatesTools: true,
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
      // `find()` 而不是 `get()`：关掉的技能也要删得掉（`get()` 当它不存在）。名字是模型
      // 从「可用技能」里取的，正常情况下取不到关掉的那个，但用户可以直接说「把那个禁用的删了」
      const meta = skills.find(name)
      if (!meta) {
        const available = skills.list().map((s) => s.name)
        throw new Error(
          available.length > 0
            ? `不存在名为 "${name}" 的技能，没删任何东西。可用技能：${available.join('、')}`
            : `不存在名为 "${name}" 的技能，当前没有任何可用技能。`,
        )
      }
      const dir = removeSkill(meta.file)
      skills.refresh()
      return `已删除技能「${name}」（${dir}）。`
    },
  }
}
