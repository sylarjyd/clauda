/**
 * 端到端验收：在进程内起一个假的 OpenAI 兼容服务端，
 * 再把 clauda 当子进程跑，覆盖工具往返、权限、上下文压缩、会话恢复、错误提示。
 * 跑之前需要先 `npm run build`。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockServer } from './mock-server.mjs'
import { createMockMcpHttp, HTTP_MCP_TOOL } from './mock-mcp-http.mjs'

const PORT = 8917
const BASE = `http://localhost:${PORT}/v1`
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDA = path.join(PROJECT, 'dist', 'index.js')

if (!fs.existsSync(CLAUDA)) {
  console.error('找不到 dist/index.js，请先运行 npm run build')
  process.exit(1)
}

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-home-'))
const baseArgs = ['--base-url', BASE, '--api-key', 'mock']

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n       ${String(extra).slice(0, 600).replace(/\n/g, '\n       ')}`)
  }
}

/** 把 clauda 跑起来，喂入 stdin，收齐 stdout / stderr */
function runClauda(args, stdin = '', envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLAUDA, ...args], {
      cwd: PROJECT,
      env: { ...process.env, CLAUDA_HOME: TMP_HOME, NO_COLOR: '1', ...envExtra },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    timer.unref?.()
    child.stdin.on('error', () => {})
    if (stdin) child.stdin.write(stdin)
    child.stdin.end()
  })
}

const server = createMockServer()
await new Promise((r) => server.listen(PORT, r))

console.log('\n== 无头模式：工具往返 ==')
{
  const { stdout, stderr, code } = await runClauda([...baseArgs, '-p', '项目叫什么', '--permission-mode', 'auto'])
  check('退出码为 0', code === 0, `code=${code}`)
  check('回答里带上了工具真实读到的内容', stdout.includes('项目名是 clauda'), stdout)
  check(
    '工具进度走 stderr 而非 stdout',
    stderr.includes('[read_file]') && !stdout.includes('[read_file]'),
    `stdout=${stdout}\nstderr=${stderr}`,
  )
  check('用量统计走 stderr', /tokens/.test(stderr), stderr)
}

console.log('\n== 无头模式：JSON 输出可直接解析 ==')
{
  const { stdout } = await runClauda([...baseArgs, '-p', '项目叫什么', '--permission-mode', 'auto', '--output-format', 'json'])
  let parsed = null
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    check('stdout 是纯 JSON', false, `${e.message}\n${stdout}`)
  }
  if (parsed) {
    check('stdout 是纯 JSON', true)
    check('JSON 含 result 字段', typeof parsed.result === 'string' && parsed.result.includes('clauda'))
    check('JSON 报告 steps', parsed.steps === 2, `steps=${parsed.steps}`)
    check('JSON 累计 usage', parsed.usage.input === 2400, JSON.stringify(parsed.usage))
  }
}

console.log('\n== 无头模式：读操作不触发授权提示 ==')
{
  const { stderr } = await runClauda([...baseArgs, '-p', '项目叫什么'])
  check('读操作直接放行，不弹授权', !stderr.includes('无法弹出授权确认'), stderr)
}

console.log('\n== 交互模式：多轮对话与斜杠命令 ==')
{
  const { stdout, stderr } = await runClauda(
    [...baseArgs, '--permission-mode', 'auto'],
    '项目叫什么\n/cost\n/status\n/exit\n',
  )
  const all = stdout + stderr
  check('第一轮拿到工具结果', all.includes('项目名是 clauda'), all)
  check('/cost 打印累计用量', all.includes('累计 tokens'), all)
  check('/status 打印配置', all.includes('工作目录') && all.includes('权限模式'), all)
  check('退出提示', all.includes('再见'), all)
}

console.log('\n== 交互模式：/mode 切换 ==')
{
  const { stdout, stderr } = await runClauda([...baseArgs], '/mode plan\n/status\n/mode auto\n/status\n/exit\n')
  const all = stdout + stderr
  check('/mode plan 生效', all.includes('已切换到 plan 模式'), all)
  check('/mode auto 切回', all.includes('已切换到 auto 模式'), all)
}

console.log('\n== 配置优先级：配置文件 > 环境变量 ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-cfg-'))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ provider: { model: 'from-config' } }), 'utf8')
  const { stdout, stderr } = await runClauda([...baseArgs], '/status\n/exit\n', {
    CLAUDA_HOME: home,
    CLAUDA_MODEL: 'from-env',
  })
  const all = stdout + stderr
  check('配置文件压过环境变量', all.includes('from-config') && !all.includes('from-env'), all)
  // 命令行参数必须仍然压得过去，否则 e2e 自己就指不到 mock 了
  check('命令行参数仍压过配置文件', all.includes(BASE), all)
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== CLI：config.json 的 defaultAgent 生效 ==')
{
  // 单开一份 home：这条用例会往里面写 `defaultAgent` 和一份带工具白名单的智能体，
  // 留在共享的 TMP_HOME 里会把后面每一条 CLI 用例都套上一个白名单
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-agent-cli-'))
  const dir = path.join(home, 'agents', 'readonly')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    [
      '---',
      'name: readonly',
      'description: 只读助手',
      'model: agent-cli-model',
      'tools: read_file',
      '---',
      '',
      '你只读文件，一个字都不改。',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaultAgent: 'readonly' }), 'utf8')

  // 证据只能看**服务端收到了什么**：命令行这边既看不到提示词也看不到工具集。
  // 无头模式没人能点授权框，所以白名单里给了 read_file 这一轮才跑得完 —— 顺带也是
  // 「白名单真的在手上」的反面证据（没给的话这一步就卡住了）
  const before = server.seen.length
  const { stdout, stderr, code } = await runClauda([...baseArgs, '-p', '项目叫什么'], '', { CLAUDA_HOME: home })
  check('CLI 无头模式仍然跑得完', code === 0 && stdout.includes('项目名是 clauda'), `code=${code}\n${stdout}\n${stderr}`)

  const req = server.seen.slice(before)[0] ?? {}
  const sys = (req.messages ?? []).find((m) => m.role === 'system')
  check(
    'defaultAgent 的正文进了系统提示词',
    String(sys?.content).includes('## 智能体：readonly') &&
      String(sys.content).includes('你只读文件，一个字都不改。'),
    String(sys?.content).slice(0, 400),
  )
  // 这一条是「`applyAgentToConfig` 必须夹在 `loadConfig` 与建 provider 之间」的探针：
  // 晚一步就成了「提示词说用 A、请求打到 B」，而两边都不报错
  check('智能体的 model 折进了请求（provider 建之前就生效了）', req.model === 'agent-cli-model', String(req.model))
  check(
    '工具白名单生效：请求里有 read_file，没有 write_file',
    (req.tools ?? []).some((t) => t.function?.name === 'read_file') &&
      !(req.tools ?? []).some((t) => t.function?.name === 'write_file'),
    JSON.stringify((req.tools ?? []).map((t) => t.function?.name)),
  )

  // 名字指向一个不存在的智能体：**不 fail** —— 一个被删掉的智能体不该让命令行起不来。
  // 交互模式下说一声，然后按「没有智能体」装配
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaultAgent: '已经删掉的那个' }), 'utf8')
  const missing = await runClauda([...baseArgs], '/exit\n', { CLAUDA_HOME: home })
  const missingAll = missing.stdout + missing.stderr
  check(
    '默认智能体找不到时不报错，只提示一句',
    missing.code === 0 && missingAll.includes('已经删掉的那个') && missingAll.includes('不在了'),
    `code=${missing.code}\n${missingAll}`,
  )
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== 管道输入按 GBK 兜底解码 ==')
{
  // 中文 Windows（代码页 936）的管道默认发 GBK 字节，Node 按 UTF-8 硬解会得到一片 U+FFFD。
  // 断言查的是会话文件里记下的那条用户消息 —— 那是模型真正读到的东西。
  // 不能查 stdout：管道输入的第一行走的是 readline 的等待分支，压根不会被回显。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-gbk-'))
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a])
  await runClauda([...baseArgs], Buffer.concat([gbk, Buffer.from('/exit\n')]), { CLAUDA_HOME: home })

  const projects = path.join(home, 'projects')
  const slug = fs.readdirSync(projects)[0]
  const file = fs.readdirSync(path.join(projects, slug))[0]
  const session = JSON.parse(fs.readFileSync(path.join(projects, slug, file), 'utf8'))
  const user = session.messages.filter((m) => m.role === 'user').map((m) => m.content)
  check('GBK 字节被解成正确的用户消息', user[0] === '中文测试', JSON.stringify(user))
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== 上下文占用计入固定开销 ==')
{
  // 工具 schema（约 1400 token）每轮都要发，早期版本没算它，空会话会显示成接近 0
  const { stdout, stderr } = await runClauda([...baseArgs], '/cost\n/exit\n')
  const m = /上下文占用\s+([\d,]+)\s*\//.exec(stdout + stderr)
  const n = m ? Number(m[1].replace(/,/g, '')) : 0
  check('空会话的上下文占用含工具 schema', n > 2000, `实际 ${n}`)
}

console.log('\n== 上下文压缩 ==')
{
  // 摘掉的头部要够大（MIN_HEAD_TOKENS）才值得为它多跑一次摘要请求，
  // 所以第一问给一段长内容把历史撑起来
  const longAsk = '请先记住这段背景：' + '这是一段用于占位的说明文字。'.repeat(120)
  const { stdout, stderr } = await runClauda(
    [...baseArgs, '--permission-mode', 'auto', '--context-window', '4000'],
    `${longAsk}\n第二问\n/exit\n`,
  )
  const all = stdout + stderr
  check('触发了自动压缩', all.includes('压缩'), all.slice(-1500))
  // 压缩会改写历史，最容易坏的就是「压缩后模型仍然能正常接上下文」
  const answers = all.match(/项目名是 clauda/g) ?? []
  check('压缩之后每一轮都正常完成', answers.length === 2, `完成 ${answers.length} 轮`)
}

console.log('\n== 会话持久化与恢复 ==')
{
  await runClauda([...baseArgs, '--permission-mode', 'auto'], '项目叫什么\n/exit\n')

  const { stdout: list } = await runClauda(['--list-sessions'])
  check('--list-sessions 列出会话', /\d{14}-[a-z0-9]{4}/.test(list), list)

  const { stdout: cont } = await runClauda([...baseArgs, '--continue'], '/cost\n/exit\n')
  check('--continue 恢复了历史', cont.includes('已恢复会话') && cont.includes('消息条数'), cont)
}

console.log('\n== /new 轮转会话 id ==')
{
  // /new 只调了 agent.reset()，sessionId 一直是启动时那一个，于是 persist() 会拿新会话
  // 去覆盖旧文件 —— 用户以为开了新会话，其实上一段对话被抹掉了。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-new-'))
  await runClauda(
    [...baseArgs, '--permission-mode', 'auto'],
    '第一段\n/new\n第二段\n/exit\n',
    { CLAUDA_HOME: home },
  )

  const projects = path.join(home, 'projects')
  const slug = fs.readdirSync(projects)[0]
  const dir = path.join(projects, slug)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  check('/new 之后是两个会话文件而不是一个', files.length === 2, `实际 ${files.length} 个：${files.join(', ')}`)

  const titles = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((s) => s.title)
  check('旧会话内容还在（没被覆盖）', titles.includes('第一段'), titles.join(' | '))
  check('新会话是独立的一条', titles.includes('第二段'), titles.join(' | '))

  // 两个文件的 id 还得不一样，否则「两个文件」只是同一份写了两遍
  const ids = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).id)
  check('两个会话的 id 不同', new Set(ids).size === 2, ids.join(', '))

  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== 连接失败时的报错 ==')
{
  const { stderr, code } = await runClauda(['-p', 'hi', '--base-url', 'http://localhost:1/v1', '--api-key', 'x'])
  check('连不上时给出可读错误', /连接被拒绝|无法连接|ECONNREFUSED/.test(stderr), stderr)
  check('失败时退出码非 0', code !== 0, `code=${code}`)
}

console.log('\n== 技能：发现、/技能名 触发、与内置命令撞名 ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-skill-'))
  const write = (dirName, content) => {
    const d = path.join(home, 'skills', dirName)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), content, 'utf8')
  }
  write('demo', '---\nname: demo\ndescription: 演示技能\n---\n\n请复述这个标记：技能正文 ABC123\n')
  // 故意和内置命令同名，验证内置优先
  write('status', '---\nname: status\ndescription: 想抢内置命令\n---\n\n这段正文不该被送出去 ZZZ999\n')

  const { stdout, stderr } = await runClauda(
    [...baseArgs, '--permission-mode', 'auto'],
    '/skills\n/demo\n/status\n/exit\n',
    { CLAUDA_HOME: home },
  )
  const all = stdout + stderr
  check('/skills 列出发现的技能', all.includes('demo') && all.includes('演示技能'), all)
  check('/skills 标出与内置命令同名的技能', all.includes('内置优先'), all)
  check('/status 仍走内置命令', all.includes('工作目录') && all.includes('权限模式'), all)

  // 查会话文件：那才是模型真正收到的东西
  const projects = path.join(home, 'projects')
  const slug = fs.readdirSync(projects)[0]
  const file = fs.readdirSync(path.join(projects, slug))[0]
  const session = JSON.parse(fs.readFileSync(path.join(projects, slug, file), 'utf8'))
  const user = session.messages.filter((m) => m.role === 'user').map((m) => m.content)
  check('/技能名 把技能正文发给了模型', user.some((c) => c.includes('ABC123')), JSON.stringify(user).slice(0, 400))
  check('与内置命令同名的技能没被触发', !user.some((c) => c.includes('ZZZ999')), JSON.stringify(user).slice(0, 400))

  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== MCP：stdio 接入、/mcp、/mcp off ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcp-'))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mcpServers: {
        // 用 node 直接起 mock，不经过 npx —— 免得 e2e 依赖网络下载
        mock: { command: process.execPath, args: [path.join(PROJECT, 'tests', 'mock-mcp.mjs')] },
      },
    }),
    'utf8',
  )

  const t0 = Date.now()
  const { stdout, stderr } = await runClauda(
    [...baseArgs],
    '/mcp\n/tools\n/mcp off mock\n/tools\n/mcp on mock\n/tools\n/exit\n',
    { CLAUDA_HOME: home },
  )
  const elapsed = Date.now() - t0
  const all = stdout + stderr

  check('/mcp 显示服务器已连接', all.includes('mock') && all.includes('已连接'), all.slice(0, 600))
  check('/mcp 报出工具数', /工具 2/.test(all), all.slice(0, 600))
  check('/tools 列出 MCP 工具且名字已消毒', all.includes('mcp__mock__echo') && all.includes('mcp__mock__item_get'), all)
  check('/tools 按来源分组', all.includes('MCP · mock'), all)

  // 摘掉之后要把输出切开验：只查「已摘除」那句话是验不到工具真的从集合里消失了的。
  // 切到「已接入」之前为止 —— 后面那次 /tools 是重新接上之后打的，本来就该有 MCP 工具。
  const offAt = all.indexOf('已摘除 MCP 服务器')
  const onAt = all.indexOf('已接入 MCP 服务器')
  const duringOff = all.slice(offAt, onAt > offAt ? onAt : undefined)
  check(
    '/mcp off 之后 /tools 里确实没有 MCP 工具了',
    duringOff.includes('已摘除') && !duringOff.includes('mcp__mock__'),
    duringOff.slice(0, 400),
  )
  const afterOn = all.slice(all.indexOf('已接入 MCP 服务器'))
  check('/mcp on 能重新连上并装回工具', afterOn.includes('mcp__mock__echo'), afterOn.slice(0, 400))

  // StdioClientTransport 起的子进程会让事件循环一直活着 —— 忘了关，/exit 之后不会退出，
  // 表现是「卡住」而不是报错。runClauda 有 60s 兜底 kill，这里卡住就会超时。
  check('交互模式退出时没有被 MCP 子进程挂住', elapsed < 20_000, `耗时 ${elapsed}ms`)

  // 无头模式走的是 shutdown() 而不是 REPL 的 onExit，是另一条出口，得单独验。
  // 这里不调 MCP 工具，只验「接了 MCP 之后无头模式还能正常退出、输出还能解析」。
  const t1 = Date.now()
  const headless = await runClauda(
    [...baseArgs, '-p', '项目叫什么', '--permission-mode', 'auto'],
    '',
    { CLAUDA_HOME: home },
  )
  const headlessElapsed = Date.now() - t1
  check('无头模式退出时没有被 MCP 子进程挂住', headlessElapsed < 20_000, `耗时 ${headlessElapsed}ms`)
  check('无头模式仍能拿到回答', headless.stdout.includes('项目名是 clauda'), headless.stdout)
  check(
    'MCP 成本提示走 stderr，不污染 stdout',
    headless.stderr.includes('已接入 MCP') && !headless.stdout.includes('已接入 MCP'),
    `stdout=${headless.stdout}\nstderr=${headless.stderr}`,
  )

  fs.rmSync(home, { recursive: true, force: true })
}

// `tools` 是配置里早就有的字段，但一直是「手写才有、界面看不见」的状态。这一组盯的是
// 它真能决定对话里有哪些工具：列表上那句 `工具 1/2` 不是装饰，被挡在外面的那个不该
// 出现在 /tools 里。
console.log('\n== MCP：tools 白名单 ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcp-wl-'))
  const mock = { command: process.execPath, args: [path.join(PROJECT, 'tests', 'mock-mcp.mjs')] }
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mcpServers: {
        // 挑了一个：同一个服务器上的 `item.get` 该被挡在外面
        picked: { ...mock, tools: ['echo'] },
        // 空数组是「一个都不接」，和「没设白名单」是两种状态，别混成一种
        bare: { ...mock, tools: [] },
      },
    }),
    'utf8',
  )

  // 只拿 stdout 做判断：`已接入 MCP 服务器` 那类运行期提示走的是 stderr，
  // 把两股流拼在一起的 `all` 里下标顺序没有意义
  const { stdout } = await runClauda([...baseArgs], '/mcp\n/tools\n/exit\n', { CLAUDA_HOME: home })
  check('/mcp 报出「接进来几个 / 总共几个」', stdout.includes('工具 1/2') && stdout.includes('工具 0/2'), stdout.slice(0, 900))
  check('带分母的那几台在 /mcp 上有解释', stdout.includes('tools 白名单'), stdout.slice(0, 900))
  check('/tools 只装了白名单挑中的那个', stdout.includes('mcp__picked__echo'), stdout)
  check('白名单外的那个工具没装进来', !stdout.includes('mcp__picked__item_get'), stdout)
  check('空数组那台一个工具都没接', !stdout.includes('mcp__bare__'), stdout)

  // 白名单挂在**装配**上（不在 connect 上）：摘掉再装回来仍然要听它的。
  // 这一轮里没有更早的 /tools，所以「stdout 里有没有」就够判了
  const second = await runClauda([...baseArgs], '/mcp off picked\n/mcp on picked\n/tools\n/exit\n', { CLAUDA_HOME: home })
  check('重新连上之后白名单照样管用', second.stdout.includes('mcp__picked__echo') && !second.stdout.includes('mcp__picked__item_get'), second.stdout.slice(0, 900))

  fs.rmSync(home, { recursive: true, force: true })
}

// 服务器握手成功却在 tools/list 上装死，是真实存在的故障模式。没有超时的话
// clauda 从这里就起不来了。用一个很短的 timeoutMs 验，别把 e2e 拖成十几秒。
console.log('\n== MCP：tools/list 超时 ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcp-hang-'))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mcpServers: {
        hang: {
          command: process.execPath,
          args: [path.join(PROJECT, 'tests', 'mock-mcp.mjs')],
          env: { MCP_IGNORE_LIST: '1' },
          timeoutMs: 1500,
        },
      },
    }),
    'utf8',
  )

  const t0 = Date.now()
  const { stderr } = await runClauda([...baseArgs, '-p', '你好'], '', { CLAUDA_HOME: home })
  const elapsed = Date.now() - t0
  // 没有超时的话这里会一路挂到 runClauda 的 60s 兜底 kill —— 那样耗时断言先炸，
  // 报错信息也指不到「超时没生效」上，所以耗时和提示语两条都要。
  check('tools/list 卡住时会超时退出而不是无限挂起', elapsed < 10_000, `耗时 ${elapsed}ms`)
  check('超时报错里点明是 MCP 超时', /超时/.test(stderr), stderr.slice(0, 400))

  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== MCP：HTTP 传输 ==')
{
  // 这里必须在子进程里验，不能在 tests/unit.mjs 里就地验：进程内跑完一次 HTTP MCP 往返
  // 之后立刻 process.exit，Windows 上会撞 libuv 的 handle 断言（uv_async_send on a closing
  // handle）直接 abort，退出码 127 把 npm test 链断掉。加 setTimeout 只是把问题往后推
  // —— 实测 10ms 不够、50ms 才行，这种「睡够久就没事」的断言迟早会在慢机器上翻车。
  // 跨进程就没这个问题，顺带也验了真实退出路径。
  const { server: mcpHttp, seen } = createMockMcpHttp()
  await new Promise((r) => mcpHttp.listen(0, '127.0.0.1', r))
  const mcpPort = mcpHttp.address().port

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcp-http-'))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mcpServers: {
        httpremote: {
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          headers: { Authorization: 'Bearer e2e-token' },
          permission: 'read',
        },
      },
    }),
    'utf8',
  )

  const { stdout, stderr, code } = await runClauda([...baseArgs, '--permission-mode', 'auto'], '/mcp\n/tools\n/exit\n', {
    CLAUDA_HOME: home,
  })
  const all = stdout + stderr

  check('HTTP 服务器能连上并退出码为 0', code === 0 && all.includes('已连接'), `code=${code}\n${all.slice(0, 600)}`)
  check('tools/list 确实走了 HTTP 传输', seen.methods.includes('tools/list'), JSON.stringify(seen.methods))
  check('自定义 headers 原样发给服务器（令牌靠这层带）', seen.auth === 'Bearer e2e-token', String(seen.auth))
  check(
    'HTTP 工具出现在 /tools 里',
    all.includes(`mcp__httpremote__${HTTP_MCP_TOOL}`) && all.includes('MCP · httpremote'),
    all.slice(0, 800),
  )

  mcpHttp.closeAllConnections()
  await new Promise((r) => mcpHttp.close(r))
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n== 记忆库：索引注入与 /memories ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mem-'))
  const memDir = path.join(home, 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(
    path.join(memDir, 'commit-in-chinese.md'),
    '---\nname: commit-in-chinese\ndescription: 提交信息一律用中文\ntype: feedback\n---\n\n这个仓库的 commit message 用中文写。\n',
    'utf8',
  )

  const { stdout, stderr } = await runClauda(
    [...baseArgs, '--permission-mode', 'auto'],
    '项目叫什么\n/memories\n/tools\n/exit\n',
    { CLAUDA_HOME: home },
  )
  const all = stdout + stderr

  check('/memories 列出记忆库', all.includes('commit-in-chinese') && all.includes('提交信息一律用中文'), all.slice(0, 800))
  check(
    '/tools 把记忆工具单独分一组',
    all.split('\n').some((l) => l.trim() === '记忆') && all.includes('memory_write'),
    all.slice(0, 800),
  )
  // 注意这里**没有**验「模型自己决定写一条记忆」：mock 服务端只会按最后一条消息的
  // role 返回 read_file，CLAUDA.md 明确不让改这个行为，所以那条路径由单测直接调
  // memory_write 覆盖。e2e 能验的是「索引真的进到了发给模型的东西里」。
  const slug = fs.readdirSync(path.join(home, 'projects'))[0]
  const file = fs.readdirSync(path.join(home, 'projects', slug))[0]
  const session = JSON.parse(fs.readFileSync(path.join(home, 'projects', slug, file), 'utf8'))
  const sys = session.messages.find((m) => m.role === 'system').content
  check(
    '记忆索引进了系统消息',
    sys.includes('## 记忆索引') && sys.includes('commit-in-chinese（feedback）'),
    sys.slice(0, 300),
  )
  check('系统消息里只有索引、没有正文', !sys.includes('commit message 用中文写'), sys.slice(0, 500))

  fs.rmSync(home, { recursive: true, force: true })
}

// lastLoadedConfig 是模块级的，只为顶层 catch 服务。把「连不上时提示当前接口地址」钉住：
// 抽装配逻辑时最容易漏掉回填它，而现有用例只断言了连接被拒，不覆盖端点提示 —— 漏了会静默漂。
console.log('\n== 错误提示：带出当前接口地址 ==')
{
  const { stderr, code } = await runClauda([
    '--base-url', 'http://localhost:1/v1', '--api-key', 'mock', '-p', '你好',
  ])
  check('连接失败时退出码非 0', code !== 0, `code=${code}`)
  check(
    '错误提示里带上了当前接口地址',
    stderr.includes('当前接口地址为 http://localhost:1/v1'),
    stderr.slice(0, 600),
  )
}

// 已经连上 MCP 之后再走错误出口：fail() 必须走同步的 closeAllSync()。走异步那条的话
// MCP 子进程会让事件循环一直活着，进程退不掉 —— 表现是「卡住」而不是报错，只会被
// runClauda 的 60s 兜底 kill 变成一条超时。这条锁的是 fail() 的同步兜底路径
// （CLAUDA.md 硬约束：fail 必须保持同步的 never，不能改成 async）。
console.log('\n== 错误出口：已连 MCP 时不卡死 ==')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-fail-mcp-'))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mcpServers: {
        mock: { command: process.execPath, args: [path.join(PROJECT, 'tests', 'mock-mcp.mjs')] },
      },
    }),
    'utf8',
  )

  const t0 = Date.now()
  const { stderr, code } = await runClauda(
    ['--base-url', 'http://localhost:1/v1', '--api-key', 'mock', '-p', '你好'],
    '',
    { CLAUDA_HOME: home },
  )
  const elapsed = Date.now() - t0

  // 先确认这条用例真的进了 MCP 分支，否则「不卡死」是白验的
  check('MCP 已接入（确认本用例确实走了 MCP 路径）', stderr.includes('已接入 MCP'), stderr.slice(0, 600))
  check('已连 MCP 时错误出口仍以非 0 退出', code !== 0, `code=${code}`)
  check('已连 MCP 时错误出口不卡死', elapsed < 15_000, `耗时 ${elapsed}ms`)

  fs.rmSync(home, { recursive: true, force: true })
}

// 桌面端：跑 `desktop/main.js` 同一条分发路径（desktop-app.ts），脚本化地走一遍
// 「新建两会话 → 各发一句 → 授权确认 → 退出」。这是桌面端改动里唯一能覆盖全部逻辑的一条 ——
// 窗口/preload/DOM 只能人工看，但它们背后的每件事都在这里被跑过了。
// 子进程自带 mkdtemp 的 home 和临时项目目录，不碰共享的 TMP_HOME（那里不能有 mcpServers）。
console.log('\n== 桌面端：多会话并行 + 授权往返 + 退出 ==')
{
  const t0 = Date.now()
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PROJECT, 'tests', 'desktop-driver.mjs')], {
      cwd: PROJECT,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let so = ''
    let se = ''
    child.stdout.on('data', (d) => (so += d))
    child.stderr.on('data', (d) => (se += d))
    child.on('close', (c) => resolve({ stdout: so, stderr: se, code: c }))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    timer.unref?.()
  })
  const elapsed = Date.now() - t0

  let d = null
  try {
    d = JSON.parse(stdout.trim().split('\n').pop() ?? '')
  } catch {
    check('驱动产出可解析的 JSON', false, `code=${code}\nstdout=${stdout}\nstderr=${stderr}`)
  }

  if (d) {
    check('驱动正常跑完', d.ok === true, `${d.error ?? ''}\n${stderr.slice(0, 800)}`)
    check('退出码为 0', code === 0, `code=${code}\n${stderr.slice(0, 800)}`)
    // 七个：并发跑的那两个，验「默认模型只影响新会话」和「切厂商换新会话模型」时各新开的一个，
    // 外加智能体那一段开的三个（不带 / 带名字 / 名字找不到）。**全都要登记** ——
    // `straySessionIds` 拿它当白名单，漏记就会被当成一次泄漏
    check('开出了七个会话', d.sessionIds.length === 7, JSON.stringify(d.sessionIds))

    // 并发：两边都跑完了，A 读到项目名、B 写完文件
    check('会话 A 的回合成功', d.send.a?.ok === true, JSON.stringify(d.send.a))
    check('会话 B 的回合成功', d.send.b?.ok === true, JSON.stringify(d.send.b))
    check(
      'A 的回答里带上了真实读到的内容',
      (d.deltas[d.sessionIds[0]] ?? '').includes('deskdemo'),
      d.deltas[d.sessionIds[0]],
    )
    check(
      'B 的回答里带上了工具结果',
      (d.deltas[d.sessionIds[1]] ?? '').includes('写完了'),
      d.deltas[d.sessionIds[1]],
    )
    check(
      '流式增量没有串到别的会话',
      Object.keys(d.deltas).length === 2 && d.straySessionIds.length === 0,
      `deltas=${Object.keys(d.deltas)} stray=${JSON.stringify(d.straySessionIds)}`,
    )

    // 授权：写操作必须弹框，且弹给发起写入的那个会话
    check('写操作弹了授权框', d.permissions.length === 1, JSON.stringify(d.permissions))
    check(
      '授权框弹给了发起写入的会话 B',
      d.permissions[0]?.sessionId === d.sessionIds[1],
      JSON.stringify(d.permissions),
    )
    check(
      '授权框带上了工具名和风险说明',
      d.permissions[0]?.label === 'write_file(note.txt)' && !!d.permissions[0]?.detail,
      JSON.stringify(d.permissions[0]),
    )
    check('允许之后文件真被写出来了', d.noteWritten && d.noteContent === '桌面端驱动写进来的', String(d.noteContent))

    // 侧边栏状态点靠这条：running → idle
    check(
      '两个会话的状态都从 running 回到 idle',
      JSON.stringify(d.statuses[d.sessionIds[0]]) === '["running","idle"]' &&
        JSON.stringify(d.statuses[d.sessionIds[1]]) === '["running","idle"]',
      JSON.stringify(d.statuses),
    )

    // 工具卡片与右栏靠这两条
    check(
      '两边都上报了工具调用',
      d.toolStarts.some((t) => t.name === 'read_file' && t.sessionId === d.sessionIds[0]) &&
        d.toolStarts.some((t) => t.name === 'write_file' && t.sessionId === d.sessionIds[1]),
      JSON.stringify(d.toolStarts),
    )
    // 工具集经 channel 传到 renderer 之后仍然完整：7 个内置 + 无条件注入的 2 个记忆工具
    // + 4 个「对话里增删技能 / MCP」工具。这个 home 没有 mcpServers，也没有技能，
    // 所以既不该冒出 mcp__ 前缀的工具，也不该有那个按需载入的 `skill`
    const tools = d.tools.a?.session?.tools ?? []
    check(
      '会话工具集完整且没有多余的 MCP 工具',
      [
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'bash',
        'todo_write',
        'memory_read',
        'memory_write',
        'skill_write',
        'skill_remove',
        'mcp_add',
        'mcp_remove',
      ].every((n) => tools.includes(n)) &&
        tools.length === 13 &&
        !tools.some((n) => n.startsWith('mcp__')) &&
        !tools.includes('skill'),
      JSON.stringify(tools),
    )
    check(
      '会话状态带上了模型、权限模式和上下文占用',
      d.opened.a?.model === 'desk-model' &&
        d.opened.a?.mode === 'default' &&
        typeof d.opened.a?.contextRatio === 'number' &&
        d.opened.a?.contextRatio > 0,
      JSON.stringify(d.opened.a),
    )

    // 落盘 + 历史会话：不落盘的话关掉窗口这一轮就没了，侧边栏的「历史」也永远是空的
    check(
      '轮次结束后两个会话都落了盘',
      d.history?.sessions?.length === 2 && d.history.sessions.every((s) => typeof s.updatedAt === 'string'),
      JSON.stringify(d.history),
    )
    check(
      '历史条目是轻量摘要，不带 messages（侧边栏刷新不该去解析全部对话）',
      d.history?.sessions?.every((s) => s.messages === undefined),
      JSON.stringify(d.history?.sessions?.[0]),
    )

    const restored = d.resumed?.messages ?? []
    check('能按 id 从历史里恢复会话', d.resumed?.ok === true && d.resumed.session.id === d.sessionIds[0], JSON.stringify(d.resumed?.reason))
    check(
      '恢复出来的对话带回了当初的往返',
      restored.length >= 3 && restored.some((m) => m.role === 'user' && m.content === '项目叫什么'),
      JSON.stringify(restored.map((m) => m.role)),
    )
    check(
      '恢复的是同一个会话 id（另起一个的话原会话永不更新）',
      d.resumedState?.session?.id === d.sessionIds[0] && d.resumedState.session.model === 'desk-model',
      JSON.stringify(d.resumedState?.session?.id),
    )

    // ---- 设置页（模型 / 技能 / MCP）的数据源
    //
    // 先看**一个会话都没开**时那次调用：技能与 MCP 挂在项目运行时上，配它们正是开
    // 第一个会话之前想做的事。这条通道早先按 sessionId 取，那一刻三个页面只能显示
    // 「还没有打开的会话」—— 那就是这次的回归点
    const noSession = d.projectInfoNoSession
    check(
      '没开会话也能拿到设置页快照（技能 / MCP 挂在项目上）',
      noSession?.ok === true && noSession.info?.cwd === d.opened?.a?.cwd,
      JSON.stringify(noSession),
    )
    check(
      '没开会话时快照就已经是完整的（档案、技能、MCP 都在）',
      Array.isArray(noSession?.info?.profiles) &&
        noSession.info.profiles.length === 1 &&
        noSession.info.activeProvider === 'default' &&
        Array.isArray(noSession.info.skills) &&
        Array.isArray(noSession.info.mcp),
      JSON.stringify({ profiles: noSession?.info?.profiles, activeProvider: noSession?.info?.activeProvider }),
    )

    const info = d.projectInfo?.info
    check('project/info 拿得到快照', d.projectInfo?.ok === true && !!info, JSON.stringify(d.projectInfo))
    // 环境变量里那个刻意非默认的名字，得一路传到设置页
    check('快照里的模型与生效配置一致', info?.provider?.model === 'desk-model', info?.provider?.model)
    check('快照带上了接口地址', info?.provider?.baseUrl?.includes('localhost'), info?.provider?.baseUrl)
    // 密钥**不出主进程**：快照里只能有打码提示，绝不能是 `mock` 本身
    check('快照里的密钥是打码的', info?.provider?.apiKeyHint === '····mock' && !JSON.stringify(info).includes('"mock"'), info?.provider?.apiKeyHint)
    check('快照带上了上下文与权限配置', info?.context?.window > 0 && Array.isArray(info?.permissions?.allow), JSON.stringify(info?.context))
    check('临时项目里没有技能', Array.isArray(info?.skills) && info.skills.length === 0, JSON.stringify(info?.skills))
    check('没配 mcpServers 就是空列表', Array.isArray(info?.mcp) && info.mcp.length === 0, JSON.stringify(info?.mcp))
    check(
      'MCP 开销提示的措辞由后端统一出（没接入时是空串）',
      info?.mcpCost?.infoText === '' && info.mcpCost.warnText === '',
      JSON.stringify(info?.mcpCost),
    )

    // 开关一个不存在的服务器：必须报失败并把原因带出来，不能报成功
    check(
      '接不上的 MCP 服务器返回 {ok:false, reason}',
      d.mcpToggle?.ok === false && typeof d.mcpToggle.reason === 'string' && d.mcpToggle.reason.includes('nope'),
      JSON.stringify(d.mcpToggle),
    )

    // 改「默认模型」：写回项目配置文件，且只影响之后新建的会话
    check('默认模型写回了项目配置文件', d.setDefaultModel?.ok === true, JSON.stringify(d.setDefaultModel))
    check(
      '写到的是项目里那份 config.json',
      String(d.setDefaultModel?.file).endsWith(path.join('.clauda', 'config.json')),
      d.setDefaultModel?.file,
    )
    // 模型落在**当前那份档案**上（旧的 `provider.model` 那个位置已经不存在了）
    check(
      '落盘的是合法 JSON 且带着新模型',
      JSON.parse(d.configOnDisk).profiles?.default?.model === 'desk-model-2',
      d.configOnDisk,
    )
    check('新会话拿到了新的默认模型', d.openedAfterModel?.model === 'desk-model-2', d.openedAfterModel?.model)

    // ---- 加一份档案：**添加 ≠ 切过去**
    const added = d.configAfterAdd ? JSON.parse(d.configAfterAdd) : {}
    check(
      '加一份档案把地址与模型一起写进了新档案',
      added.profiles?.deepseek?.baseUrl === 'https://api.deepseek.com/v1' &&
        added.profiles?.deepseek?.model === 'deepseek-chat',
      JSON.stringify(added.profiles?.deepseek),
    )
    check(
      '加一份档案不会顺手换掉当前使用那份',
      added.activeProvider === 'default' && added.profiles?.default?.model === 'desk-model-2',
      JSON.stringify({ activeProvider: added.activeProvider, def: added.profiles?.default }),
    )
    check(
      '写回时只碰被指定的键（provider 段里那些旋钮与 mcpServers 一字未动）',
      added.provider?.timeoutMs === 20000 &&
        added.provider?.baseUrl === undefined &&
        Object.keys(added.mcpServers ?? {}).length === 0,
      JSON.stringify(added.provider),
    )
    // 这条是这次改动里最容易出事的不变式：`loadConfig()` 会把 `${CLAUDA_API_KEY}` 换成
    // 真实密钥，拿它的结果回写就是把密钥明文落盘
    check(
      '写回的是磁盘原文，${CLAUDA_API_KEY} 没被展开成明文',
      d.configAfterAdd?.includes('${CLAUDA_API_KEY}') === true && d.configAfterAdd.includes('"mock"') === false,
      d.configAfterAdd,
    )
    const infoAfterAdd = d.projectInfoAfterAdd?.info
    check(
      '快照里两份档案都在，新那份标着「不是当前使用」',
      infoAfterAdd?.profiles?.length === 2 &&
        infoAfterAdd.profiles.find((p) => p.key === 'deepseek')?.isActive === false &&
        infoAfterAdd.activeProvider === 'default',
      JSON.stringify(infoAfterAdd?.profiles?.map((p) => `${p.key}:${p.isActive}`)),
    )
    check('加一份档案不动当前生效的地址', infoAfterAdd?.provider?.baseUrl?.includes('localhost'), infoAfterAdd?.provider?.baseUrl)

    // ---- 切当前使用：换的是 activeProvider，档案本身一个字没动
    const after = d.configAfterVendor ? JSON.parse(d.configAfterVendor) : {}
    check('切当前使用落在 activeProvider 上', after.activeProvider === 'deepseek', String(after.activeProvider))
    check(
      '两份档案都还在（是并存，不是替换）',
      after.profiles?.default?.model === 'desk-model-2' && after.profiles?.deepseek?.model === 'deepseek-chat',
      JSON.stringify(Object.keys(after.profiles ?? {})),
    )
    check(
      '写回时只碰被指定的键（provider 段里那些旋钮与 mcpServers 一字未动）',
      after.provider?.timeoutMs === 20000 &&
        after.provider?.baseUrl === undefined &&
        Object.keys(after.mcpServers ?? {}).length === 0,
      JSON.stringify(after.provider),
    )
    check(
      '切完之后原文里的 ${CLAUDA_API_KEY} 仍是原文',
      d.configAfterVendor?.includes('${CLAUDA_API_KEY}') === true && d.configAfterVendor.includes('"mock"') === false,
      d.configAfterVendor,
    )
    check(
      '设置页回来的 vendorKey 与新地址一致（界面不会显示旧厂商）',
      d.projectInfoAfterVendor?.info?.provider?.vendorKey === 'deepseek',
      d.projectInfoAfterVendor?.info?.provider?.vendorKey,
    )
    check('切完厂商后新建的会话用新厂商的默认模型', d.openedAfterVendor?.model === 'deepseek-chat', d.openedAfterVendor?.model)
    check(
      '未知档案被 channel 层挡下，且没动文件',
      d.badVendor?.ok === false && String(d.badVendor.reason).includes('nope') && d.configAfterBadVendor === d.configAfterVendor,
      JSON.stringify(d.badVendor),
    )
    check(
      '当前使用那份删不掉（删了配置会静默退回内置默认值）',
      d.removeActive?.ok === false &&
        String(d.removeActive.reason).includes('当前使用') &&
        d.configAfterRemoveActive === d.configAfterVendor,
      JSON.stringify(d.removeActive),
    )
    // ---- 技能与 MCP 的增删：设置页那两个表单和对话里那四个工具最终都走这四条通道
    //
    // 断言一律盯**磁盘上的文件**和通道回来的快照。通道回一个路径不代表文件写出来了；
    // 配置里的键写对了也不代表运行期真连上了 —— 这两件事各有各的错法。
    const projCwd = d.opened?.a?.cwd
    check(
      'skill/add 把 SKILL.md 写到了项目的技能根下',
      d.skillAdd?.ok === true &&
        d.skillAdd.file === path.join(projCwd, '.clauda', 'skills', 'weekly-report', 'SKILL.md'),
      JSON.stringify(d.skillAdd),
    )
    check(
      '磁盘上那份真的带 frontmatter，名字与说明都在',
      typeof d.skillFile === 'string' &&
        d.skillFile.startsWith('---\n') &&
        d.skillFile.includes('name: weekly-report') &&
        /description: .*周报/.test(d.skillFile),
      String(d.skillFile).slice(0, 200),
    )
    check(
      '设置页快照里出现了新技能',
      (d.projectInfoAfterSkill?.info?.skills ?? []).some((s) => s.name === 'weekly-report'),
      JSON.stringify(d.projectInfoAfterSkill?.info?.skills),
    )
    // 决策 2（立刻生效）唯一的验收点：这个会话是**零技能时**开出来的，那时 `skill`
    // 工具根本不在集合里。加完技能当场就能看到它，才叫「当前会话也能用」
    check(
      '加完技能后老会话当场拿到 skill 工具（不用新开会话）',
      (d.stateAfterSkill?.session?.tools ?? []).includes('skill'),
      JSON.stringify(d.stateAfterSkill?.session?.tools),
    )
    check(
      '范围选全局就落在 CLAUDA_HOME 下（两个根真的分流了）',
      d.skillAddGlobal?.ok === true && d.globalSkillFile === true,
      JSON.stringify({ res: d.skillAddGlobal, exists: d.globalSkillFile }),
    )
    // 名字是路径的一部分，不合规必须**当场拒**：静默改名会让界面上的名字和目录名对不上
    check(
      '不合规的技能名被挡住，磁盘上一个目录都没多',
      d.badSkill?.ok === false && String(d.badSkill.reason).length > 0,
      JSON.stringify(d.badSkill),
    )
    check('被拒的那次没写出任何东西', Array.isArray(d.escapedSkill) && d.escapedSkill.length === 0, JSON.stringify(d.escapedSkill))
    check(
      'skill/remove 删的是整个技能目录',
      d.skillRemove?.ok === true && d.skillGone === true,
      JSON.stringify({ res: d.skillRemove, gone: d.skillGone }),
    )
    check(
      '删不存在的技能报「没有」，不静默成功',
      d.skillRemoveMissing?.ok === false && String(d.skillRemoveMissing.reason).includes('weekly-report'),
      JSON.stringify(d.skillRemoveMissing),
    )
    check(
      '删完之后快照里没有它了（全局那份还在）',
      !(d.projectInfoAfterSkillRemove?.info?.skills ?? []).some((s) => s.name === 'weekly-report') &&
        (d.projectInfoAfterSkillRemove?.info?.skills ?? []).some((s) => s.name === 'house-style'),
      JSON.stringify(d.projectInfoAfterSkillRemove?.info?.skills),
    )

    // 技能开关：这一刻只剩 `house-style` 一个技能，关掉它之后 `skill` 工具**本身**也该
    // 从集合里摘掉（零技能不挂那份 schema）。这条是「关到底真的省了」唯一看得见的证据
    check(
      '关掉技能只写选中的那份范围（这里是全局那份）',
      d.skillDisable?.ok === true && (d.skillDisable.files ?? []).length === 1 && String(d.skillDisable.files[0]).includes('clauda-desk-home'),
      JSON.stringify(d.skillDisable),
    )
    const disabledGlobal = JSON.parse(d.skillDisableFiles?.[0] ?? '{}')
    const disabledProject = JSON.parse(d.skillDisableFiles?.[1] ?? '{}')
    check(
      '关掉的名字进了全局配置，项目那份一个字没动',
      JSON.stringify(disabledGlobal.disabledSkills) === '["house-style"]' && disabledProject.disabledSkills === undefined,
      JSON.stringify({ g: disabledGlobal.disabledSkills, p: disabledProject.disabledSkills }),
    )
    const skillOff = (d.projectInfoAfterSkillDisable?.info?.skills ?? []).find((s) => s.name === 'house-style')
    check(
      '快照里它还列着（技能页要能把关掉的再打开），但标着 disabled',
      skillOff?.disabled === true,
      JSON.stringify(skillOff),
    )
    check(
      '关到最后一个之后 skill 工具当场从集合里消失',
      !(d.stateAfterSkillDisable?.session?.tools ?? []).includes('skill'),
      JSON.stringify(d.stateAfterSkillDisable?.session?.tools),
    )
    check('关掉不是删掉：SKILL.md 还在磁盘上', d.skillFileAfterDisable === true)
    // 禁用名单在两份配置之间是**并集**（限制只该越合越紧），代价是「打开」必须两份都清 ——
    // 合并之后看不出某一条来自哪份文件
    check(
      '再关一次（这回写项目那份）两份配置里就都有了',
      d.skillDisableProject?.ok === true &&
        (d.skillDisableProjectFiles ?? []).every((txt) => JSON.stringify(JSON.parse(String(txt)).disabledSkills) === '["house-style"]'),
      JSON.stringify(d.skillDisableProjectFiles),
    )
    check(
      '打开是两份一起清（少清一份就表现为「关得掉、开不回来」）',
      d.skillEnable?.ok === true && (d.skillEnable.files ?? []).length === 2,
      JSON.stringify(d.skillEnable),
    )
    check(
      '两份配置里都不再有它（名单空了整个键就该删掉，不留一个 `[]`）',
      (d.skillEnableFileContents ?? []).every((txt) => !String(txt).includes('disabledSkills')),
      JSON.stringify(d.skillEnableFileContents).slice(0, 300),
    )
    check(
      '打开之后 skill 工具回来了，快照里也不带 disabled',
      (d.stateAfterSkillEnable?.session?.tools ?? []).includes('skill') &&
        (d.projectInfoAfterSkillEnable?.info?.skills ?? []).find((s) => s.name === 'house-style')?.disabled === false,
      JSON.stringify({ tools: d.stateAfterSkillEnable?.session?.tools }),
    )
    check(
      '关一个不存在的技能会失败（否则配置里多一条永远不生效的记录）',
      d.skillDisableMissing?.ok === false && String(d.skillDisableMissing.reason).includes('nope'),
      JSON.stringify(d.skillDisableMissing),
    )

    // MCP：真起一个子进程（tests/mock-mcp.mjs，两个工具）再删掉。状态是 connected、
    // 工具数是**真数出来**的 2 而不是回显配置 —— 这条才有资格叫「加完就能用」
    check('mcp/add 起来了那个子进程', d.mcpAdd?.ok === true, JSON.stringify(d.mcpAdd))
    const mcpAdded = (d.projectInfoAfterMcpAdd?.info?.mcp ?? []).find((s) => s.name === 'desk-mock')
    check(
      '新服务器在快照里是 connected 且工具数对得上',
      mcpAdded?.state === 'connected' && mcpAdded.toolCount === 2,
      JSON.stringify(mcpAdded),
    )
    const afterMcpAdd = d.configAfterMcpAdd ? JSON.parse(d.configAfterMcpAdd) : {}
    check(
      'MCP 配置写进了项目那份 config.json 的 mcpServers',
      afterMcpAdd.mcpServers?.['desk-mock']?.command === process.execPath &&
        afterMcpAdd.mcpServers?.['desk-mock']?.args?.[0]?.endsWith('mock-mcp.mjs'),
      JSON.stringify(afterMcpAdd.mcpServers),
    )
    // 加了新段落之后，别的段落还必须是**此刻**的原样（前面刚切到 deepseek、
    // 两份档案并存）：档案、当前使用、传输旋钮、未展开的占位符，一条都不能被顺手重写
    check(
      '加 MCP 时其它段落一字未动',
      afterMcpAdd.activeProvider === 'deepseek' &&
        afterMcpAdd.profiles?.default?.model === 'desk-model-2' &&
        afterMcpAdd.profiles?.deepseek?.model === 'deepseek-chat' &&
        afterMcpAdd.provider?.timeoutMs === 20000 &&
        afterMcpAdd.provider?.baseUrl === undefined &&
        d.configAfterMcpAdd.includes('${CLAUDA_API_KEY}') === true,
      JSON.stringify({ active: afterMcpAdd.activeProvider, provider: afterMcpAdd.provider }),
    )
    // 工具白名单：明细按需取（`mcp/tools/get`），改完**当场**生效且不重连。
    // 这条覆盖的是通道层的三个分支 —— 渲染层的桩没法替代它
    check(
      'mcp/tools/get 报出这台的全部工具和各自接没接',
      d.mcpToolsGet?.ok === true &&
        (d.mcpToolsGet.tools ?? []).length === 2 &&
        (d.mcpToolsGet.tools ?? []).every((t) => t.allowed === true && typeof t.tokens === 'number'),
      JSON.stringify(d.mcpToolsGet),
    )
    const afterMcpTools = d.configAfterMcpTools ? JSON.parse(d.configAfterMcpTools) : {}
    check(
      'mcp/tools/set 只往配置里加 tools 一个键（command/args 没被抹掉）',
      d.mcpToolsSet?.ok === true &&
        JSON.stringify(afterMcpTools.mcpServers?.['desk-mock']?.tools) === '["echo"]' &&
        afterMcpTools.mcpServers?.['desk-mock']?.command === process.execPath,
      JSON.stringify(afterMcpTools.mcpServers?.['desk-mock']),
    )
    const mcpAfterTools = (d.projectInfoAfterMcpTools?.info?.mcp ?? []).find((s) => s.name === 'desk-mock')
    check(
      '改完当场少一个工具，而且是「接进来 1 / 总共 2」',
      mcpAfterTools?.state === 'connected' && mcpAfterTools.toolCount === 1 && mcpAfterTools.toolTotal === 2 && mcpAfterTools.toolLabel === '工具 1/2',
      JSON.stringify(mcpAfterTools),
    )
    check(
      '名字对不上时报「没找到写在哪份文件里」，不静默成功',
      d.mcpToolsMissing?.ok === false && String(d.mcpToolsMissing.reason).includes('nope'),
      JSON.stringify(d.mcpToolsMissing),
    )
    check(
      'tools 不是数组也不是 null 时挡掉（一个字符串落进配置会把整份文件读废）',
      d.mcpToolsBadShape?.ok === false && String(d.mcpToolsBadShape.reason).includes('tools'),
      JSON.stringify(d.mcpToolsBadShape),
    )
    // 「清掉名单」删的是键，不是写一份空名单 —— 后者是**一个都不接**，正好相反
    const afterClear = d.configAfterMcpToolsClear ? JSON.parse(d.configAfterMcpToolsClear) : {}
    check(
      'tools: null 是「不要白名单了」：键被删掉，服务器还留着',
      d.mcpToolsClear?.ok === true &&
        afterClear.mcpServers?.['desk-mock']?.command === process.execPath &&
        !('tools' in (afterClear.mcpServers?.['desk-mock'] ?? {})),
      JSON.stringify(afterClear.mcpServers?.['desk-mock']),
    )

    // 连不上的服务器：`addServer` 抛，通道翻成 `{ok:false, reason}`。**不能**静默报成功 ——
    // 那是「界面说接上了、工具一个没多」那条老回归
    check(
      '连不上的 MCP 服务器返回 {ok:false, reason}',
      d.badMcp?.ok === false && String(d.badMcp.reason).length > 0,
      JSON.stringify(d.badMcp),
    )
    check(
      '失败那次也没把已有的服务器搞脏',
      d.configAfterBadMcp ? JSON.parse(d.configAfterBadMcp).mcpServers?.['desk-mock']?.command === process.execPath : false,
      String(d.configAfterBadMcp).slice(0, 300),
    )
    check(
      'mcp/remove 只摘掉指定的那一条（连不上的那条还在）',
      d.mcpRemove?.ok === true &&
        JSON.stringify(Object.keys(JSON.parse(d.configAfterMcpRemove ?? '{}').mcpServers ?? {})) === '["bad-mock"]',
      String(d.configAfterMcpRemove).slice(-200),
    )
    check(
      '删完之后快照里没有那个服务器了',
      !(d.projectInfoAfterMcpRemove?.info?.mcp ?? []).some((s) => s.name === 'desk-mock'),
      JSON.stringify(d.projectInfoAfterMcpRemove?.info?.mcp),
    )

    // ---- 智能体：设置页那套表单与「开新会话时绑定」最终都走这四条通道
    //
    // 断言一律盯**磁盘上的文件**。通道回一个路径不代表文件写出来了；快照里有那一行
    // 也不代表 frontmatter 真是那个形状（旧路径、丢了 `temperature: 0`，光看返回值都发现不了）。
    check(
      'agent/add 把 AGENT.md 写到了项目的智能体根下',
      d.agentAdd?.ok === true &&
        d.agentAdd.file === path.join(projCwd, '.clauda', 'agents', 'code-review', 'AGENT.md') &&
        d.agentAdd.created === true,
      JSON.stringify(d.agentAdd),
    )
    check(
      '磁盘上那份真的带 frontmatter，tools / temperature 两行都在',
      typeof d.agentFile === 'string' &&
        d.agentFile.startsWith('---\n') &&
        d.agentFile.includes('name: code-review') &&
        d.agentFile.includes('tools: read_file, grep') &&
        // 0 是**有效配置**：丢了这一行就是「温度设置不生效」，而返回值里根本看不出来
        d.agentFile.includes('temperature: 0') &&
        // 问题里那个逗号**不能**把一句切成两条 —— 这是 `questions` 用 `|` 当分隔符的全部理由
        d.agentFile.includes('questions: 这次改动有什么风险 | 跑测试要装什么，怎么装？'),
      String(d.agentFile).slice(0, 400),
    )
    check(
      'agent/get 把正文读回来了（`project/info` 刻意不带正文）',
      d.agentGet?.ok === true &&
        String(d.agentGet.agent?.body).includes('严格的代码审查员') &&
        d.agentGet.agent?.questions?.length === 2 &&
        d.agentGet.agent.questions[1] === '跑测试要装什么，怎么装？',
      JSON.stringify(d.agentGet),
    )
    // 智能体文件是要能提交进 git、发给别人的，所以快照里只许有它**自己**写的东西 + 路径：
    // 端点与密钥一个字都不能出现（`profile` 只出名字）
    const agentInfo = (d.projectInfoAfterAgentAdd?.info?.agents ?? []).find((a) => a.name === 'code-review')
    check(
      '设置页快照里有它，且不带正文、不带任何密钥',
      agentInfo !== undefined &&
        agentInfo.description === '按严重程度审查改动' &&
        agentInfo.profile === 'default' &&
        agentInfo.body === undefined &&
        agentInfo.isDefault === false &&
        !/apiKey|baseUrl|\$\{CLAUDA_API_KEY\}/.test(JSON.stringify(d.projectInfoAfterAgentAdd?.info?.agents)),
      JSON.stringify(agentInfo),
    )
    // 名字是路径的一部分，不合规必须**当场拒**：静默改名会让界面上的名字和目录名对不上。
    // 这同时复验了 `../` 那道穿越闸门在智能体这条路上一样管用
    check(
      '不合规的智能体名被挡住',
      d.badAgent?.ok === false && String(d.badAgent.reason).length > 0,
      JSON.stringify(d.badAgent),
    )

    // 标「本项目默认」：**只写 config.json 的一个键**。写回走的是磁盘原文，
    // 所以 `${VAR}` 必须**还是**占位符 —— 展开了就是明文密钥落盘，而且是静默发生
    const cfgBeforeAgent = d.configBeforeAgentAdd ? JSON.parse(d.configBeforeAgentAdd) : {}
    const cfgAfterAgent = d.configAfterDefaultAgent ? JSON.parse(d.configAfterDefaultAgent) : {}
    const { defaultAgent: _pickedDefault, ...agentRest } = cfgAfterAgent
    // 基线取在智能体那一段**开头**：`agent/add` 写的是 AGENT.md，配置一个字都不该动
    check('agent/add 没碰过 config.json', d.configBeforeAgentAdd === d.configAfterAgentAdd, '配置在 agent/add 前后不一样')
    check(
      'set-default-agent 只加了 defaultAgent 一个键，其余段落一字未动',
      d.setDefaultAgent?.ok === true &&
        cfgAfterAgent.defaultAgent === 'code-review' &&
        JSON.stringify(agentRest) === JSON.stringify(cfgBeforeAgent) &&
        d.configAfterDefaultAgent.includes('${CLAUDA_API_KEY}') === true,
      JSON.stringify({ res: d.setDefaultAgent, after: cfgAfterAgent }),
    )
    check(
      'project/info 标出了哪一个是本项目默认',
      (d.projectInfoAfterDefaultAgent?.info?.agents ?? []).filter((a) => a.isDefault).map((a) => a.name).join(',') ===
        'code-review' && d.projectInfoAfterDefaultAgent.info.defaultAgent === 'code-review',
      JSON.stringify(d.projectInfoAfterDefaultAgent?.info?.agents),
    )
    // 「套项目默认」只发生在界面那一格下拉框的初始值里，**主进程没有这条魔法** ——
    // 一条没绑过的会话不该因为项目有默认就悄悄变成它（那是行为静默改变，最难查的一类）
    check(
      'agent 传空串 = 明确不要智能体，不套项目默认',
      d.openNoAgent?.ok === true &&
        d.openNoAgent.session.agentName === '' &&
        (d.openNoAgent.session.agentQuestions ?? []).length === 0 &&
        d.openNoAgent.session.agentWarning === '',
      JSON.stringify(d.openNoAgent?.session),
    )
    check(
      'agent 传名字 = 绑上它，空态问题跟着这份**冻结的**配方来',
      d.openWithAgent?.ok === true &&
        d.openWithAgent.session.agentName === 'code-review' &&
        JSON.stringify(d.openWithAgent.session.agentQuestions) ===
          JSON.stringify(['这次改动有什么风险', '跑测试要装什么，怎么装？']),
      JSON.stringify(d.openWithAgent?.session),
    )
    // 名字不存在时**不抛**：一个被删掉的智能体不该让会话打不开（自动恢复那条路尤其）
    check(
      '名字找不到时按「没有智能体」装配，另给一条警告',
      d.openMissingAgent?.ok === true &&
        d.openMissingAgent.session.agentName === '' &&
        String(d.openMissingAgent.session.agentWarning).includes('已经删掉的那个'),
      JSON.stringify(d.openMissingAgent?.session?.agentWarning),
    )

    // 冻结语义的**磁盘证据**：配方随会话落盘。而且里面绝不能有端点或密钥 ——
    // 会话文件是明文 JSON，而 config.json 里的密钥可能正是 `${DEEPSEEK_KEY}` 这种占位符
    const agentRec = d.agentSessionOnDisk ? JSON.parse(d.agentSessionOnDisk) : {}
    check(
      '会话文件里冻着建会话那一刻的配方',
      agentRec.agent?.name === 'code-review' &&
        agentRec.agent.body === undefined &&
        String(agentRec.agent.prompt).includes('严格的代码审查员') &&
        agentRec.agent.model === 'agent-model' &&
        agentRec.agent.temperature === 0 &&
        agentRec.agent.profile === 'default',
      JSON.stringify(agentRec.agent),
    )
    check(
      '会话文件里搜不到任何密钥或端点',
      typeof d.agentSessionOnDisk === 'string' &&
        !/apiKey|baseUrl/.test(d.agentSessionOnDisk) &&
        !d.agentSessionOnDisk.includes('${CLAUDA_API_KEY}'),
      String(d.agentSessionOnDisk).slice(0, 300),
    )

    check(
      'agent/remove 删的是整个智能体目录',
      d.agentRemove?.ok === true && d.agentDirGone === true,
      JSON.stringify({ res: d.agentRemove, gone: d.agentDirGone }),
    )
    // 删不存在的要报「没有」，**不能静默成功**（界面那行会留在原地，用户以为还配着）
    check(
      '删完之后再 get 报「没有」，不静默成功',
      d.agentGetMissing?.ok === false && String(d.agentGetMissing.reason).includes('code-review'),
      JSON.stringify(d.agentGetMissing),
    )
    check(
      '快照里也没有它了',
      !(d.projectInfoAfterAgentRemove?.info?.agents ?? []).some((a) => a.name === 'code-review'),
      JSON.stringify(d.projectInfoAfterAgentRemove?.info?.agents),
    )
    // **先前那条绑过它的老会话照样能打开、还是它那份配方** —— 配方冻在会话里，不依赖那个目录
    // 还在。这是「冻结」而不是「恢复时按名字重查」最直接的正面证据
    check(
      '智能体删掉后，老会话恢复出来仍绑着它',
      d.agentSessionAfterRemove?.ok === true &&
        d.agentSessionAfterRemove.session.agentName === 'code-review' &&
        JSON.stringify(d.agentSessionAfterRemove.session.agentQuestions) ===
          JSON.stringify(['这次改动有什么风险', '跑测试要装什么，怎么装？']),
      JSON.stringify(d.agentSessionAfterRemove?.session),
    )

    check(
      '下发的厂商表非空且 key 唯一（renderer 的选择器直接照着它画）',
      Array.isArray(d.projectInfoAfterVendor?.info?.vendors) &&
        d.projectInfoAfterVendor.info.vendors.length >= 9 &&
        new Set(d.projectInfoAfterVendor.info.vendors.map((v) => v.key)).size === d.projectInfoAfterVendor.info.vendors.length,
      JSON.stringify(d.projectInfoAfterVendor?.info?.vendors?.map((v) => v.key)),
    )

    // 会话 id 来自 renderer 的 IPC 载荷，而它会一路流到写路径（persist.ts 用同一个 id 续写），
    // 所以 `../../x` 是任意路径写。边界上必须挡掉，而不是等 session.ts 兜底
    check(
      'session/resume 拒绝穿越型 id',
      d.badResume?.ok === false && String(d.badResume.reason).includes('非法'),
      JSON.stringify(d.badResume),
    )
    check(
      'session/open 拒绝穿越型 id',
      d.badOpen?.ok === false && String(d.badOpen.reason).includes('非法'),
      JSON.stringify(d.badOpen),
    )
    check('穿越尝试真的没写出文件', Array.isArray(d.strayFile) && d.strayFile.length === 0, JSON.stringify(d.strayFile))

    // ---- 附件：图片真的作为多模态内容发出去了吗
    //
    // 这是「输入框能发文件」这条需求里唯一算数的证据 —— 界面上有 chip、payload 里
    // 有字段，都不代表字节真的上了线。只能看服务端究竟收到了什么。
    const ingested = d.attachIngest?.attachments ?? []
    check(
      'attachment/ingest 把磁盘上的图片读成了 data URL',
      d.attachIngest?.ok === true &&
        ingested.length === 1 &&
        ingested[0].kind === 'image' &&
        ingested[0].dataUrl?.startsWith('data:image/png;base64,'),
      JSON.stringify(d.attachIngest),
    )
    // 字节数得是**真读出来的那份**，不是渲染层报上来的（`sanitizeAttachments`
    // 还会按 data URL 长度重算一遍，那是另一条防线）
    check(
      'ingest 报的字节数和磁盘上的文件一致',
      ingested[0]?.bytes > 0 && ingested[0].bytes === d.shotBytes,
      `${ingested[0]?.bytes} vs ${d.shotBytes}`,
    )
    check(
      '非图片附件只带路径、不带内容',
      d.fileIngest?.ok === true &&
        d.fileIngest.attachments?.[0]?.kind === 'file' &&
        d.fileIngest.attachments[0].dataUrl === undefined &&
        typeof d.fileIngest.attachments[0].path === 'string',
      JSON.stringify(d.fileIngest),
    )
    check('带附件的这一轮跑成功了', d.attachSend?.ok === true, JSON.stringify(d.attachSend))

    const sentUser = [...(d.attachSeen?.messages ?? [])].reverse().find((m) => m.role === 'user')
    check(
      '请求体里那条用户消息的 content 是内容块数组',
      Array.isArray(sentUser?.content),
      JSON.stringify(sentUser?.content).slice(0, 300),
    )
    const imageParts = (Array.isArray(sentUser?.content) ? sentUser.content : []).filter(
      (p) => p?.type === 'image_url',
    )
    check(
      '数组里带着真的 image_url 块，url 是 data:image/png;base64',
      imageParts.length === 1 && imageParts[0].image_url?.url?.startsWith('data:image/png;base64,'),
      JSON.stringify(imageParts).slice(0, 200),
    )
    check(
      '用户自己打的那句话也还在（图片没有把文字挤掉）',
      (Array.isArray(sentUser?.content) ? sentUser.content : []).some(
        (p) => p?.type === 'text' && p.text === '看看这张图',
      ),
      JSON.stringify(sentUser?.content).slice(0, 300),
    )

    // 留在历史里 = 落在会话文件里。没落盘的话关掉窗口这张图就没了，「后续还能追问」是空话
    const onDiskUser = (d.attachOnDisk?.messages ?? []).filter((m) => m.role === 'user').find((m) =>
      Array.isArray(m.content),
    )
    check(
      '带图的那条消息原样落进了会话文件',
      Array.isArray(onDiskUser?.content) && onDiskUser.content.some((p) => p?.type === 'image_url'),
      JSON.stringify(onDiskUser?.content).slice(0, 300),
    )
    // 纯文本消息**仍然**是字符串：这是保住 CLI、压缩摘要、老会话文件那几条路径不回归的关键。
    // 顺手把整条链路改成数组是最省事的写法，也是最容易在某处静默出错的写法
    check(
      '纯文本消息的 content 依然是字符串（老路径没被顺手改成数组）',
      restored.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content === '项目叫什么'),
      JSON.stringify(restored.map((m) => typeof m.content)),
    )

    // 「关掉窗口重开、点回该会话」：恢复回来的消息里必须还带着图片，
    // 否则界面上那个会话只剩一句话，用户会以为图丢了
    const resumedImage = (d.attachResumed?.messages ?? [])
      .filter((m) => m.role === 'user' && Array.isArray(m.content))
      .flatMap((m) => m.content)
      .find((p) => p?.type === 'image_url')
    check(
      '从历史里恢复出来的会话仍带着那张图',
      d.attachResumed?.ok === true && resumedImage?.image_url?.url?.startsWith('data:image/png;base64,'),
      JSON.stringify(d.attachResumed?.messages ?? []).slice(0, 300),
    )

    check('退出后会话真的没了', d.afterQuit?.ok === false, JSON.stringify(d.afterQuit))
    check('退出不卡死（MCP 该关的都关了）', elapsed < 30_000, `耗时 ${elapsed}ms`)
  }
}

server.close()
fs.rmSync(TMP_HOME, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
