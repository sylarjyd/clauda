import fs from 'node:fs'
import path from 'node:path'
import { claudaHome, type PermissionMode } from '../config.js'
import { NAME_RE } from '../skills/registry.js'
import { flatten } from '../skills/writer.js'
import { AGENT_FILENAME } from './registry.js'

/**
 * 智能体的写路径。形状抄 `skills/writer.ts` 的 `writeSkill`：同一个目录 + 一份 markdown
 * 的存法，同一个「不合规就当场报错、别静默改名」的底线。
 */

/** 写哪儿。`global` 到处能用；`project` 跟着项目走，可以提交进 git */
export type AgentScope = 'global' | 'project'

export interface WriteAgentInput {
  scope: AgentScope
  cwd: string
  name: string
  /** 一句话说明，列表里显示 */
  description: string
  /** 系统提示词正文 */
  body: string
  profile?: string
  model?: string
  temperature?: number
  permission?: PermissionMode
  allow?: string[]
  deny?: string[]
  tools?: string[]
  skills?: string[]
  questions?: string[]
}

export interface WriteAgentResult {
  file: string
  /** 新建还是覆盖既有同名智能体 —— 调用方据此说「已新建」还是「已保存」 */
  created: boolean
}

/**
 * 智能体根目录。与 `registry.ts` 的发现顺序对应：全局那份 + 项目 `cwd` 那一级。
 *
 * 同技能：发现会扫沿途各级祖先，但**写只写 cwd 这一级** —— 往父目录写是用户没要求过的动作。
 */
export function agentRoot(scope: AgentScope, cwd: string): string {
  return scope === 'global' ? path.join(claudaHome(), 'agents') : path.join(cwd, '.clauda', 'agents')
}

/**
 * 写一个智能体：`<root>/<name>/AGENT.md`。同名**整份覆盖** —— 所以它同时是「新建」和「保存」。
 *
 * 名字按 `NAME_RE` 校验后**照用**，不 slugify：注册表读的时候会对不合规的名字退回目录名，
 * 所以这里静默改名会让「界面上的名字」和「目录名」对不上。宁可当场报错，让调用方去改。
 *
 * **只写给出过的键**：没给 `temperature` 就不该在文件里留下 `temperature:` 一行 ——
 * 那一行读回来是「写了 0」的意思，会把档案的温度钉死。同理，空数组当作没给。
 */
export function writeAgent(input: WriteAgentInput): WriteAgentResult {
  const name = input.name.trim()
  if (!NAME_RE.test(name)) {
    throw new Error(
      `智能体名「${input.name}」不合规：只能用小写字母、数字和短横线，且要以字母或数字开头（如 code-review）`,
    )
  }
  // 正文里出现这两个标题会让 `/memory` 打印一堆垃圾（它按这两个标题切片，切的是第一处）。
  // 段本身插在它们之前所以一般撞不上，但用户手写正文时完全可能顺手写一个同名的二级标题。
  // 这里拒收最便宜，而且可测。
  const clash = /^##\s*(项目记忆|会话配置)\s*$/m.exec(input.body)
  if (clash) {
    throw new Error(
      `正文里不能再出现 "${clash[0].trim()}" 这个标题：它是系统提示词的内部结构，重复会让 /memory 显示错乱。` +
        '改写成别的标题即可。',
    )
  }

  const dir = path.join(agentRoot(input.scope, input.cwd), name)
  const file = path.join(dir, AGENT_FILENAME)
  const created = !fs.existsSync(file)

  const lines = [`name: ${name}`]
  const description = flatten(input.description)
  if (description) lines.push(`description: ${description}`)
  if (input.profile) lines.push(`profile: ${flatten(input.profile)}`)
  // 模型 id 里带斜杠是合法的（`Qwen/Qwen3-32B`），只压平换行，不碰别的字符
  if (input.model) lines.push(`model: ${flatten(input.model)}`)
  // 用 `!== undefined` 而不是真值判断：**写了 0 是有效配置**，丢掉它就等于「温度设置不生效」
  if (input.temperature !== undefined) lines.push(`temperature: ${input.temperature}`)
  if (input.permission) lines.push(`permission: ${input.permission}`)
  pushList(lines, 'allow', input.allow)
  pushList(lines, 'deny', input.deny)
  pushList(lines, 'tools', input.tools)
  pushList(lines, 'skills', input.skills)
  if (input.questions && input.questions.length > 0) {
    lines.push(`questions: ${input.questions.map(flattenQuestion).filter(Boolean).join(' | ')}`)
  }

  const content = `---\n${lines.join('\n')}\n---\n\n${input.body.trim()}\n`

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { file, created }
}

/** 逗号分隔的标识符列表。空 / 没给都不写这一行（缺省语义是「不覆盖」，见 `types.ts`） */
function pushList(lines: string[], key: string, list: string[] | undefined): void {
  if (!list || list.length === 0) return
  const items = list.map((s) => flatten(s)).filter((s) => s.length > 0)
  if (items.length > 0) lines.push(`${key}: ${items.join(', ')}`)
}

/**
 * 一条常见问题。
 *
 * `|` 是这一栏的分隔符 —— 也就是说它**是保留字符**，问题里带一个就会把这一条切成两条。
 * 换成全角 `｜`：视觉上几乎看不出差别，但读回来是一条完整的话。这比在读写两边各写一套转义
 * 便宜得多，而用户看不出自己踩了雷是更糟的结果。
 */
function flattenQuestion(q: string): string {
  return flatten(q).replace(/\|/g, '｜')
}

/**
 * 删掉一个智能体（连同它的目录）。入参是 `AgentMeta.file`（设置页手里就有，路径精确）。
 *
 * **两条护栏，一条都不能少**：目标目录必须是某个 `agents` 根的直接子目录，而且里面真的
 * 有 `AGENT.md`。少了它们，一个手滑的入参就能让这里递归删掉任意目录 —— 同 `removeSkill`。
 */
export function removeAgent(file: string): string {
  const dir = path.dirname(path.resolve(file))
  const parent = path.basename(path.dirname(dir))
  if (parent !== 'agents') {
    throw new Error(`拒绝删除：${dir} 不在 agents 目录下`)
  }
  if (!fs.existsSync(path.join(dir, AGENT_FILENAME))) {
    throw new Error(`拒绝删除：${dir} 里没有 ${AGENT_FILENAME}，不像是一个智能体`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}
