/**
 * 消息内容的归一化与拼装。
 *
 * 单独一个文件而不是塞进 `text.ts`：那边是**零依赖**的纯文本工具（还被 `ui/` 直接用），
 * 这里要认识 `WireMessage` / `UserAttachment` 这些领域类型。放 `types.ts` 也不合适 ——
 * 那个文件只有类型，没有函数。
 */
import type { ContentPart, UserAttachment, WireMessage } from '../types.js'
import { estimateTokens } from './text.js'

/**
 * 单张图片折算多少 token。
 *
 * **绝不能拿 base64 的长度去估**：一张 2MB 的截图编码后约 270 万字符，按
 * `estimateTokens` 会算出 68 万 token —— `contextTokens()` 当场超过 `contextWindow`，
 * 于是每轮都触发压缩、上下文进度条永远顶格，看着像卡死。图片真正花多少 token 由
 * **像素尺寸**决定（与文件字节数没有稳定关系），而这里不解码图片，只能取定值。
 *
 * 1200 对标 1024×1024 高精度图的实际量级。和 `estimateTokens` 一样**刻意粗糙，
 * 只用于触发压缩**；偏大是安全方向 —— 高估只会让压缩早触发一点。
 */
export const IMAGE_TOKEN_ESTIMATE = 1200

/** 图片在纯文本语境里的占位。摘要、会话标题要的是「曾经有张图」，不是那串 base64 */
const IMAGE_PLACEHOLDER = '[图片]'

/** 只发了附件、一个字没打时的正文。空 text part 有些端点会当成非法请求 */
const ATTACHMENT_ONLY = '（见附件）'

/**
 * 把 content 拍平成纯文本，供**摘要、会话标题、日志**使用。
 *
 * 所有「假定 content 是字符串」的地方都必须先过这里：直接 `.split('\n')` 在数组上会抛，
 * `truncateMiddle(arr, 4000)` 更阴 —— 数组有 `.length` 也有 `.slice`，它不抛，只是把
 * `[object Object],[object Object]` 拼进摘要里。
 *
 * 对**坏形状一律返回 `''` 而不是抛**：会话文件是磁盘上的 JSON，用户可以手改、
 * 也可能是更早版本写的。读取路径必须是全函数，坏数据顶多让标题变空。
 */
export function messageText(content: WireMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const part of content) {
    if (part?.type === 'text') out.push(typeof part.text === 'string' ? part.text : '')
    else if (part?.type === 'image_url') out.push(IMAGE_PLACEHOLDER)
  }
  return out.join('\n')
}

/**
 * content 的 token 估算，口径与 `estimateTokens` 一致，只是多了数组这一支。
 *
 * `estimateTokens` 自己**保持只收 `string`**，不在这里给它加数组兼容：它还被工具
 * schema 那条路叫着（传的是 `JSON.stringify` 后的字符串），改签名只会把错误藏起来。
 */
export function contentTokens(content: WireMessage['content']): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (part?.type === 'text') total += estimateTokens(typeof part.text === 'string' ? part.text : '')
    else if (part?.type === 'image_url') total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

/**
 * 用户这一轮说了什么 —— 正文 + 附件拼成 wire 格式的 content。
 *
 * **没有附件时返回 `string`**（不是长度 1 的数组）：CLI 侧、压缩摘要的回执、以及所有
 * 历史会话走的都是那一支，保持不变才谈得上「provider 层零转换」。
 *
 * 非图片附件在这里落成一段路径清单，而不是另起一个字段：模型看到的是一句话，
 * 与「用户除了正文还附了几个文件」这件事本来就该在同一个位置。
 */
export function buildUserContent(
  text: string,
  attachments: UserAttachment[],
): string | ContentPart[] {
  const images = attachments.filter((a) => a.kind === 'image')
  const files = attachments.filter((a) => a.kind === 'file')
  if (images.length === 0 && files.length === 0) return text

  const parts: ContentPart[] = [{ type: 'text', text: text || ATTACHMENT_ONLY }]
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  if (files.length > 0) {
    parts.push({
      type: 'text',
      text:
        '附件（只给了路径，需要内容请用 read_file；二进制文件读不了就如实告诉用户）：\n' +
        files.map((f) => `- ${f.path}`).join('\n'),
    })
  }
  return parts
}
