import { Transform } from 'node:stream'

/**
 * 把 stdin 的原始字节规范成 UTF-8 文本流。
 *
 * 为什么需要它：Node 默认按 UTF-8 解码管道输入，但中文 Windows（代码页 936）上
 * 从 cmd 重定向或某些 shell 管道过来的字节是 GBK。那样解出来是一片 U+FFFD，
 * 坏掉的内容既会喂给模型、又会回显给用户，看起来就像 clauda 自己坏了。
 *
 * 判定策略：按行用 fatal 模式试 UTF-8，非法字节会抛错，说明不是 UTF-8，退回
 * GB18030 重解。纯 ASCII 两种编码结果一致，所以**不锁定** —— 否则开头一行 ASCII
 * 会把后面真正需要判定的行也带偏。一旦确认是 GB18030 就记住，后续行不再试。
 */
export function decodeInput(): Transform {
  let decided: 'utf-8' | 'gb18030' | null = null
  let pending = Buffer.alloc(0)

  const convert = (line: Buffer): Buffer => {
    if (decided === null) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(line)
      } catch {
        decided = 'gb18030'
      }
    }
    // 没锁定说明这段本来就是合法 UTF-8，原样放行，不做多余的重新编码
    if (decided === null) return line
    return Buffer.from(new TextDecoder(decided).decode(line), 'utf8')
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      pending = Buffer.concat([pending, chunk])
      // UTF-8 续字节和 GBK 尾字节都不可能等于 0x0a，所以按 \n 切不会切断多字节字符
      let nl: number
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        this.push(convert(pending.subarray(0, nl + 1)))
        pending = pending.subarray(nl + 1)
      }
      cb()
    },
    flush(cb) {
      if (pending.length > 0) this.push(convert(pending))
      cb()
    },
  })
}
