import type { ClaudaConfig } from '../config.js'
import type { PermissionManager } from '../permissions.js'
import type { JSONSchema, ToolPermission } from '../types.js'
import type { TodoList } from './todo.js'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  todos: TodoList
  permission: PermissionManager
  config: ClaudaConfig
  /** 命令/子进程的实时输出回调，让用户能看到进度 */
  onOutput?: (chunk: string) => void
}

export interface Tool<A = any> {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
  /**
   * 工具的来源，用于 /tools 分组、/mcp 明细和授权弹窗的风险说明。
   * 不填即内置工具。
   *
   * 注意 `toolSpecs()` 只拷 name/description/parameters/permission 四个字段，
   * 所以这里放什么都不进发给后端的 tools 数组，不影响 token 预算。
   */
  source?: { kind: 'skill' } | { kind: 'memory' } | { kind: 'mcp'; server: string; tool: string }
  /**
   * 这个工具运行后会改变系统提示词的内容，跑完必须重建提示词。
   *
   * 目前只有 `memory_write` 用得上（新写的记忆要当轮就出现在索引里）。做成工具自己的
   * 声明而不是在 agent 循环里判断工具名，是为了让循环不必认识具体工具 —— 同 `source`，
   * `toolSpecs()` 也不会拷它，不影响 token 预算。
   */
  invalidatesPrompt?: boolean
  /** 用于 UI 显示的一行摘要，如 `Read(src/index.ts)` */
  summary(args: A): string
  run(args: A, ctx: ToolContext): Promise<string>
}

/** 参数校验：缺失或类型不对时抛出，由 agent 循环转成 tool result 喂回模型 */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`缺少必填参数 "${key}"（应为非空字符串）`)
  }
  return v
}

/**
 * 和 `requireString` 一样要求参数存在，但**允许空字符串**。
 *
 * 给 `edit_file` 的 new_string 用：显式传空串是合法意图（就是要删掉这段），
 * 而「压根没传」必须报错 —— 两者都落到空串的话，模型漏参数会把原文静默删掉。
 */
export function requireStringOrEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') {
    throw new Error(`缺少必填参数 "${key}"（应为字符串，可为空串）`)
  }
  return v
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}
