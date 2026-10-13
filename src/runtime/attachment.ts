import fs from 'node:fs'
import path from 'node:path'
import type { UserAttachment } from '../types.js'
import { formatBytes } from '../util/text.js'

/**
 * 用户在输入框里附上来的文件，归一化成 `UserAttachment`。
 *
 * 两个入口，分工是刻意的：
 * - `ingestAttachments`（**碰 fs**）：renderer 一拖进 / 粘上 / 选好就调一次，
 *   把字节读成 data URL。所以「图片太大」「这个文件没有路径」在**添加的那一刻**
 *   就能报出来，而不是发出去才失败 —— 而且图文预览也需要字节，攒到发送时再读根本画不出来。
 * - `sanitizeAttachments`（**纯函数**）：`session/send` 收到 renderer 回传的那份
 *   描述符时再核一遍形状。renderer 是自己的代码，但「不信任送进来的字符串」是这个
 *   仓库一贯的规矩（见 `tools/fs.ts` 的路径校验），何况这里一放手就是几十 MB 的 base64。
 */

/** 单张图片上限。再大就该压缩了，而这个仓库没有图像库 —— 只能拒 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 一条消息最多几个附件。图片会随历史每轮重传，没有上限的话一条消息就能把上下文顶爆 */
const MAX_ATTACHMENTS = 8

/** OpenAI 接受的那几种图格式的扩展名。gif 一并放行（端点多半只取第一帧） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const GIF_MAGICS = ['GIF87a', 'GIF89a']

/**
 * 从字节的开头认出图片格式，认不出返回 `null`。
 *
 * **为什么非 sniff 不可**：扩展名和 `File.type` 都是**用户可控的字符串**，只有字节是事实。
 * 把一个 `.png` 改名的文本（或一段乱码）拖进来，只信名字的写法会照读 4MB、贴上
 * `data:image/png` 发出去，端点回 400 —— 于是用户看到的是「这个端点不支持图片输入」，
 * 而真因是这个文件压根不是图。**mime 一律以 sniff 的结果为准**，不采用调用方声明的那个，
 * 所以也不再用「扩展名 → mime」的表（`.jpg` 里装 PNG 时那张表只会给出一个错标签）。
 *
 * 只认这四种 + gif，和 `IMAGE_EXTS` 是同一组。
 */
function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && GIF_MAGICS.includes(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * renderer 报上来的原始形状。字段全 optional 且是 `unknown` —— 它来自 `DataTransfer`，
 * 什么形状都可能有；`kind` / `bytes` 是 ingest 之后回传时才有的。
 */
interface RawAttachment {
  kind?: unknown
  path?: unknown
  dataUrl?: unknown
  name?: unknown
  mime?: unknown
  bytes?: unknown
}

export interface IngestResult {
  /** 归一化后的附件，renderer 拿回去挂在待发列表上 */
  attachments: UserAttachment[]
  /** 被拒的原因（人话），由调用方翻成通知栏。**不影响其余附件** */
  rejected: string[]
}

/** data URL 里 `,` 之后的那段 base64。没有逗号时返回空串 */
function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma < 0 ? '' : dataUrl.slice(comma + 1)
}

/** data URL 负载的字节数（base64 折回原字节，含 padding 修正） */
function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrlPayload(dataUrl)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

/**
 * 验一段 data URL 的**字节**真是图片，是则返回嗅出来的 mime。
 *
 * 取头 24 个 base64 字符（= 18 字节，够 longest 的 webp 判据用，且是 4 的整数倍、
 * 不会切出半个字节）。声明的前缀（`data:image/png`）在这里只用来**过一遍粗筛**，
 * 结论以字节为准。
 */
function imageMimeFromDataUrl(dataUrl: string): string | null {
  return sniffImage(Buffer.from(dataUrlPayload(dataUrl).slice(0, 24), 'base64'))
}

/**
 * 这条附件**该走图片那条路还是只给路径** —— 只决定分流，**不是「它是不是图」的结论**，
 * 真正的结论由 `sniffImage` 看着字节下。三条判据满足其一即走图片路：
 * - **扩展名**：拖进来的文件 `File.type` 常常是空串，只有名字给得出线索；
 * - **`File.type`**：剪贴板来的 File 常常没有扩展名（比如叫「image」）；
 * - **已经读好的 `data:image/`**：renderer 判定过这是图片、并且把字节读出来了，
 *   这里再因为「mime 是空串」把它打回「没有磁盘路径，去另存为」那条路就说不通了 ——
 *   那张图压根没有磁盘来源，用户照着提示做也做不出来。
 *
 * 判错了的代价只是**一句更贴切的拒绝**：名字像图但字节不是，会在 sniff 那步被挡下来
 * 并说「这个文件的内容不是图片」，而不是被当成文本附件塞给模型。
 */
function isImageRaw(raw: RawAttachment, ext: string): boolean {
  if (IMAGE_EXTS.has(ext)) return true
  if (typeof raw.mime === 'string' && raw.mime.startsWith('image/')) return true
  return typeof raw.dataUrl === 'string' && raw.dataUrl.startsWith('data:image/')
}

/** 名字优先用 renderer 给的（剪贴板来的 File 有 name），退回磁盘上的文件名 */
function nameOf(raw: RawAttachment, absPath: string): string {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  return name || (absPath ? path.basename(absPath) : '未命名文件')
}

/**
 * 把 renderer 报的一串原始形状读成附件。
 *
 * 副作用是**读磁盘**：图片会在这一步变成 data URL 并留在返回值里，后面发送、落盘、
 * 恢复历史用的都是这一份，不再回读文件（用户拖进来之后把源文件删了也不影响）。
 *
 * 用 `fs.promises` 而不是 `*Sync`：这里是 Electron 主进程，同步读一个 4MB 文件
 * 就是整窗卡一下。
 */
export async function ingestAttachments(raw: unknown): Promise<IngestResult> {
  const attachments: UserAttachment[] = []
  const rejected: string[] = []
  if (!Array.isArray(raw)) return { attachments, rejected }

  for (const item of raw) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      rejected.push(`附件最多 ${MAX_ATTACHMENTS} 个，超出的已忽略`)
      break
    }
    const r = (item ?? {}) as RawAttachment
    const rawPath = typeof r.path === 'string' ? r.path : ''
    const absPath = rawPath && !rawPath.includes('\0') ? path.resolve(rawPath) : ''
    const ext = absPath ? path.extname(absPath).toLowerCase() : ''
    const label = nameOf(r, absPath)

    // 含 \0 的路径一律拒：它能让某些 syscall 截断字符串，是路径校验的常规底线。
    // 单独一条理由而不是并进「没有磁盘路径」—— 后者会把用户支使去「另存为」，
    // 而这个路径本来就不合法，另存多少次都一样
    if (rawPath.includes('\0')) {
      rejected.push(`${label}：路径不合法`)
      continue
    }

    if (!isImageRaw(r, ext)) {
      if (!absPath) {
        rejected.push(`${label}：这个文件没有磁盘路径（从压缩包或网页里复制来的），先另存到磁盘再拖进来`)
        continue
      }
      // 非图片只给路径，不看内容 —— 模型自己 read_file。所以读不到也无所谓，
      // 此刻文件不在，不代表发出去时不在
      let bytes = 0
      try {
        bytes = (await fs.promises.stat(absPath)).size
      } catch {
        bytes = 0
      }
      attachments.push({ kind: 'file', name: label, path: absPath, bytes })
      continue
    }

    if (absPath) {
      let size = 0
      try {
        size = (await fs.promises.stat(absPath)).size
      } catch {
        rejected.push(`${label}：读不到这个文件（可能已被移动或删除）`)
        continue
      }
      if (size > MAX_IMAGE_BYTES) {
        rejected.push(`${label}：图片太大（${formatBytes(size)}），上限 ${formatBytes(MAX_IMAGE_BYTES)}`)
        continue
      }
      try {
        const buf = await fs.promises.readFile(absPath)
        const mime = sniffImage(buf.subarray(0, 16))
        if (!mime) {
          // 名字像图、字节不是。如实说，别让它一路发到端点去换一句
          // 「这个端点不支持图片输入」—— 那句话会把用户引到换模型上去
          rejected.push(`${label}：这个文件的内容不是图片（png / jpg / webp / gif）`)
          continue
        }
        attachments.push({
          kind: 'image',
          name: label,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
          bytes: buf.length,
        })
      } catch {
        rejected.push(`${label}：读不到这个文件（可能已被移动或删除）`)
      }
      continue
    }

    // 没有磁盘路径：截图工具、浏览器里复制的图片都走这条。renderer 已经用 FileReader
    // 读好了 data URL（它拿不到 fs），这里只能验形状 —— 这是 renderer 送进来的字符串
    const dataUrl = typeof r.dataUrl === 'string' ? r.dataUrl : ''
    if (!dataUrl.startsWith('data:image/')) {
      rejected.push(`${label}：这张图片没有磁盘路径（截图或网页复制来的），先另存为文件再拖进来`)
      continue
    }
    const mime = imageMimeFromDataUrl(dataUrl)
    if (!mime) {
      rejected.push(`${label}：这段数据不是图片（png / jpg / webp / gif）`)
      continue
    }
    const bytes = dataUrlBytes(dataUrl)
    if (bytes > MAX_IMAGE_BYTES) {
      rejected.push(`${label}：图片太大（${formatBytes(bytes)}），上限 ${formatBytes(MAX_IMAGE_BYTES)}`)
      continue
    }
    // mime 用嗅出来的、不用 renderer 声明的前缀：前缀写了 `image/png` 而负载是 jpeg 时，
    // 以字节为准。负载本身原样保留，不重新编码
    attachments.push({ kind: 'image', name: label, dataUrl: `data:${mime};base64,${dataUrlPayload(dataUrl)}`, bytes })
  }

  return { attachments, rejected }
}

/**
 * 只核形状、不碰 fs —— `session/send` 收到 renderer 回传的附件时用。
 *
 * 不合规的**静默丢掉**而不是报错：这批描述符是先经 `ingestAttachments` 才回到
 * renderer 手里的，能在这里被判死只有两种可能 —— 渲染层被改坏了，或者有人手工构造了
 * IPC 调用。两种情况下「少了一个附件」都比「整条消息发不出去」好收拾。
 *
 * 另外把 data URL 的**长度**也重新算一遍：`bytes` 是 renderer 报的，不能当输入用。
 */
export function sanitizeAttachments(raw: unknown): UserAttachment[] {
  const out: UserAttachment[] = []
  if (!Array.isArray(raw)) return out

  for (const item of raw) {
    if (out.length >= MAX_ATTACHMENTS) break
    const r = (item ?? {}) as RawAttachment
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '未命名文件'

    if (r.kind === 'image') {
      const dataUrl = typeof r.dataUrl === 'string' ? r.dataUrl : ''
      // 和 ingest 那边同一套判据：前缀只是粗筛，字节说了算。renderer 报的 `bytes`
      // 一律丢掉重算 —— 长度是它说的，不是事实
      const mime = imageMimeFromDataUrl(dataUrl)
      if (!mime) continue
      const bytes = dataUrlBytes(dataUrl)
      if (bytes > MAX_IMAGE_BYTES) continue
      out.push({ kind: 'image', name, dataUrl: `data:${mime};base64,${dataUrlPayload(dataUrl)}`, bytes })
      continue
    }

    const p = typeof r.path === 'string' && r.path && !r.path.includes('\0') ? r.path : ''
    if (!p) continue
    out.push({ kind: 'file', name, path: p, bytes: typeof r.bytes === 'number' ? r.bytes : 0 })
  }

  return out
}
