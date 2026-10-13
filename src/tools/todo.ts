import { style, sym } from '../ui/theme.js'
import type { Tool } from './types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm?: string
}

/** 会话级待办清单。模型用它做任务拆解，UI 用它渲染进度。 */
export class TodoList {
  private items: TodoItem[] = []

  set(items: TodoItem[]): void {
    this.items = items
  }

  all(): TodoItem[] {
    return this.items
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  /** 当前未完成的那一条，用于 REPL 的 spinner 文案 */
  current(): TodoItem | undefined {
    return this.items.find((t) => t.status === 'in_progress')
  }

  render(): string {
    const mark = (s: TodoStatus) =>
      s === 'completed' ? style.green(sym.check) : s === 'in_progress' ? style.yellow(sym.pointer) : style.dim('○')
    return this.items
      .map((t) => {
        const label =
          t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content
        const text =
          t.status === 'completed' ? style.dim(t.content) : t.status === 'in_progress' ? style.bold(label) : t.content
        return `  ${mark(t.status)} ${text}`
      })
      .join('\n')
  }

  toJSON(): TodoItem[] {
    return this.items
  }
}

const VALID: TodoStatus[] = ['pending', 'in_progress', 'completed']

export const todoWriteTool: Tool<{ todos: TodoItem[] }> = {
  name: 'todo_write',
  description:
    '创建并更新当前会话的任务清单。用于拆解多步骤任务、让用户看到进度。' +
    '每一步开始时把对应项设为 in_progress，完成后立即设为 completed。' +
    '同一时刻只应有一项处于 in_progress。全部完成后传空数组清空。' +
    '注意：这只是给你自己和用户看的进度板，不要用它代替真正动手做事。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的新清单（全量覆盖，不是增量）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '祈使句形式，如「修复登录超时」' },
            status: { type: 'string', enum: VALID },
            activeForm: { type: 'string', description: '进行中的展示文案，如「正在修复登录超时」' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summary() {
    return '更新任务清单'
  },
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) throw new Error('todos 必须是数组')
    const items: TodoItem[] = []
    for (const raw of args.todos) {
      if (!raw || typeof raw.content !== 'string') continue
      const status: TodoStatus = VALID.includes(raw.status) ? raw.status : 'pending'
      items.push({ content: raw.content, status, activeForm: raw.activeForm })
    }
    ctx.todos.set(items)
    if (items.length === 0) return '任务清单已清空。'
    const done = items.filter((t) => t.status === 'completed').length
    return `任务清单已更新（${done}/${items.length} 已完成）：\n` + items.map((t) => `- [${t.status}] ${t.content}`).join('\n')
  },
}
