import { listMemories, readMemory, writeMemory } from '../agent/memory-store.js'
import { optionalString, requireString, type Tool } from './types.js'

/**
 * 记忆库的两个工具。和技能工具一样**不进 `ALL_TOOLS`** —— 那个数组是 7 个内置工具的
 * 稳定集合，测试和上下文核算的硬约束都钉在它上面，一律靠 `AgentOptions.tools` 注入。
 *
 * 和技能工具不同的一点：这里不做「有没有记忆」的条件注入。没有记忆时恰恰是最需要
 * `memory_write` 的时候，藏起来就永远写不进第一条。
 */
export function makeMemoryTools(): Tool[] {
  return [makeMemoryReadTool(), makeMemoryWriteTool()]
}

/**
 * 系统提示词的「记忆索引」里只有名字和用途，正文走这里取 —— 和技能同一套渐进披露。
 *
 * permission 用 'read'：它只读模型自己写在本地目录里的 markdown，没有副作用。
 */
function makeMemoryReadTool(): Tool<{ name: string }> {
  return {
    name: 'memory_read',
    description:
      '读取一条记忆的完整内容。系统提示词的「记忆索引」列出了所有记忆的名字和用途，' +
      '需要其中某条的正文时调用，不要凭用途描述猜测内容。',
    permission: 'read',
    source: { kind: 'memory' },
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆名，取自「记忆索引」列表' },
      },
      required: ['name'],
    },
    summary: (a) => a?.name ?? '',
    async run(args) {
      const name = requireString(args as any, 'name')
      const got = readMemory(name)
      if (!got) {
        const available = listMemories().entries.map((m) => m.name)
        throw new Error(
          available.length > 0
            ? `不存在名为 "${name}" 的记忆。可用记忆：${available.join('、')}`
            : `不存在名为 "${name}" 的记忆，记忆库当前是空的。`,
        )
      }
      return `## 记忆：${got.meta.name}（${got.meta.type}）\n\n${got.body}`
    },
  }
}

/**
 * permission 用 'write'：记忆是**跨会话**的持久状态，写错了会跟着用户进之后的每一次
 * 会话。默认模式下值得为它弹一次授权；auto 模式下会直接放行，那是用户自己的选择。
 */
function makeMemoryWriteTool(): Tool<{
  name: string
  description: string
  type?: string
  body: string
}> {
  return {
    name: 'memory_write',
    description:
      '把值得跨会话记住的事实写进记忆库。用户说「记住」时用它；' +
      '或你学到了关于用户的偏好、某个下次还会踩的坑，也可以主动写。' +
      '一条只放一个事实，同名的会覆盖。别和项目记忆 CLAUDA.md 混：那是用户手写的，由用户维护。',
    permission: 'write',
    source: { kind: 'memory' },
    // 新写的记忆要当轮就出现在「记忆索引」里，否则模型刚记下的事这一轮自己都看不见
    invalidatesPrompt: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '英文 slug，如 git-commit-chinese，同名即覆盖' },
        description: { type: 'string', description: '一句话说明这条记忆讲什么，会进提示词的索引' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'user 关于用户本人；feedback 用户对你工作方式的指正或认可；' +
            'project 正在做的事与约束；reference 外部资源位置',
        },
        body: { type: 'string', description: '事实本身，一条只写一件事' },
      },
      required: ['name', 'description', 'body'],
    },
    summary: (a) => a?.name ?? '',
    async run(args) {
      const a = args as Record<string, unknown>
      const result = writeMemory({
        name: requireString(a, 'name'),
        description: requireString(a, 'description'),
        type: optionalString(a, 'type'),
        body: requireString(a, 'body'),
      })
      // 明确区分「新建」和「更新」：模型据此知道自己是补充了一条还是改掉了原有的事实
      return result.created
        ? `已记住：${result.name}`
        : `已更新既有记忆：${result.name}（同名覆盖，旧内容已被替换）`
    },
  }
}
