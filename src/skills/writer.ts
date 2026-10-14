import fs from 'node:fs'
import path from 'node:path'
import { claudaHome } from '../config.js'
import { NAME_RE, SKILL_FILENAME } from './registry.js'

/**
 * 技能的写路径。在这之前技能**只能靠手写文件**才能出现 —— 设置页只读，对话里更是
 * 没有办法把它学到的东西留下来。
 *
 * 形状抄的是 `agent/memory-store.ts` 的 `writeMemory`：那边早就实现了「对话中途写一个
 * markdown 文件」，而且是同一件事（一条要跨会话留下来的本地文本）。
 */

/** 写哪儿。`global` 配一次到处能用；`project` 跟着项目走，可以提交进 git */
export type SkillScope = 'global' | 'project'

export interface WriteSkillInput {
  scope: SkillScope
  cwd: string
  name: string
  /** 一句话说明，进系统提示词的「## 可用技能」索引 */
  description: string
  body: string
}

export interface WriteSkillResult {
  file: string
  /** 新建还是覆盖既有同名技能 —— 调用方据此说「已新建」还是「已替换」 */
  created: boolean
}

/**
 * 技能根目录。与 `registry.ts` 的发现顺序对应：全局那份 + 项目 `cwd` 那一级。
 *
 * 发现还会扫沿途各级祖先的 `.clauda/skills`，但**写只写 cwd 这一级** ——
 * 往父目录写是用户没要求过的动作（他可能只是在子目录里开着项目）。
 */
export function skillRoot(scope: SkillScope, cwd: string): string {
  return scope === 'global' ? path.join(claudaHome(), 'skills') : path.join(cwd, '.clauda', 'skills')
}

/**
 * 写一个技能：`<root>/<name>/SKILL.md`。
 *
 * 名字按 `NAME_RE` 校验后**照用**，不 slugify。`registry.ts` 在读的时候会对不合规的名字
 * 退回目录名，所以这里要是静默改名，「界面上显示的名字」和「目录名」就会对不上 ——
 * 那种问题查起来毫无头绪。宁可当场报错，让调用方去改。
 */
export function writeSkill(input: WriteSkillInput): WriteSkillResult {
  const name = input.name.trim()
  if (!NAME_RE.test(name)) {
    throw new Error(
      `技能名「${input.name}」不合规：只能用小写字母、数字和短横线，且要以字母或数字开头（如 weekly-report）`,
    )
  }

  const dir = path.join(skillRoot(input.scope, input.cwd), name)
  const file = path.join(dir, SKILL_FILENAME)
  const created = !fs.existsSync(file)

  // frontmatter 只认单行 `key: value`（见 `frontmatter.ts` 的 KEY_VALUE），
  // 说明里带换行会把格式撑破，先压平 —— 和 `writeMemory` 同一个理由
  const description = flatten(input.description)
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { file, created }
}

/**
 * 删掉一个技能。入参是 `SkillMeta.file`（设置页从 `project.skills` 里就有，路径精确）。
 *
 * **两条护栏，一条都不能少**：目标目录必须是某个 `skills` 根的直接子目录，而且里面真的
 * 有 `SKILL.md`。少了它们，一个手滑的入参就能让这里递归删掉任意目录 —— 这个函数会
 * 一路走到 `rmSync(recursive)`，值得比平时多疑一点。
 */
export function removeSkill(file: string): string {
  const dir = path.dirname(path.resolve(file))
  const parent = path.basename(path.dirname(dir))
  if (parent !== 'skills') {
    throw new Error(`拒绝删除：${dir} 不在 skills 目录下`)
  }
  if (!fs.existsSync(path.join(dir, SKILL_FILENAME))) {
    throw new Error(`拒绝删除：${dir} 里没有 ${SKILL_FILENAME}，不像是一个技能`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}

/**
 * 压平换行，免得撑破 frontmatter 的单行格式。
 *
 * 导出是给 `agents/writer.ts` 复用的：智能体的 frontmatter 是同一个解析器读的，同一条
 * 限制、同一个错法。各写一份的话，将来在这里补一条规则（比如顺手去掉 tab），那边不会跟着变。
 */
export function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}
