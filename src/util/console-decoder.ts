/**
 * 中文 Windows 的字节到底该按哪种编码解。
 *
 * 同一件事在两个地方要做：stdin 的管道输入（`src/ui/input-decoder.ts`）和子进程的
 * 输出（这里）。判据放在这一处，两边都调 —— 分开写的话，一处改了另一处不跟，就会
 * 「同样的输出在 CLI 里正常、在工具结果里乱码」。
 *
 * 为什么需要认：Node 一律按 UTF-8 解码。但中文 Windows（代码页 936）上，`cmd.exe`
 * 里的原生工具（certutil、findstr、ipconfig…）按控制台代码页输出 GB18030，而 node、
 * python、Git Bash 的 coreutils 大多吐 UTF-8。同一个 `bash` 工具前后两条命令可以是
 * 两种编码，所以只能看字节，不能按平台猜。
 *
 * 判据是「先当 UTF-8 试，不行退 GB18030」：GB18030 的双字节序列（高字节 0x81–0xFE、
 * 低字节常落在 ASCII 区）几乎不可能整段是合法 UTF-8。
 *
 * 两边粒度不同，所以共用的只有 `sniffBytes` 这个判据，而不是整条流式管道：stdin 是
 * 行式协议，按 `\n` 切就天然不会切在多字节字符中间；子进程输出没有这个保证
 * （进度条、`echo -n` 都不换行），所以那边得自己在块边界上处理不完整的尾部。
 */

// 从 `node:util` 取而不是用全局那个：`lib` 里没有 DOM，@types/node 把全局 `TextDecoder`
// 声明成了「只有值、没有类型名」，`x: TextDecoder` 这种写法会报 TS2749
import { TextDecoder } from 'node:util'

const NON_ASCII = 0x80

export type ByteEncoding = 'utf-8' | 'gb18030' | 'incomplete'

/**
 * 认一段字节是什么编码。
 *
 * - `utf-8`：整段就是合法 UTF-8
 * - `gb18030`：砍掉尾部也解不通，确定不是 UTF-8
 * - `incomplete`：砍掉尾部最多 3 个字节就解通了 —— 说明只是末尾那个字符没收全。
 *   它的存在是必须的：管道按块给数据，一个汉字的 UTF-8 三字节经常被切成 `e4 | b8 ad`，
 *   把这种情况当成「不是 UTF-8」会让中文输出整片变成乱码，而那是常态不是边界情况。
 */
export function sniffBytes(buf: Buffer): ByteEncoding {
  const strict = new TextDecoder('utf-8', { fatal: true })
  try {
    strict.decode(buf)
    return 'utf-8'
  } catch {
    /* 不是完整的 UTF-8，下一步再看是「没收全」还是「真不是」 */
  }

  // 砍掉尾部最多 3 个字节（UTF-8 单块最多 4 字节，砍 3 个足以剥掉一个残块）。
  // **允许砍到空**（`cut <= buf.length`）：整块就是一个汉字的前两字节时（`e4 b8`），
  // 只有砍光才能解通，而那是 UTF-8 输出被切断的常态。写死 `cut < buf.length` 会让
  // 它落到下面的 `gb18030` 上 —— 于是每个被切开的汉字都变成一个错字，整片输出乱码。
  for (let cut = 1; cut <= 3 && cut <= buf.length; cut++) {
    try {
      strict.decode(buf.subarray(0, buf.length - cut))
      return 'incomplete'
    } catch {
      /* 接着砍 */
    }
  }
  return 'gb18030'
}

/**
 * 定下编码之后拿解码器。GB18030 在 small-icu 的 Node 构建里不存在，那就退回 UTF-8 ——
 * 乱码至少还能看出「这里有字」，比抛出去强。
 */
export function decoderFor(enc: ByteEncoding): TextDecoder {
  if (enc !== 'gb18030') return new TextDecoder('utf-8')
  try {
    return new TextDecoder('gb18030')
  } catch {
    return new TextDecoder('utf-8')
  }
}

/**
 * 子进程输出流的解码器。和 `input-decoder` 的差别只有粒度：这里不能按行等，
 * 所以按块处理，并且**保持流式** —— 工具卡片的输出是边跑边显示的。
 *
 * 没定调之前只放 ASCII 前缀出去：ASCII 在两种编码下字节和字符一一对应，无论最后
 * 定成哪种这段文本都不会变。所以纯英文命令（`git status`、`npm test`）照旧一块一块
 * 地出字，不必等命令跑完。
 */
export class ConsoleDecoder {
  /** null = 还没定调 */
  private decoder: TextDecoder | null
  /** 还没定调时攒下的字节（从第一个非 ASCII 字节起） */
  private pending: Buffer[] = []

  /**
   * 平台当参数收，是为了让测试能在任何机器上两条分支都跑到 —— 嗅探这条路只有
   * Windows 上才启用，而 CI 大多跑在 Linux 上。
   */
  constructor(platform: NodeJS.Platform = process.platform) {
    // 非 Windows 上子进程一律吐 UTF-8（macOS、Linux、容器都是），没有嗅探的必要，
    // 也就没有误判的风险 —— 直接钉死
    this.decoder = platform === 'win32' ? null : new TextDecoder('utf-8')
  }

  push(chunk: Buffer): string {
    if (this.decoder) return this.decoder.decode(chunk, { stream: true })

    const buf = this.pending.length > 0 ? Buffer.concat([...this.pending, chunk]) : chunk
    const head = buf.findIndex((b) => b >= NON_ASCII)
    if (head < 0) {
      // 全是 ASCII：定不了调，但这段文本已经确定了，先放出去
      this.pending = []
      return buf.toString('latin1')
    }

    const ascii = buf.subarray(0, head).toString('latin1')
    const rest = buf.subarray(head)
    const enc = sniffBytes(rest)
    if (enc === 'incomplete') {
      // 尾部那半个字符判不了。压住等下一块 —— 复制一份，别让 subarray 拖着整块 chunk
      this.pending = [Buffer.from(rest)]
      return ascii
    }

    this.pending = []
    this.decoder = decoderFor(enc)
    return ascii + this.decoder.decode(rest, { stream: true })
  }

  /** 命令结束了。把解码器里剩的那半截吐掉（不完整的序列会变成 �，那是输入本身断了） */
  flush(): string {
    if (this.decoder) return this.decoder.decode()
    if (this.pending.length === 0) return ''
    const rest = Buffer.concat(this.pending)
    this.pending = []
    return rest.toString('utf8')
  }
}
