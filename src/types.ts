/**
 * 全局类型定义。
 *
 * 消息一律使用 OpenAI 线格式（wire format）存储，这样 provider 层可以零转换地
 * 直接发给接口，会话落盘后也能原样读回。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** 模型原始输出的 JSON 字符串，原样回传可避免精度/转义差异 */
    arguments: string
  }
}

export interface WireMessage {
  role: Role
  content: string
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** 解析后的工具调用，供内部执行使用 */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  rawArgs: string
}

export interface Usage {
  input: number
  output: number
  /** 命中 prompt cache 的输入 token（部分后端返回） */
  cachedInput?: number
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cachedInput: (a.cachedInput ?? 0) + (b.cachedInput ?? 0),
  }
}

/** JSON Schema 子集，够描述工具参数即可 */
export interface JSONSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export type ToolPermission = 'read' | 'write' | 'exec'

export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
}
