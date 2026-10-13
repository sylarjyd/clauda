/**
 * 假的 MCP 服务器，走 stdio 的换行分隔 JSON-RPC。
 *
 * 无依赖手写，理由和 `mock-server.mjs` 一样：装一套 SDK 只为了测协议会被 SDK 自己的
 * 行为带偏，而且升级 SDK 时测试会跟着一起动。这里就是要一份「不随 SDK 变」的参照物。
 *
 * 协议版本一律回显客户端请求的那个 —— 这是服务器发现版本不受支持时的标准做法，
 * 也让这个 mock 不会因为 MCP 升级了默认版本而突然连不上。
 */
import readline from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: '把输入原样返回',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    // 故意带一个点：验证名字消毒（点在后端函数名里非法）
    name: 'item.get',
    description: '按 id 取一条记录',
    // type 必须写全：v2 SDK 在解析 tools/list 结果时会强校验它，漏了会导致**整个**
    // 服务器的工具列表被拒（不是跳过这一个）。补默认值那条逻辑只能单测直接调
    // makeMcpTool 来验，走不到这条路径上。
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

const rl = readline.createInterface({ input: process.stdin, terminal: false })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

rl.on('line', (line) => {
  const raw = line.trim()
  if (!raw) return

  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  // 通知没有 id，一律不回复
  if (msg.id === undefined || msg.id === null) return

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'clauda-mock-mcp', version: '0.0.1' },
      })
      break

    case 'tools/list':
      // 设了 MCP_IGNORE_LIST 就装死不回：用来验 clauda 给 tools/list 加了超时。
      // 服务器握手完卡住不响应是真实存在的故障模式，没有超时的话整个启动会无限期挂住。
      if (!process.env.MCP_IGNORE_LIST) reply(msg.id, { tools: TOOLS })
      break

    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === 'echo') {
        reply(msg.id, { content: [{ type: 'text', text: `echo:${args.text}` }] })
      } else if (name === 'item.get') {
        reply(msg.id, { content: [{ type: 'text', text: `item:${args.id}` }] })
      } else if (name === 'boom') {
        // 服务器主动报错：走 isError 而不是 JSON-RPC error，验证 clauda 把它转成
        // 模型能看见的错误文本而不是抛异常
        reply(msg.id, { isError: true, content: [{ type: 'text', text: '炸了' }] })
      } else {
        reply(msg.id, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: `未知工具 ${name}` },
        })
      }
      break
    }

    case 'ping':
      reply(msg.id, {})
      break

    default:
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `未实现的方法 ${msg.method}` },
      })
  }
})

rl.on('close', () => process.exit(0))
