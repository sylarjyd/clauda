import type { SkillMeta } from '../skills/types.js'
import { estimateTokens } from '../util/text.js'

/**
 * 只要这两个方法，好让这段逻辑不依赖真的 `SkillRegistry`。
 *
 * **必须两个都要**：`list()` 是现在真正付钱的那份，`listAll()` 是关掉的那些。
 * 只收 `list()` 的话算不出「关掉它们省了多少」，而那个数正是用户做决定要看的东西。
 */
export interface SkillCostSource {
  list(): SkillMeta[]
  listAll(): SkillMeta[]
}

export interface SkillCostNotice {
  /** 现在这份索引每轮要付的 token */
  tokens: number
  /** 关掉的那些若全开着要多付多少。一个都没关就是 0 */
  saved: number
  /** 开着的个数 / 关掉的个数 */
  on: number
  off: number
  /** 有技能时的那句汇总。一个技能都没有时是空串 */
  infoText: string
  /** 占比过高的告警。未超阈值时是空串 */
  warnText: string
}

/** 同 `mcp-cost.ts`：超过这个比例就告警 */
const WARN_RATIO = 0.25

/**
 * 技能索引的上下文开销提示。
 *
 * 技能的正文是**按需载入**的，所以一条技能只值一行「名字 + 一句话说明」—— 但一百多条
 * 加起来就是好几千 token，而且**每轮请求都要付一遍**。这个数字平时完全不可见：技能页
 * 列出一百行，看不出它们正在花钱。所以把它算出来摆在该页页脚。
 *
 * 算法必须和 `system-prompt.ts` 的 `skillsSection()` 拼出来的字符串**同形**，否则这个数
 * 就只是个装饰。两处改动要一起改 —— 那边加个字段、这边不加，数就偏了。
 *
 * **只返回纯文本，不带任何 ANSI 转义**（同 `mcpCostNotice`）：终端那边自己用 `style` 上色，
 * 桌面端要的是能直接进 DOM 的字符串。
 */
export function skillCostNotice(
  /** `undefined` = 这个项目运行时没挂技能注册表（CLI 的 headless、测试里的假 project） */
  skills: SkillCostSource | undefined,
  contextWindow: number,
): SkillCostNotice {
  const on = skills?.list() ?? []
  const all = skills?.listAll() ?? []
  const off = all.length - on.length

  if (all.length === 0) {
    return { tokens: 0, saved: 0, on: 0, off: 0, infoText: '', warnText: '' }
  }

  const tokens = estimateTokens(indexOf(on))
  // 省下的那份按「同样一行的形状」估，和 `tokens` 用的是同一个函数、同一种拼法，
  // 两个数放在一起才可比
  const saved = estimateTokens(indexOf(all)) - tokens

  const infoText =
    off > 0
      ? `技能索引：${all.length} 个里开着 ${on.length} 个，约 +${tokens} token 上下文；` +
        `关掉的 ${off} 个若全开着再多约 +${saved}`
      : `${on.length} 个技能全部开着，约 +${tokens} token 上下文（每轮请求都要付一遍）`

  const warnText =
    tokens > WARN_RATIO * contextWindow
      ? `技能索引已经占掉上下文窗口的 ${Math.round((tokens / contextWindow) * 100)}%，` +
        '会明显提前触发压缩。把暂时用不上的关掉即可，不用删。'
      : ''

  return { tokens, saved, on: on.length, off, infoText, warnText }
}

/** 和 `skillsSection()` 里 `rows` 的拼法保持一致：一行一条，名字加说明 */
function indexOf(list: SkillMeta[]): string {
  return list.map((s) => `- ${s.name}：${s.description || '（未写说明）'}`).join('\n')
}
