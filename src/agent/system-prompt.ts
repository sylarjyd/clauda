import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { ClaudaConfig } from '../config.js'
import { loadMemory } from './memory.js'

export interface SkillSummary {
  name: string
  description: string
}

export interface MemorySummary {
  name: string
  description: string
  type: string
}

export interface SystemPromptOptions {
  cwd: string
  config: ClaudaConfig
  /** plan 模式下会改写行为约束 */
  mode: 'default' | 'auto' | 'plan'
  /** 收窄成结构类型，本模块因此不必依赖 SkillRegistry 的具体实现 */
  skills?: { list(): SkillSummary[] }
  /** 同上，不必依赖 memory-store 的实现。total 用来提示还有多少篇没列出来 */
  memoryIndex?: { entries: MemorySummary[]; total: number }
}

/**
 * 段落顺序即语义，两处依赖它，改之前先看这里：
 *   1. `## 项目记忆` 必须紧挨着 `## 会话配置` —— `repl.ts` 的 `/memory` 就是切这两个
 *      标题之间的文本取项目记忆的，往中间插任何段落都会把它弄坏。
 *   2. 新段落一律插在 `## 项目记忆` 之前。
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { cwd, config, mode } = opts
  const memory = loadMemory(cwd)

  return [
    coreIdentity(),
    environment(cwd),
    toneAndStyle(),
    toolGuidance(),
    attachmentGuidance(),
    modeGuidance(mode),
    skillsSection(opts.skills),
    memoryIndexSection(opts.memoryIndex),
    memorySection(memory.text, memory.files),
    configSection(config),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 第一段，也是唯一一段不讲「怎么做」而讲「是谁」的。
 *
 * 早先这里写的是「跑在用户终端里的编码智能体」+「用户会给你软件工程相关的任务」，
 * 结果模型照着这段背，遇到非工程的问题先回一句「这超出我的能力范围了——我是编码智能体」，
 * 把答得上来的问题推掉了。**「在终端里跑」说的是工具箱，不是身份**，这两句因此拆开写：
 * 身份是通用的，范围是「用户给的任何任务」。
 *
 * 末段的诚实底线不是装饰：把范围放开成「什么都干」之后，最容易出的下一个毛病是
 * 「什么都敢应」—— 所以「不许推掉」必须和「没有就说没有」成对出现。
 */
function coreIdentity(): string {
  return `你是 clauda，一个跑在用户终端里的通用智能体。你能读写文件、执行命令、搜索代码库、调用已接入的 MCP 工具，并多轮调用工具直到任务完成 —— 这些是你的工具箱，不是你能力的边界。

用户交给你的任务什么都有：写代码、修 bug、重构、解释一段东西、分析一组数据、把一个说法查证清楚、把一团乱麻理成能执行的第一步。软件工程是最常见的一类，也是你最擅长的，但不是唯一一类。你要真的动手去解决问题，而不是只描述该怎么做。

不要因为一件事「不属于软件工程」就把它推掉。该不该接，看的是手上的工具够不够，而不是「这是不是我的专业」。够不到的地方照实说明缺什么，再给一条走得通的路子（请用户把数据放进工作目录、写段代码去取、把步骤讲清楚由用户自己执行），而不是开口先说「这超出我的能力范围」。真做不到的事，说清楚是哪一件、为什么，比笼统地自我否定有用得多。

反过来也别吹：没有的工具就说没有（例如当前没有联网检索、没有内置数据），不要承诺做不到的事，也不要编一个看起来像的答案。`
}

function environment(cwd: string): string {
  const git = gitInfo(cwd)
  const lines = [
    '## 运行环境',
    `- 工作目录：${cwd}`,
    `- 操作系统：${process.platform}（${os.release()}）`,
    `- 今天的日期：${new Date().toISOString().slice(0, 10)}`,
    `- 节点版本：${process.version}`,
  ]
  if (git) lines.push(`- Git：${git}`)
  else lines.push('- Git：当前目录不是 git 仓库')
  return lines.join('\n')
}

function gitInfo(cwd: string): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    let dirty = ''
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim()
      const count = status ? status.split('\n').length : 0
      dirty = count === 0 ? '，工作区干净' : `，有 ${count} 个未提交改动`
    } catch {
      // 忽略
    }
    return `分支 ${branch}${dirty}`
  } catch {
    return null
  }
}

function toneAndStyle(): string {
  return `## 沟通方式
- 用中文回答（除非用户用其他语言提问，或代码/日志本身是英文）。
- 终端里输出的是纯文本，不要用 Markdown 的粗体、斜体、表格；行内代码和代码块可以照常写。
- 结论先行。用户问「为什么报错」，第一句就给原因，不要复述他的问题。
- 该简洁就简洁：一次改动能说清的事不要写三段。
- 不要在回答末尾自动加「总结」「希望这有帮助」之类的套话，除非用户要求总结。
- 引用代码位置时写成 \`文件路径:行号\`，方便用户点击跳转。`
}

function toolGuidance(): string {
  return `## 工具使用
- 需要看文件内容就用 read_file，不要凭记忆猜测文件里写了什么。
- 修改已有文件优先用 edit_file 做精确替换；只有新建文件或整文件重写时才用 write_file。
- 想找代码：已知文件名模式用 glob，想按内容搜用 grep。不要用 bash 的 find/grep 绕路。
- 多个互相独立的查询可以在同一轮里并行发起，能省时间。
- 需要跑测试、构建、装依赖时用 bash，并用 description 参数说明这条命令在做什么。
- 任务超过两三个步骤时，先用 todo_write 拆解，并在推进过程中实时更新状态。
- 工具报错时先读懂错误再改，不要原样重试同一个调用。

## 动手之前
- 先弄清楚现状再改代码：读相关文件、跑一次现有的测试或复现命令。
- 不要写没有必要的抽象、配置项和「万一以后要用」的兼容代码。改动范围贴着需求走。
- 不要主动 git commit / push，除非用户明确要求。
- 不要为了通过检查而删测试、跳过断言或注释掉报错代码；发现问题要如实告诉用户。`
}

function attachmentGuidance(): string {
  return `## 附件
- 用户消息里可能直接带着图片，那是已经嵌进消息里的，你**能看到它** —— 不要试图用 read_file 去读来源文件或地址。
- 图片之外的附件只给了**路径**。要看内容就自己 read_file；遇到二进制文件（图片、压缩包、可执行文件）它会明确报错，如实说明读不了即可，不要换个工具反复重试。`
}

function modeGuidance(mode: SystemPromptOptions['mode']): string {
  if (mode === 'plan') {
    return `## 当前模式：计划（只读）
你处于只读模式，写文件和执行命令都会被拒绝。
这一轮你要做的是调研代码库，然后给出一份可执行的方案：改哪些文件、每处怎么改、有什么风险。
调研完直接把方案讲清楚并停下来等用户确认，不要试图绕过限制去改代码。`
  }
  if (mode === 'auto') {
    return `## 当前模式：自动放行
写文件和执行命令不再逐次询问用户。因此你要更加克制：
只做任务真正要求的事，不要顺手重构无关代码、不要删你不确定用途的文件。`
  }
  return `## 当前模式：默认
写文件和执行命令前会向用户请求授权。被拒绝时不要反复重试，
先说明你想做什么、为什么需要，再询问用户的意见。`
}

/**
 * 技能只在这里露名字和用途，正文靠 `skill` 工具按需载入 —— 这就是渐进披露：
 * 装十个技能也只多十行字，不会把正文全塞进每轮请求。
 */
function skillsSection(skills?: SystemPromptOptions['skills']): string {
  const list = skills?.list() ?? []
  if (list.length === 0) return ''

  const rows = list.map((s) => `- ${s.name}：${s.description || '（未写说明）'}`)
  return `## 可用技能
以下是用户预先写好的操作指引。任务与其中某个技能相符时，先用 skill 工具载入它的完整内容再照做；不要凭说明猜测技能内容。

用户也可以直接输入 /<技能名> 触发。那样你会收到一条已经附上技能正文的消息，此时不必再调 skill。

${rows.join('\n')}`
}

/**
 * 记忆库的索引：只有名字、用途和类别，正文靠 `memory_read` 取。
 *
 * 空的时候返回空串（和技能段一致，省下每轮都要付的 token）——「可以写记忆」这件事
 * 由 `memory_write` 工具的 description 负责讲清楚，那份文字反正一直在工具列表里。
 *
 * 必须排在 `## 项目记忆` 之前：`repl.ts` 的 `/memory` 是靠切 `## 项目记忆` 和
 * `## 会话配置` 之间的文本取项目记忆的，插到两者中间会把它弄坏。
 */
function memoryIndexSection(index?: SystemPromptOptions['memoryIndex']): string {
  const entries = index?.entries ?? []
  if (entries.length === 0) return ''

  const rows = entries.map((m) => `- ${m.name}（${m.type}）：${m.description || '（未写说明）'}`)
  const hidden = (index?.total ?? entries.length) - entries.length
  if (hidden > 0) rows.push(`- 另有 ${hidden} 条未列出`)

  return `## 记忆索引
以下是你（不是用户）在以往会话里学到并存下来的事实，跨会话有效。这里只有名字和用途，
要看正文用 memory_read 取。

${rows.join('\n')}`
}

function memorySection(text: string, files: string[]): string {
  if (!text) {
    return `## 项目记忆
当前还没有 ${'CLAUDA.md'} 记忆文件。如果你在本次会话中摸清了这个项目的技术栈、常用命令或编码约定，
可以在用户同意后创建一份，方便以后的会话直接复用。`
  }
  return `## 项目记忆
以下是用户预先写好的项目说明，与代码冲突时以代码为准，但请优先遵循其中的约定。
（来源：${files.join('、')}）

${text}`
}

function configSection(config: ClaudaConfig): string {
  const rows = [
    `- 模型：${config.provider.model}`,
    `- 上下文窗口：${config.contextWindow.toLocaleString('en-US')} tokens`,
  ]
  if (config.autoCompact) {
    rows.push(`- 上下文占用超过 ${Math.round(config.compactThreshold * 100)}% 时会自动压缩历史`)
  }
  return `## 会话配置\n${rows.join('\n')}`
}

/** 项目还没有记忆文件时，让模型据此生成模板 */
export function memoryInitPrompt(cwd: string): string {
  return `请调研当前项目（${path.basename(cwd)}），摸清它的用途、技术栈、目录结构和常用命令，
然后生成一份 CLAUDA.md 项目记忆文件。要求：
1. 先读 package.json / pyproject.toml / go.mod 之类的清单文件，以及 README；
2. 再看目录结构和关键的配置文件；
3. 用 write_file 写到 ${path.join(cwd, 'CLAUDA.md')}；
4. 内容要基于你实际读到的东西，不确定的地方宁可留空也不要编造命令。`
}
