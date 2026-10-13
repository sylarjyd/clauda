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

/**
 * 多模态内容块，用 OpenAI 自己的叫法（content part）。
 *
 * **只声明我们真正会产生的那两种**：用户消息里的一段文字、用户附上来的一张图片。
 * 别处一律仍然是纯字符串 —— 模型返回方向、工具结果、系统提示词、压缩摘要都不碰它，
 * 那几条路径因此一行都不用改。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  /** `url` 是 `data:image/...;base64,...`。CSP 已放行 data:（见 index.html） */
  | { type: 'image_url'; image_url: { url: string } }

export interface WireMessage {
  role: Role
  /**
   * 纯文本时**仍然是字符串**，不是「长度为 1 的数组」。
   *
   * 这是本次改动能这么小的根本原因：老会话文件、压缩摘要、工具结果、系统提示词
   * 全都落在 `string` 那一支上，读回、落盘、比较一个字都不用动。数组只有一种来源
   * —— 用户消息里带了图片。
   */
  content: string | ContentPart[]
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/**
 * 用户附带的一个文件，**已经归一化过**的形状（renderer 报上来的是另一种原始形状，
 * 见 `src/runtime/attachment.ts`）。state.js 里对应的是同一份形状 —— renderer 走
 * `app://` 拿不到 dist，那份只能手抄，注释互相指一下。
 */
export type UserAttachment =
  /** 图片：字节已经读成 data URL，随消息一起留在历史里 */
  | { kind: 'image'; name: string; dataUrl: string; bytes: number }
  /** 图片之外的一切：**只有路径**，要看内容得模型自己 read_file */
  | { kind: 'file'; name: string; path: string; bytes: number }

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
