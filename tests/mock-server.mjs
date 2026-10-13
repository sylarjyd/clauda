/**
 * 假的 OpenAI 兼容服务端，用来离线验证 clauda 的 agent 循环。
 *
 * 行为：收到用户消息就返回一个 read_file 的 tool_call；
 *       收到工具结果就把结果里读到的 name 字段拼进最终回答。
 *       每轮都走满两个请求，和真实模型的往返方式一致。
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export function createMockServer({ log = false } = {}) {
  return http.createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const toolResults = parsed.messages.filter((m) => m.role === 'tool')
      const lastRole = parsed.messages[parsed.messages.length - 1]?.role
      const hasTools = (parsed.tools ?? []).length > 0
      const wantToolCall = lastRole !== 'tool' && hasTools

      if (log) {
        console.error(
          `[mock] msgs=${parsed.messages.length} last=${lastRole} -> ${wantToolCall ? 'tool_call' : 'text'}`,
        )
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      // 用户那句话里带「写」就走 write_file，否则 read_file。桌面端驱动用例需要一条
      // 会弹授权框的写操作 —— read_file 是读操作，`default` 模式下直接放行、不问用户。
      // 判据仍是「最后一条消息的 role」，没变（见 CLAUDA.md）。
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const writing = /写/.test(lastUser)

      if (wantToolCall) {
        const name = writing ? 'write_file' : 'read_file'
        const args = writing
          ? JSON.stringify({ path: 'note.txt', content: '桌面端驱动写进来的' })
          : JSON.stringify({ path: 'package.json' })

        sse(res, chunk({ role: 'assistant', content: writing ? '我来写个文件。' : '我先看一下 package.json。' }))
        sse(
          res,
          chunk({
            tool_calls: [
              { index: 0, id: `call_${name}_1`, type: 'function', function: { name, arguments: '' } },
            ],
          }),
        )
        // 参数故意拆成多片流式下发，验证 provider 的拼装逻辑
        const step = Math.ceil(args.length / 4)
        for (let i = 0; i < args.length; i += step) {
          sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + step) } }] }))
        }
        sse(res, chunk({}, 'tool_calls'))
      } else {
        const content = toolResults[toolResults.length - 1]?.content ?? ''
        const name = /"name"\s*:\s*"([^"]+)"/.exec(content)?.[1] ?? '(没读到 name)'
        const pieces = writing
          ? ['写完了：', content.split('\n')[0]]
          : ['我读到了 ', 'package.json', '，项目名是 ', name, '。']
        for (const piece of pieces) {
          sse(res, chunk({ role: 'assistant', content: piece }))
        }
        sse(res, chunk({}, 'stop'))
      }

      sse(res, {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'mock-model',
        choices: [],
        usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
}

/** 直接 `node tests/mock-server.mjs [port]` 时作为独立进程运行 */
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const port = Number(process.argv[2] ?? 8899)
  createMockServer({ log: process.env.MOCK_LOG === '1' }).listen(port, () => {
    console.error(`mock server listening on http://localhost:${port}/v1`)
    console.error('用法：CLAUDA_BASE_URL=http://localhost:' + port + '/v1 clauda ...')
  })
}
