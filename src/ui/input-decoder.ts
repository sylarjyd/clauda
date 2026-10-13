import { Transform } from 'node:stream'
import { sniffBytes } from '../util/console-decoder.js'

/**
 * 把 stdin 的原始字节规范成 UTF-8 文本流。
 *
 * 为什么需要它：Node 默认按 UTF-8 解码管道输入，但中文 Windows（代码页 936）上
 * 从 cmd 重定向或某些 shell 管道过来的字节是 GBK。那样解出来是一片 U+FFFD，
 * 坏掉的内容既会喂给模型、又会回显给用户，看起来就像 clauda 自己坏了。
 *
 * 判据在 `util/console-decoder.ts`（子进程输出认的是同一件事）。这里额外要的是
 * 「按行」这个粒度：stdin 是行式协议，按 `\n` 切就天然不会切在多字节字符中间。
 *
 * 纯 ASCII 两种编码结果一致，所以**不锁定** —— 否则开头一行 ASCII 会把后面真正
 * 需要判定的行也带偏。一旦确认不是 UTF-8 就记住，后续行不再试。
 */
export function decodeInput(): Transform {
  let decided: 'utf-8' | 'gb18030' | null = null
  let pending = Buffer.alloc(0)

  const convert = (line: Buffer): Buffer => {
    // 'incomplete' 也当成 GB18030：这是一行的**结尾**，后面不会再来字节了，
    // 没有「等下一块」这个选项（和 `sniffBytes` 在流式那边的用法正相反）
    if (decided === null && sniffBytes(line) !== 'utf-8') decided = 'gb18030'
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
