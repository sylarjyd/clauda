/**
 * 假的 MCP 服务器，走 Streamable HTTP。
 *
 * 和 `mock-mcp.mjs`（stdio）分开写，是因为两者连「怎么被启动」都不一样：stdio 那个必须
 * 是个能被 spawn 的独立脚本，这个是被 e2e 进程内起来的服务端。共用一份代码要塞两个模式，
 * 反而更容易在改一个的时候碰坏另一个。
 *
 * 无依赖手写，理由同 `mock-server.mjs`：装一套 SDK 只为测协议会被 SDK 自己的行为带偏。
 *
 * 返回值是 `{ server, seen }` 而不是光一个 server —— e2e 要断言「自定义 headers 有没有
 * 真的发出来」，得有个地方记。
 */
import http from 'node:http'

export const HTTP_MCP_TOOL = 'http_echo'

export function createMockMcpHttp() {
  const seen = { auth: null, methods: [] }

  const server = http.createServer((req, res) => {
    // 不提供 SSE 流：规范允许服务器回 405，客户端就不该继续等
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    seen.auth = req.headers['authorization'] ?? null

    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        res.writeHead(400).end()
        return
      }

      // 通知没有 id，规范要求回 202 且不带 body
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end()
        return
      }
      seen.methods.push(msg.method)

      const send = (payload) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))

      switch (msg.method) {
        case 'initialize':
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              // 回显客户端请求的版本，免得 MCP 升级默认版本时这个 mock 突然连不上
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'clauda-mock-mcp-http', version: '0.0.1' },
            },
          })
          break

        case 'tools/list':
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: HTTP_MCP_TOOL,
                  description: '回显',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            },
          })
          break

        case 'tools/call':
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `http:${msg.params?.arguments?.text}` }] },
          })
          break

        default:
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未实现的方法 ${msg.method}` } })
      }
    })
  })

  return { server, seen }
}
