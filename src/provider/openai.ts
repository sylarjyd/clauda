import OpenAI from 'openai'
import type { ProviderConfig } from '../config.js'
import type { ToolCall, Usage } from '../types.js'
import { safeJsonParse } from '../util/text.js'
import { isRetryable, type Provider, type StreamEvent, type StreamOptions } from './types.js'

/** 流式响应里 tool_calls 是按 index 分片下发的，先攒起来 */
interface PendingCall {
  id: string
  name: string
  args: string
}

export class OpenAICompatibleProvider implements Provider {
  readonly model: string
  private client: OpenAI
  private cfg: ProviderConfig
  /** 后端若不支持 stream_options，第一次失败后永久降级 */
  private usageSupported: boolean

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.model = cfg.model
    this.usageSupported = cfg.includeUsage
    this.client = new OpenAI({
      apiKey: cfg.apiKey || 'not-needed',
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
      maxRetries: 0, // 自己的退避逻辑，避免双层重试放大等待
      defaultHeaders: cfg.extraHeaders,
    })
  }

  async *stream(opts: StreamOptions): AsyncGenerator<StreamEvent> {
    let attempt = 0
    // 重试只能覆盖「连接建立到首个 chunk」阶段；一旦已经吐字给用户就不能重来
    for (;;) {
      let emitted = false
      try {
        for await (const ev of this.streamOnce(opts)) {
          emitted = true
          yield ev
        }
        return
      } catch (err) {
        if (opts.signal?.aborted) throw err
        if (emitted || attempt >= this.cfg.maxRetries || !isRetryable(err)) throw err
        attempt++
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000)
        process.stderr.write(
          `\n[clauda] 请求失败（${(err as Error).message}），${delay}ms 后第 ${attempt} 次重试…\n`,
        )
        await sleep(delay, opts.signal)
      }
    }
  }

  private async *streamOnce(opts: StreamOptions): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }
    if (this.usageSupported) body.stream_options = { include_usage: true }
    if (opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
      body.tool_choice = 'auto'
    }

    let stream: AsyncIterable<any>
    try {
      stream = (await this.client.chat.completions.create(body as any, {
        signal: opts.signal,
      })) as unknown as AsyncIterable<any>
    } catch (err) {
      // 后端不认 stream_options，去掉重来一次
      if (this.usageSupported && isUnsupportedParam(err)) {
        this.usageSupported = false
        process.stderr.write('[clauda] 后端不支持 stream_options，已关闭 token 统计\n')
        delete body.stream_options
        stream = (await this.client.chat.completions.create(body as any, {
          signal: opts.signal,
        })) as unknown as AsyncIterable<any>
      } else {
        throw err
      }
    }

    const pending = new Map<number, PendingCall>()
    let finishReason: string | null = null

    for await (const chunk of stream) {
      if (chunk?.usage) {
        yield { type: 'usage', usage: normalizeUsage(chunk.usage) }
      }
      const choice = chunk?.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (delta?.content) {
        yield { type: 'text', text: String(delta.content) }
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const cur = pending.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          pending.set(idx, cur)
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    for (const [idx, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!p.name) continue
      yield { type: 'tool_call', call: buildCall(p, idx) }
    }

    yield { type: 'done', finishReason }
  }
}

function buildCall(p: PendingCall, idx: number): ToolCall {
  const { value, error } = safeJsonParse<Record<string, unknown>>(p.args, {})
  // 合法 JSON 也可能是非对象（`null` / `42` / `"x"` / `[]`）。这类值塞进 args 之后，
  // 工具层任何一次属性访问都会抛 TypeError，而且抛点在工具循环的 try 之外，
  // 会把整轮对话打挂。统一按「参数不可用」处理，和解析失败走同一条路。
  const notObject = value === null || typeof value !== 'object' || Array.isArray(value)
  if (error || notObject) {
    return {
      id: p.id || `call_${idx}`,
      name: p.name,
      args: { _raw: p.args, _parseError: error ?? '工具参数不是一个 JSON 对象' },
      rawArgs: p.args,
    }
  }
  return { id: p.id || `call_${idx}`, name: p.name, args: value, rawArgs: p.args || '{}' }
}

function normalizeUsage(u: any): Usage {
  const prompt = Number(u.prompt_tokens ?? 0)
  const completion = Number(u.completion_tokens ?? 0)
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens
  return {
    input: prompt,
    output: completion,
    cachedInput: typeof cached === 'number' ? cached : undefined,
  }
}

function isUnsupportedParam(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  if (e?.status !== 400) return false
  return /stream_options|unrecognized|unknown|unsupported|invalid.*param/i.test(e.message ?? '')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}
