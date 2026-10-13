/**
 * 工具与权限的单元验收，直接打构建产物（dist/）。
 * 跑之前需要先 `npm run build`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url).href
const { PermissionManager } = await import(`${dist}permissions.js`)
const { findTool } = await import(`${dist}tools/index.js`)
const { TodoList } = await import(`${dist}tools/todo.js`)

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-unit-'))
const cwd = tmp
const todos = new TodoList()
const config = {}

function ctx(extra = {}) {
  return {
    cwd,
    signal: new AbortController().signal,
    todos,
    permission: new PermissionManager({ mode: 'auto', allow: [], deny: [] }, async () => true),
    config,
    ...extra,
  }
}
const run = (name, args, c = ctx()) => findTool(name).run(args, c)
const catchErr = async (fn) => {
  try {
    return { value: await fn(), error: null }
  } catch (e) {
    return { value: null, error: e.message }
  }
}

console.log('\n== 文件工具 ==')
fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\nbeta\ngamma\nbeta\n', 'utf8')

const read = await run('read_file', { path: 'a.txt' })
check('read_file 带行号', /^1\talpha/.test(read), JSON.stringify(read.slice(0, 20)))

const readOffset = await run('read_file', { path: 'a.txt', offset: 2, limit: 2 })
check(
  'read_file 支持 offset/limit',
  readOffset.includes('2\tbeta') && readOffset.includes('3\tgamma') && !readOffset.includes('alpha'),
)

const ambiguous = await catchErr(() =>
  run('edit_file', { path: 'a.txt', old_string: 'beta', new_string: 'B' }),
)
check('edit_file 非唯一匹配时报错', /出现了 2 次/.test(ambiguous.error ?? ''), ambiguous.error)

await run('edit_file', { path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' })
check('edit_file 精确替换生效', fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8').startsWith('ALPHA'))

await run('edit_file', { path: 'a.txt', old_string: 'beta', new_string: 'B', replace_all: true })
check('edit_file replace_all 全部替换', !fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8').includes('beta'))

const notFound = await catchErr(() =>
  run('edit_file', { path: 'a.txt', old_string: 'zzz-not-there', new_string: 'x' }),
)
check('edit_file 未匹配时报错', /未匹配到内容/.test(notFound.error ?? ''), notFound.error)

// new_string 缺参数时**不能**当成空串 —— 那会把匹配到的原文静默删掉。
// 而 new_string 显式给空串是合法的（就是要删），所以这里必须区分「没传」和「传了空」。
fs.writeFileSync(path.join(cwd, 'del.txt'), 'keep\nDELETE-ME\nkeep\n', 'utf8')
const noNewStr = await catchErr(() => run('edit_file', { path: 'del.txt', old_string: 'DELETE-ME\n' }))
check('edit_file 缺 new_string 时报错', /new_string/.test(noNewStr.error ?? ''), noNewStr.error)
check(
  'edit_file 缺 new_string 时不改动文件',
  fs.readFileSync(path.join(cwd, 'del.txt'), 'utf8').includes('DELETE-ME'),
  fs.readFileSync(path.join(cwd, 'del.txt'), 'utf8'),
)

await run('edit_file', { path: 'del.txt', old_string: 'DELETE-ME\n', new_string: '' })
check('edit_file 显式空 new_string 仍可删除', !fs.readFileSync(path.join(cwd, 'del.txt'), 'utf8').includes('DELETE-ME'))

const missingArg = await catchErr(() => run('read_file', {}))
check('缺参数时报错', /缺少必填参数/.test(missingArg.error ?? ''), missingArg.error)

const missingFile = await catchErr(() => run('read_file', { path: 'nope.txt' }))
check('读不存在的文件时报错', /文件不存在/.test(missingFile.error ?? ''), missingFile.error)

console.log('\n== 搜索工具 ==')
fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true })
fs.writeFileSync(path.join(cwd, 'sub', 'b.ts'), 'export function hello() {}\n', 'utf8')
fs.writeFileSync(path.join(cwd, 'c.ts'), 'const hello = 1\n', 'utf8')
fs.mkdirSync(path.join(cwd, 'node_modules', 'x'), { recursive: true })
fs.writeFileSync(path.join(cwd, 'node_modules', 'x', 'index.ts'), 'export function hello() {}\n', 'utf8')

const globbed = await run('glob', { pattern: '**/*.ts' })
check('glob 找到 ts 文件', globbed.includes('sub/b.ts') && globbed.includes('c.ts'), globbed)
check('glob 跳过 node_modules', !globbed.includes('node_modules'), globbed)

const globScoped = await run('glob', { pattern: '*.ts' })
check('glob 无斜杠模式按 basename 匹配', globScoped.includes('c.ts') && globScoped.includes('sub/b.ts'), globScoped)

const grepped = await run('grep', { pattern: 'function hello', output_mode: 'content' })
check('grep content 模式带行号', /sub\/b\.ts:1:/.test(grepped), grepped)
check('grep 跳过 node_modules', !grepped.includes('node_modules'), grepped)

const grepCount = await run('grep', { pattern: 'hello', output_mode: 'count' })
check('grep count 模式', /c\.ts: 1/.test(grepCount), grepCount)

const badRegex = await catchErr(() => run('grep', { pattern: '([' }))
check('grep 非法正则报错', /正则表达式无效/.test(badRegex.error ?? ''), badRegex.error)

console.log('\n== bash 工具 ==')
const echoed = await run('bash', { command: 'echo hi' })
check('bash 正常输出', /hi/.test(echoed) && /退出码 0/.test(echoed), echoed)

const failing = await run('bash', { command: 'exit 3' })
check('bash 报告非零退出码', /退出码 3/.test(failing), failing)

const dangerous = await catchErr(() => run('bash', { command: 'rm -rf /' }))
check('bash 拦截危险命令', /危险操作/.test(dangerous.error ?? ''), dangerous.error)

const timedOut = await run('bash', { command: 'sleep 5', timeout: 1000 })
check('bash 超时被终止', /超时/.test(timedOut), timedOut.slice(-120))

// description 曾经只是被解析进 ExecOptions 就没人读了：schema 对模型承诺「展示给用户看」，
// 系统提示词也要求模型填，结果用户什么也看不到。现在拼进 summary（工具块标题就用它）。
{
  const { bashTool } = await import(`${dist}tools/bash.js`)
  const withDesc = bashTool.summary({ command: 'npm test', description: '跑测试' })
  check('bash summary 带上 description', withDesc.includes('npm test') && withDesc.includes('跑测试'), withDesc)
  const noDesc = bashTool.summary({ command: 'npm test' })
  check('bash 没给 description 时 summary 只有命令', noDesc === 'npm test', noDesc)
  const blankDesc = bashTool.summary({ command: 'npm test', description: '   ' })
  check('bash description 全是空白时当作没给', blankDesc === 'npm test', blankDesc)
}

console.log('\n== todo 工具 ==')
await run('todo_write', {
  todos: [
    { content: '第一步', status: 'completed' },
    { content: '第二步', status: 'in_progress', activeForm: '正在做第二步' },
  ],
})
check('todo_write 写入清单', todos.all().length === 2)
check('todo_write 能取到进行中项', todos.current()?.activeForm === '正在做第二步')

console.log('\n== 权限 ==')
const readTool = findTool('read_file')
const writeTool = findTool('write_file')
const bashTool = findTool('bash')

const pDeny = new PermissionManager({ mode: 'default', allow: [], deny: [] }, async () => false)
check('default 模式：读操作自动放行', (await pDeny.check(readTool, { path: 'a.txt' })).ok)
check('default 模式：写操作被拒', !(await pDeny.check(writeTool, { path: 'a.txt' })).ok)

const pAllow = new PermissionManager({ mode: 'default', allow: [], deny: [] }, async () => true)
check('default 模式：用户同意后放行', (await pAllow.check(writeTool, { path: 'a.txt' })).ok)

const pPlan = new PermissionManager({ mode: 'plan', allow: [], deny: [] }, async () => true)
check('plan 模式：读放行', (await pPlan.check(readTool, { path: 'a.txt' })).ok)
check('plan 模式：写被拒（即使 asker 同意）', !(await pPlan.check(writeTool, { path: 'a.txt' })).ok)
check('plan 模式：执行被拒', !(await pPlan.check(bashTool, { command: 'ls' })).ok)

const pRule = new PermissionManager({ mode: 'default', allow: ['Bash(npm run:*)'], deny: [] }, async () => false)
check('allow 规则命中前缀', (await pRule.check(bashTool, { command: 'npm run build' })).ok)
check('allow 规则不误伤其他命令', !(await pRule.check(bashTool, { command: 'rm a.txt' })).ok)

const pDenyRule = new PermissionManager({ mode: 'auto', allow: [], deny: ['Bash(rm -rf:*)'] }, async () => true)
check('auto 模式下 deny 规则仍然生效', !(await pDenyRule.check(bashTool, { command: 'rm -rf ./x' })).ok)
check('auto 模式其他命令放行', (await pDenyRule.check(bashTool, { command: 'ls' })).ok)

// 读操作在 default 模式下本来就自动放行，所以路径规则要用写工具才测得出效果
const pFileRule = new PermissionManager({ mode: 'default', allow: ['write_file(src/**)'], deny: [] }, async () => false)
check('路径规则命中：src 下的写入免询问', (await pFileRule.check(writeTool, { path: 'src/index.ts' })).ok)
check('路径规则不越界：src 外的写入仍被拒', !(await pFileRule.check(writeTool, { path: 'other/x.ts' })).ok)

const pDenyPath = new PermissionManager({ mode: 'auto', allow: [], deny: ['write_file(**/*.env)'] }, async () => true)
check('auto 模式下 deny 路径规则拦住敏感文件', !(await pDenyPath.check(writeTool, { path: 'config/.env' })).ok)
check('auto 模式下普通写入照常放行', (await pDenyPath.check(writeTool, { path: 'src/a.ts' })).ok)

// Claude Code 风格的多词工具名必须能对上 snake_case 工具名。这组是补一个静默失效的坑：
// 规则名走的是大小写不敏感比较，`Read` 永远等不上 `read_file`，于是配置模板里写的
// `allow: ['Read', 'TodoWrite']` 是两条死规则 —— 用户以为放行了，其实没有。
// 用 mode:'auto' + asker 拒绝，确保结论只由规则决定，不掺模式逻辑。
const todoTool = findTool('todo_write')
const editTool = findTool('edit_file')

const pAliasRead = new PermissionManager({ mode: 'auto', allow: [], deny: ['Read'] }, async () => true)
check('Read 别名：deny 规则能拦住 read_file', !(await pAliasRead.check(readTool, { path: 'a.txt' })).ok)

// 配置模板里写的是 `TodoWrite`。它在 default 模式下本来会被询问，用拒绝的 asker 就分不清
// 「规则命中」和「没人问」——所以照样走 deny 才测得准。
const pAliasTodo = new PermissionManager({ mode: 'auto', allow: [], deny: ['TodoWrite'] }, async () => true)
check('TodoWrite 别名：deny 规则能拦住 todo_write', !(await pAliasTodo.check(todoTool, { todos: [] })).ok)


// 读工具在 default 模式下本来就自动放行，所以验证「别名确实被匹配上」一律走 deny 规则：
// allow 命中与自动放行肉眼分不开，deny 命中只可能来自规则本身。
const pAliasPath = new PermissionManager({ mode: 'auto', allow: [], deny: ['Read(src/**)'] }, async () => true)
check('Read(src/**) 按文档写就能命中路径', !(await pAliasPath.check(readTool, { path: 'src/a.ts' })).ok)
check('Read(src/**) 不越界', (await pAliasPath.check(readTool, { path: 'other/a.ts' })).ok)

const pAliasWrite = new PermissionManager({ mode: 'auto', allow: [], deny: ['Write(src/**)'] }, async () => true)
check('Write 别名也能做路径匹配', !(await pAliasWrite.check(writeTool, { path: 'src/a.ts' })).ok)
check('Write(src/**) 不越界', (await pAliasWrite.check(writeTool, { path: 'other/x.ts' })).ok)

const pAliasEdit = new PermissionManager({ mode: 'auto', allow: [], deny: ['Edit'] }, async () => true)
check('Edit 别名：deny 规则能拦住 edit_file', !(await pAliasEdit.check(editTool, { path: 'a.txt' })).ok)

// 别名不能张冠李戴：`Write` 只该管 write_file，不能顺手把 read_file 也拦了
const pAliasScope = new PermissionManager({ mode: 'auto', allow: [], deny: ['Write'] }, async () => true)
check('别名不误伤：Write 规则不动 read_file', (await pAliasScope.check(readTool, { path: 'a.txt' })).ok)
check('别名不误伤：Write 规则不动 glob', (await pAliasScope.check(findTool('glob'), { pattern: '*.ts' })).ok)

// 前缀匹配（mcp__server 那套）不能被别名改造弄坏
const fakeMcpTool = (name) => ({ name, permission: 'exec', summary: () => name, source: { kind: 'mcp', server: 'linear', tool: 'x' } })
const pAliasMcp = new PermissionManager({ mode: 'auto', allow: [], deny: ['mcp__linear'] }, async () => true)
check('别名改造后 mcp__server 前缀规则仍然生效', !(await pAliasMcp.check(fakeMcpTool('mcp__linear__x'), {})).ok)

// ---------------------------------------------------------------- 上下文用量核算
// 这一组是照着真机跑出来的三个问题补的：工具 schema 没算进上下文、单轮内被大工具
// 结果顶爆时压缩救不了场、工具结果没有 token 上限。
console.log('\n== 上下文用量核算 ==')
const { Agent } = await import(`${dist}agent/agent.js`)
const { estimateTokens, capByTokens } = await import(`${dist}util/text.js`)

const { PermissionManager: PM } = await import(`${dist}permissions.js`)
const permAuto = new PM({ mode: 'auto', allow: [], deny: [] }, async () => true)

const fakeView = {
  assistantStart: () => ({ write() {}, end() {} }),
  toolStart() {},
  toolOutput() {},
  toolEnd() {},
  info() {},
  warn() {},
  error() {},
  turnEnd() {},
  thinking() {},
  thinkingDone() {},
}
const fakeProvider = (summary = '摘要正文') => ({
  async *stream() {
    yield { type: 'text', text: summary }
    yield { type: 'done' }
  },
})
function agentConfig(extra = {}) {
  return {
    provider: {
      baseUrl: 'http://x/v1',
      apiKey: 'x',
      model: 'm',
      temperature: 0,
      maxTokens: 100,
      includeUsage: true,
      timeoutMs: 1000,
      maxRetries: 0,
    },
    permissions: { mode: 'auto', allow: [], deny: [] },
    pricing: { input: 0, output: 0, currency: 'CNY' },
    contextWindow: 128000,
    autoCompact: true,
    compactThreshold: 0.75,
    maxSteps: 40,
    ...extra,
  }
}
const makeAgent = (extra) =>
  new Agent({
    cwd,
    config: agentConfig(extra),
    provider: fakeProvider(),
    view: fakeView,
    permissions: permAuto,
  })

const sig = new AbortController().signal

// 恢复会话时系统提示词必须按**当前**配置重建。落盘时的提示词可能已经过期
// （换了模型、换了权限模式、记忆库变了），照搬过来会让整个会话自报旧配置。
{
  const cfg = agentConfig()
  const a = new Agent({ cwd, config: cfg, provider: fakeProvider(), view: fakeView, permissions: permAuto })
  check('系统提示词里带当前模型名', a.messages[0].content.includes('模型'), a.messages[0].content.slice(0, 120))

  cfg.provider.model = '换了模型'
  a.restore({ messages: [{ role: 'system', content: '落盘时的旧提示词' }, { role: 'user', content: '旧问题' }], todos: [], totalUsage: { input: 0, output: 0 }, cost: 0 })
  check('restore 之后系统提示词按新配置重建', a.messages[0].content.includes('换了模型'), a.messages[0].content.slice(0, 200))
  check('restore 保留历史消息', a.messages[1].content === '旧问题', JSON.stringify(a.messages[1]))
  check('restore 不会把旧提示词留在历史里', !a.messages.some((m) => m.content.includes('落盘时的旧提示词')))
}

// 模型偶尔会吐出合法 JSON 但不是对象的参数（`null` / `42` / `[]`）。
// 这类 args 直接取属性会抛 TypeError，而且抛点在整个工具循环的 try 之外 ——
// 整轮对话会被打挂，而不是变成一条工具错误结果喂回模型。
{
  const callsOf = (args) => ({
    async *stream() {
      if (this.sent) return
      this.sent = true
      yield { type: 'tool_call', call: { id: 'c1', name: 'read_file', args, rawArgs: 'null' } }
      yield { type: 'done' }
    },
  })
  for (const [label, args] of [
    ['null', null],
    ['数字', 42],
    ['数组', []],
  ]) {
    const a = new Agent({
      cwd,
      config: agentConfig(),
      provider: callsOf(args),
      view: fakeView,
      permissions: permAuto,
    })
    const r = await catchErr(() => a.runTurn('读一下文件', sig))
    check(`args 是${label}时不崩，转成工具错误`, r.error === null, r.error ?? '')
    check(
      `args 是${label}时确实回了一条 tool 结果`,
      a.messages.some((m) => m.role === 'tool' && /错误/.test(String(m.content))),
      JSON.stringify(a.messages.at(-1)),
    )
  }
}

// 工具 schema 每轮都要发，但不在 messages 里，必须单独算进来
{
  const a = makeAgent()
  const sysOnly = estimateTokens(a.messages[0].content)
  const specs = a.contextTokens() - sysOnly
  check(
    'contextTokens 计入工具 schema',
    specs > 1200 && specs < 1800,
    `schema 约 ${specs} token（应 ~1404）`,
  )
  check('空会话的上下文占用不是 0', a.contextTokens() > 2000, `实际 ${a.contextTokens()}`)
}

// 工具结果按 token 封顶，而不是按行数/字符数
{
  const long = 'x'.repeat(40000) // 约 10000 token
  const capped = capByTokens(long, 1000, '提示语')
  check('capByTokens 超限时截断', capped.truncated && capped.text.length < long.length)
  check('capByTokens 截断后落在预算内', estimateTokens(capped.text) <= 1000, `实际 ${estimateTokens(capped.text)}`)
  check('capByTokens 带上提示语', capped.text.includes('提示语'), capped.text.slice(0, 80))

  const cjk = '中'.repeat(6000) // 中文 1 字 1 token，比英文更容易顶爆
  check('capByTokens 对中文也按预算截断', estimateTokens(capByTokens(cjk, 800).text) <= 800)

  check('capByTokens 未超限时原样返回', capByTokens('hi', 1000).text === 'hi')
  check('capByTokens 未超限时标记未截断', capByTokens('hi', 1000).truncated === false)
}

// 小窗口模型自动收紧单次工具结果上限，避免一个结果就顶爆窗口
{
  const small = makeAgent({ contextWindow: 4000 })
  check('小窗口下工具结果上限收紧', estimateTokens(small.capResult('y'.repeat(100000))) <= 1000)
  const big = makeAgent({ contextWindow: 128000 })
  check('大窗口下工具结果上限为 8000', estimateTokens(big.capResult('y'.repeat(200000))) <= 8000)
  const custom = makeAgent({ contextWindow: 128000, maxToolResultTokens: 2000 })
  check('显式配置覆盖自动取值', estimateTokens(custom.capResult('y'.repeat(100000))) <= 2000)
}

// 压缩不能把 assistant(tool_calls) 和它的 tool 结果切开
{
  const a = makeAgent()
  const bigUser = 'u'.repeat(2500)
  a.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: bigUser },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'R1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'R2' },
  ]
  const cut = a.pickCut()
  check('pickCut 落在非 tool 消息上', cut !== null && a.messages[cut].role !== 'tool', `cut=${cut}`)

  const before = a.contextTokens()
  const ok = await a.compact(sig)
  const after = a.contextTokens()
  check('compact 头部够大时执行', ok === true)
  check('压缩后系统提示仍在首位', a.messages[0].role === 'system')
  check('压缩后尾部不以 tool 开头（没切开往返）', a.messages[3].role !== 'tool', a.messages.map((m) => m.role).join(','))
  check('压缩后插入了摘要消息', a.messages.some((m) => String(m.content).includes('<conversation_summary>')))
  // 消息条数不一定变少（摘要是「1 条换 2 条」），真正该降的是 token
  check('压缩后上下文 token 下降', after < before, `${before} -> ${after}`)
}

// 头部太小就别压：摘要请求本身比省下来的还贵
{
  const b = makeAgent()
  b.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '短' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '再来' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'ok' },
  ]
  check('头部过小时不压缩', (await b.compact(sig)) === false)
}

// 历史太短时 pickCut 应该给不出切点，而不是切出个空壳
{
  const c = makeAgent()
  c.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'R' },
  ]
  check('历史过短时 pickCut 返回 null', c.pickCut() === null, `cut=${c.pickCut()}`)
  check('历史过短时 compact 安全返回 false', (await c.compact(sig)) === false)
}

// 单轮内被一个大工具结果顶爆：压缩摘不掉末尾，但必须不崩
{
  const d = makeAgent({ contextWindow: 8000 })
  d.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '读这个大文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(60000) },
  ]
  const r = await d.compact(sig)
  check('单轮被顶爆时不崩溃', typeof r === 'boolean', String(r))
}

// ---------------------------------------------------------------- 配置与输入编码
console.log('\n== 配置优先级 ==')
{
  const { loadConfig } = await import(`${dist}config.js`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-cfg-home-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-cfg-proj-'))
  const prevHome = process.env.CLAUDA_HOME
  const prevModel = process.env.CLAUDA_MODEL
  process.env.CLAUDA_HOME = home
  process.env.CLAUDA_MODEL = 'from-env'

  const writeCfg = (dir, obj) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8')
  }

  try {
    writeCfg(home, { provider: { model: 'from-global' } })
    check('配置文件压过环境变量', loadConfig(proj).provider.model === 'from-global', loadConfig(proj).provider.model)

    writeCfg(path.join(proj, '.clauda'), { provider: { model: 'from-project' } })
    check('项目配置压过全局配置', loadConfig(proj).provider.model === 'from-project', loadConfig(proj).provider.model)
    check('命令行参数压过一切', loadConfig(proj, { model: 'from-cli' }).provider.model === 'from-cli')

    process.env.CLAUDA_TEST_KEY = 'sk-abc'
    writeCfg(path.join(proj, '.clauda'), { provider: { apiKey: '${CLAUDA_TEST_KEY}', model: 'm' } })
    check('配置文件支持 ${VAR} 插值', loadConfig(proj).provider.apiKey === 'sk-abc', loadConfig(proj).provider.apiKey)

    writeCfg(path.join(proj, '.clauda'), { provider: { apiKey: '$CLAUDA_NO_SUCH_VAR', model: 'm' } })
    check('取不到的环境变量原样保留', loadConfig(proj).provider.apiKey === '$CLAUDA_NO_SUCH_VAR', loadConfig(proj).provider.apiKey)

    writeCfg(path.join(proj, '.clauda'), {
      permissions: { mode: 'auto', allow: ['Bash(npm run:$*)'], deny: [] },
    })
    const rules = loadConfig(proj).permissions.allow
    check('含 $ 的权限规则不被改写', rules[0] === 'Bash(npm run:$*)', JSON.stringify(rules))

    // 写回「默认模型」。**这条是数据泄露的防线**：`loadConfig` 里的 `expandEnvRefs`
    // 会把 `${VAR}` 换成明文，拿它的结果回写等于把密钥落到磁盘上
    const { writeProjectModel, configPath } = await import(`${dist}config.js`)
    const file = configPath(proj)
    process.env.CLAUDA_WRITE_KEY = 'sk-super-secret'
    writeCfg(path.join(proj, '.clauda'), {
      provider: { apiKey: '${CLAUDA_WRITE_KEY}', model: 'old' },
      permissions: { mode: 'auto', allow: [], deny: [] },
    })
    const written = writeProjectModel(proj, 'new-model')
    const disk = fs.readFileSync(written, 'utf8')
    check('写回默认模型写在项目配置文件上', written === file, written)
    check('写回后模型真的变了', loadConfig(proj).provider.model === 'new-model', loadConfig(proj).provider.model)
    check('写回保留 ${VAR} 引用，没把密钥明文落盘', disk.includes('${CLAUDA_WRITE_KEY}'), disk)
    check('写回没把明文密钥写进磁盘', !disk.includes('sk-super-secret'), disk)
    check('写回不碰别的字段', JSON.parse(disk).permissions.mode === 'auto', disk)
    delete process.env.CLAUDA_WRITE_KEY

    // 手滑写坏一个逗号不能连累整份配置 —— 报错返回、原文件不动
    const broken = '{"provider": {"model": "x",}}'
    fs.writeFileSync(file, broken, 'utf8')
    let threw = ''
    try {
      writeProjectModel(proj, 'y')
    } catch (e) {
      threw = e.message
    }
    check('配置不是合法 JSON 时报错而不是覆盖', threw.length > 0, threw)
    check('报错时原文件一字未动', fs.readFileSync(file, 'utf8') === broken)
  } finally {
    delete process.env.CLAUDA_TEST_KEY
    if (prevModel === undefined) delete process.env.CLAUDA_MODEL
    else process.env.CLAUDA_MODEL = prevModel
    if (prevHome === undefined) delete process.env.CLAUDA_HOME
    else process.env.CLAUDA_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 厂商预置
console.log('\n== 厂商预置表 ==')
{
  const { VENDORS, findVendor, vendorByBaseUrl } = await import(`${dist}provider/vendors.js`)

  check('预置表不是空的', VENDORS.length >= 8, String(VENDORS.length))
  check('厂商 key 唯一', new Set(VENDORS.map((v) => v.key)).size === VENDORS.length)
  check(
    '每个厂商都有 http(s) 地址（无尾斜杠）和至少一个候选模型',
    VENDORS.every((v) => /^https?:\/\//.test(v.baseUrl) && !v.baseUrl.endsWith('/') && v.models.length > 0),
    JSON.stringify(VENDORS.map((v) => v.baseUrl)),
  )
  check(
    '环境变量名要么留空要么是合法变量名',
    VENDORS.every((v) => v.envKey === '' || /^[A-Z_][A-Z0-9_]*$/.test(v.envKey)),
    JSON.stringify(VENDORS.map((v) => v.envKey)),
  )
  // 厂商是由 baseUrl 推导的（不存字段），所以每个预置必须能反查回自己，否则界面会显示「自定义」
  check('每个预置都能按地址反查回自己', VENDORS.every((v) => vendorByBaseUrl(v.baseUrl)?.key === v.key))
  check('尾斜杠不影响反查', vendorByBaseUrl('https://api.deepseek.com/v1/')?.key === 'deepseek')
  check('反查不到就是没匹配上', vendorByBaseUrl('http://127.0.0.1:9/v1') === undefined)
  check(
    'findVendor 认得预置、认不得野名字',
    findVendor('deepseek')?.key === 'deepseek' && findVendor('nope') === undefined,
  )
  check(
    'OpenAI 那条的首个候选与内置默认模型一致',
    findVendor('openai')?.models[0] === 'gpt-4o-mini',
    findVendor('openai')?.models[0],
  )
}

console.log('\n== baseUrl 归一化 ==')
{
  const { normalizeBaseUrl } = await import(`${dist}config.js`)
  const cases = [
    // 只补「没有 path」这一种 —— 救掉最常见的手填错误
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['http://localhost:11434/', 'http://localhost:11434/v1'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1'],
    // 这两条是回归护栏：错误地「补全」会把方舟的 /api/v3 拼成 /v3/v1，是真实事故
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'],
    ['不是个地址', '不是个地址'],
  ]
  for (const [input, want] of cases) {
    check(`归一化 ${input}`, normalizeBaseUrl(input) === want, normalizeBaseUrl(input))
  }
}

console.log('\n== 写回接口地址 / 模型，以及厂商环境变量回退 ==')
{
  const { loadConfig, writeProjectProvider, writeProjectModel, configPath, writeConfigTemplate } = await import(
    `${dist}config.js`
  )
  const { findVendor } = await import(`${dist}provider/vendors.js`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-vendor-home-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-vendor-proj-'))

  // 开发机上很可能真挂着这几个（尤其 OPENAI_API_KEY），不摘掉下面的回退用例就是白验
  const saved = {}
  for (const name of ['CLAUDA_HOME', 'CLAUDA_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  process.env.CLAUDA_HOME = home

  const writeCfg = (dir, obj) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8')
  }

  try {
    // 解析时归一，但**绝不写回**用户文件里的原文
    const file = configPath(proj)
    writeCfg(path.join(proj, '.clauda'), { provider: { baseUrl: 'http://127.0.0.1:9', model: 'm' } })
    check('解析时补上 /v1', loadConfig(proj).provider.baseUrl === 'http://127.0.0.1:9/v1', loadConfig(proj).provider.baseUrl)
    check('归一化没写回文件', fs.readFileSync(file, 'utf8').includes('http://127.0.0.1:9"'))

    // 写回：一次改地址 + 模型，且**保留 ${VAR}` 引用**（拿 loadConfig 的结果回写就是泄露密钥）
    process.env.CLAUDA_VENDOR_KEY = 'sk-super-secret'
    writeCfg(path.join(proj, '.clauda'), {
      provider: { baseUrl: 'http://old/v1', apiKey: '${CLAUDA_VENDOR_KEY}', model: 'old', temperature: 7 },
      permissions: { mode: 'auto', allow: [], deny: [] },
      mcpServers: { demo: { command: 'npx' } },
    })
    const ds = findVendor('deepseek')
    const written = writeProjectProvider(proj, { baseUrl: ds.baseUrl, model: ds.models[0] })
    const disk = fs.readFileSync(written, 'utf8')
    check('写回落在项目配置文件上', written === file, written)
    check('地址与模型同时写进去了', loadConfig(proj).provider.baseUrl === ds.baseUrl && loadConfig(proj).provider.model === ds.models[0])
    check('写回保留 ${VAR} 引用，没把密钥明文落盘', disk.includes('${CLAUDA_VENDOR_KEY}'), disk)
    check('写回没把明文密钥写进磁盘', !disk.includes('sk-super-secret'), disk)
    check('写回不碰 provider 里别的键', JSON.parse(disk).provider.temperature === 7, disk)
    check('写回不碰别的段落', JSON.parse(disk).permissions.mode === 'auto', disk)
    check('写回不碰 mcpServers', !!JSON.parse(disk).mcpServers?.demo, disk)
    delete process.env.CLAUDA_VENDOR_KEY

    // 没给的键一个都不能碰 —— `{ model: undefined }` 展开进去会把磁盘上原有的抹掉
    const before = fs.readFileSync(file, 'utf8')
    writeProjectProvider(proj, { baseUrl: 'https://api.deepseek.com/v1' })
    check('只给地址时不碰模型', JSON.parse(fs.readFileSync(file, 'utf8')).provider.model === ds.models[0], before)

    // writeProjectModel 仍是薄封装，性质一条不少
    const onlyModel = fs.readFileSync(writeProjectModel(proj, 'some-model'), 'utf8')
    check('writeProjectModel 仍只改模型', JSON.parse(onlyModel).provider.model === 'some-model' && JSON.parse(onlyModel).provider.baseUrl === ds.baseUrl, onlyModel)

    // 手滑写坏一个逗号不能连累整份配置
    const broken = '{"provider": {"model": "x",}}'
    fs.writeFileSync(file, broken, 'utf8')
    let threw = ''
    try {
      writeProjectProvider(proj, { baseUrl: 'http://x/v1' })
    } catch (e) {
      threw = e.message
    }
    check('配置不是合法 JSON 时报错而不是覆盖', threw.length > 0, threw)
    check('报错时原文件一字未动', fs.readFileSync(file, 'utf8') === broken)

    // 厂商专属环境变量回退：界面说「该厂商读 DEEPSEEK_API_KEY」，这里就得真读
    writeCfg(path.join(proj, '.clauda'), { provider: { baseUrl: ds.baseUrl, model: ds.models[0] } })
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek'
    check('没有通用 key 时回退到厂商专属变量', loadConfig(proj).provider.apiKey === 'sk-deepseek', loadConfig(proj).provider.apiKey)

    writeCfg(path.join(proj, '.clauda'), { provider: { baseUrl: 'http://localhost:11434/v1', model: 'x' } })
    check('本地部署不认厂商变量（该条 envKey 为空）', loadConfig(proj).provider.apiKey === '', loadConfig(proj).provider.apiKey)

    writeCfg(path.join(proj, '.clauda'), {
      provider: { baseUrl: ds.baseUrl, apiKey: '${CLAUDA_VENDOR_KEY2}', model: 'x' },
    })
    process.env.CLAUDA_VENDOR_KEY2 = 'sk-from-file'
    check(
      '配置文件里写了 key 就不被环境变量回退顶掉',
      loadConfig(proj).provider.apiKey === 'sk-from-file',
      loadConfig(proj).provider.apiKey,
    )
    delete process.env.CLAUDA_VENDOR_KEY2
    delete process.env.DEEPSEEK_API_KEY

    // 生成模板的那份地址与模型必须来自预置表，否则两边会脱节
    const tpl = writeConfigTemplate(proj)
    const tplText = fs.readFileSync(tpl, 'utf8')
    check(
      '配置模板的地址与模型来自预置表',
      JSON.parse(tplText).provider.baseUrl === ds.baseUrl && JSON.parse(tplText).provider.model === ds.models[0],
      tplText,
    )
    // 模板里的密钥是占位串，不参与这条断言 —— 要验的是「模板能读出预置地址」，
    // 拿真 key 去比会把「模板过期」和「env 回退失效」两件事混在一起
    check('配置模板写在了这个项目的配置路径上', tpl === configPath(proj), tpl)
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
}

console.log('\n== 管道输入的编码兜底 ==')
{
  const { decodeInput } = await import(`${dist}ui/input-decoder.js`)
  const runInput = async (chunks) => {
    const t = decodeInput()
    const out = []
    t.on('data', (d) => out.push(d))
    const done = new Promise((r) => t.on('end', r))
    for (const c of chunks) t.write(c)
    t.end()
    await done
    return Buffer.concat(out).toString('utf8')
  }

  const utf8Line = Buffer.from('中文测试\n', 'utf8')
  check('合法 UTF-8 原样通过', (await runInput([utf8Line])) === '中文测试\n')

  // d6d0 cec4 = GBK 的「中文」。中文 Windows（代码页 936）的管道默认就是这个编码，
  // Node 按 UTF-8 硬解会得到一片 U+FFFD
  const gbkLine = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a])
  const gbkOut = await runInput([gbkLine])
  check('GBK 字节被识别并转成 UTF-8', gbkOut === '中文测试\n', JSON.stringify(gbkOut))

  const ahead = await runInput([Buffer.from('hello\n'), gbkLine])
  check('开头的 ASCII 行不会把编码锁死', ahead === 'hello\n中文测试\n', JSON.stringify(ahead))

  const split = await runInput([gbkLine.subarray(0, 3), gbkLine.subarray(3)])
  check('跨 chunk 切断的多字节字符能拼回来', split === '中文测试\n', JSON.stringify(split))

  const noNl = await runInput([Buffer.from([0xd6, 0xd0, 0xce, 0xc4])])
  check('结尾没有换行的残缺行也会转换', noNl === '中文', JSON.stringify(noNl))
}

fs.rmSync(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------- 技能
// 技能是「说明书按需载入」：系统提示词里只放名字和用途，正文等模型调 skill 工具再给。
console.log('\n== 技能 ==')
const { parseFrontmatter } = await import(`${dist}skills/frontmatter.js`)
const { SkillRegistry } = await import(`${dist}skills/registry.js`)
const { buildSystemPrompt } = await import(`${dist}agent/system-prompt.js`)
const { makeSkillTool } = await import(`${dist}tools/skill.js`)

// frontmatter 写得花哨可以，但不能因此让技能消失 —— 一律降级，绝不抛异常
{
  const fm = parseFrontmatter(
    '---\r\nname: demo\r\ndescription: "带引号 : 的值"\r\n---\r\n\r\n正文第一行\r\n',
  )
  check('CRLF 的 frontmatter 能解析', fm.data.name === 'demo', JSON.stringify(fm.data))
  check('值两侧的引号被剥掉，值里的冒号保留', fm.data.description === '带引号 : 的值', JSON.stringify(fm.data))
  check('body 不含 frontmatter', fm.body === '正文第一行', JSON.stringify(fm.body))

  const noFence = parseFrontmatter('# 标题\n\n正文')
  check(
    '没有 frontmatter 时整篇当正文',
    noFence.body === '# 标题\n\n正文' && Object.keys(noFence.data).length === 0,
    JSON.stringify(noFence),
  )

  const unclosed = parseFrontmatter('---\nname: x\n\n正文')
  check(
    '围栏没闭合时不吞正文',
    unclosed.data.name === undefined && unclosed.body.includes('正文'),
    JSON.stringify(unclosed),
  )

  const bom = parseFrontmatter('\uFEFF---\nname: bom\n---\n正文')
  check('带 BOM 的文件也能认出 frontmatter', bom.data.name === 'bom', JSON.stringify(bom.data))
}

// 发现顺序：全局 < 中间层 < 项目，离 cwd 越近越优先
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-skills-'))
  const proj = path.join(home, 'work', 'proj')
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = path.join(home, 'clauda')

  const writeSkill = (root, dirName, content) => {
    const d = path.join(root, dirName)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), content, 'utf8')
  }

  writeSkill(path.join(home, 'clauda', 'skills'), 'shared', '---\nname: shared\ndescription: 全局版本\n---\n全局正文')
  writeSkill(path.join(home, 'work', '.clauda', 'skills'), 'shared', '---\nname: shared\ndescription: 中间层版本\n---\n中间层正文')
  writeSkill(path.join(proj, '.clauda', 'skills'), 'shared', '---\nname: shared\ndescription: 项目版本\n---\n项目正文')
  writeSkill(path.join(home, 'clauda', 'skills'), 'only-global', '---\nname: only-global\ndescription: 只在全局\n---\n全局独有正文')
  writeSkill(path.join(proj, '.clauda', 'skills'), 'fallback-dir', '---\ndescription: 没写 name\n---\n兜底正文')
  writeSkill(path.join(proj, '.clauda', 'skills'), 'bad-name', '---\nname: 中文 名字\ndescription: 名字不合规\n---\n不合规正文')
  fs.mkdirSync(proj, { recursive: true })

  const reg = SkillRegistry.discover(proj)
  const names = reg.list().map((s) => s.name)

  check('离 cwd 最近的项目技能压过中间层和全局', reg.get('shared')?.description === '项目版本', reg.get('shared')?.description)
  check('全局独有技能仍可见', reg.get('only-global')?.description === '只在全局')
  check('没写 name 时退回目录名', reg.has('fallback-dir'), JSON.stringify(names))
  check(
    '名字不合规时退回目录名而不是丢掉整个技能',
    reg.has('bad-name') && !reg.has('中文 名字'),
    JSON.stringify(names),
  )
  check('read() 返回剥掉 frontmatter 的正文', reg.read('shared') === '项目正文', JSON.stringify(reg.read('shared')))
  check('读不存在的技能返回 null', reg.read('nope') === null)

  // 顺序即语义：/memory 靠切「项目记忆」和「会话配置」之间取值，新段落必须待在它们之前
  const prompt = buildSystemPrompt({ cwd: proj, config: agentConfig(), mode: 'default', skills: reg })
  const iSkill = prompt.indexOf('## 可用技能')
  const iMem = prompt.indexOf('## 项目记忆')
  const iCfg = prompt.indexOf('## 会话配置')
  check(
    '技能段排在项目记忆之前，「项目记忆」仍紧邻「会话配置」',
    iSkill >= 0 && iSkill < iMem && iMem < iCfg,
    `技能=${iSkill} 记忆=${iMem} 配置=${iCfg}`,
  )
  check('技能只露名字和用途，不塞正文', prompt.includes('shared：项目版本') && !prompt.includes('项目正文'), prompt.slice(iSkill, iSkill + 300))

  const tool = makeSkillTool(reg)
  const got = await tool.run({ name: 'only-global' }, ctx())
  check('skill 工具返回技能正文', got.includes('全局独有正文'), got.slice(0, 120))
  const bad = await catchErr(() => tool.run({ name: 'nope' }, ctx()))
  check(
    'skill 工具对未知技能列出可用技能',
    /不存在名为/.test(bad.error ?? '') && bad.error.includes('shared'),
    bad.error,
  )

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- MCP
// 后端的函数名有硬约束，而 MCP 工具名是第三方服务器起的，所以「消毒 + 能还原回去」
// 这两件事必须成对成立 —— 少一个就会出现「清单里看得见、调用时报工具不存在」。
console.log('\n== MCP 工具命名 ==')
{
  const { mcpToolName, assignMcpToolNames, buildMcpToolNames, MCP_TOOL_NAME_RE } =
    await import(`${dist}mcp/naming.js`)

  check(
    '非法字符被消毒成下划线',
    mcpToolName('my server', 'item.get') === 'mcp__my_server__item_get',
    mcpToolName('my server', 'item.get'),
  )
  check('中文服务器名也能出合法函数名', MCP_TOOL_NAME_RE.test(mcpToolName('本地', '查')))

  const long = mcpToolName('s', 'x'.repeat(80))
  check('超长名字截断到 64 且仍合法', long.length <= 64 && MCP_TOOL_NAME_RE.test(long), `${long} (${long.length})`)
  // 直接 slice 截断会让这两个撞成同一个，加哈希就是为了防这个
  const a = mcpToolName('s', 'x'.repeat(70) + 'A')
  const b = mcpToolName('s', 'x'.repeat(70) + 'B')
  check('只在尾部不同的长名字不会撞车', a !== b, `${a} vs ${b}`)

  // 'b.c' 和 'b_c' 消毒后一模一样
  const entries = [
    { server: 'a', tool: 'b.c' },
    { server: 'a', tool: 'b_c' },
  ]
  const assigned = assignMcpToolNames(entries)
  check('消毒后撞名时追加 _2', assigned[1].name === 'mcp__a__b_c_2', JSON.stringify(assigned))

  const rev = buildMcpToolNames(entries)
  check(
    '反查能还原真实工具名（消毒不可逆，必须靠这张表）',
    rev.get('mcp__a__b_c_2')?.tool === 'b_c' && rev.get('mcp__a__b_c')?.tool === 'b.c',
    JSON.stringify([...rev]),
  )
}

console.log('\n== MCP 工具结果拍平 ==')
{
  const { makeMcpTool, flatten } = await import(`${dist}mcp/tool.js`)

  check('text 块直接取文本', flatten({ content: [{ type: 'text', text: '结果' }] }) === '结果')
  check(
    '图片只留占位符（base64 内联进对话纯属烧 token）',
    flatten({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }).includes('已省略'),
  )
  check(
    'resource 带 text 时取正文',
    flatten({ content: [{ type: 'resource', resource: { uri: 'x://a', text: '正文' } }] }) === '正文',
  )
  check(
    'resource 只有 blob 时退回 uri',
    flatten({ content: [{ type: 'resource', resource: { uri: 'x://a', blob: 'AA' } }] }).includes('x://a'),
  )

  const mk = (over = {}) =>
    makeMcpTool({
      name: 'mcp__s__t',
      remoteName: 't',
      server: 's',
      inputSchema: { type: 'object', properties: {} },
      permission: 'exec',
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ...over,
    })

  // isError 是「跑了但失败」，要变成模型看得见的文本而不是异常 —— 抛异常的话模型
  // 分不清是服务器报的还是 clauda 自己拦的
  const errTool = mk({ call: async () => ({ isError: true, content: [{ type: 'text', text: '炸了' }] }) })
  const errOut = await errTool.run({}, ctx())
  check('isError 返回错误文本而不是抛异常', errOut === '错误：炸了', errOut)

  const okTool = mk({})
  check('正常结果原样返回', (await okTool.run({}, ctx())) === 'ok')

  check('还原真实工具名而不是消毒后的名字', okTool.source.tool === 't' && okTool.source.server === 's')

  // v2 SDK 会强校验 inputSchema.type，正常走不到这条分支；直接调才验得到兜底
  const noType = mk({ inputSchema: { properties: {} } })
  check('inputSchema 缺 type 时补成 object', noType.parameters.type === 'object', JSON.stringify(noType.parameters))
}

console.log('\n== MCP 权限规则 ==')
{
  const { makeMcpTool } = await import(`${dist}mcp/tool.js`)
  const mcpTool = (name) =>
    makeMcpTool({
      name,
      remoteName: name,
      server: name.split('__')[1] ?? 's',
      inputSchema: { type: 'object', properties: {} },
      permission: 'exec',
      call: async () => ({ content: [] }),
    })
  const linear = mcpTool('mcp__linear__create_issue')
  const otherServer = mcpTool('mcp__linearx__create_issue')

  // 老正则的工具名字符类是 [A-Za-z_]+，含数字/短横线的 MCP 名字整条规则会被判为非法，
  // 于是 deny 静默失效 —— 这是最危险的一类 bug
  const pExact = new PermissionManager({ mode: 'auto', allow: [], deny: ['mcp__linear__create_issue'] }, async () => true)
  check('名字里带下划线的规则能解析并拦住', !(await pExact.check(linear, {})).ok)

  const pServer = new PermissionManager({ mode: 'auto', allow: [], deny: ['mcp__linear'] }, async () => true)
  check('mcp__<server> 管住整个服务器', !(await pServer.check(linear, {})).ok)
  check('mcp__linear 不会误伤 mcp__linearx（双下划线护栏）', (await pServer.check(otherServer, {})).ok)

  const pAll = new PermissionManager({ mode: 'auto', allow: [], deny: ['mcp'] }, async () => true)
  check('mcp 管住所有 MCP 工具', !(await pAll.check(otherServer, {})).ok)

  // 无参数规则才放宽前缀匹配，带参数的不动
  const pBash = new PermissionManager({ mode: 'auto', allow: [], deny: ['bash'] }, async () => true)
  check('bash 规则不会去匹配 bashx', (await pBash.check(mcpTool('bashx'), {})).ok)

  const pParam = new PermissionManager({ mode: 'auto', allow: [], deny: ['mcp__linear__create_issue(path:*)'] }, async () => true)
  check('MCP 不支持参数级规则（刻意如此，猜参数没有可靠办法）', (await pParam.check(linear, { path: 'x' })).ok)
}

console.log('\n== Agent.setTools 重算 token 核算 ==')
{
  const { makeMcpTool } = await import(`${dist}mcp/tool.js`)
  const { ALL_TOOLS, toolSpecs } = await import(`${dist}tools/index.js`)

  const extra = makeMcpTool({
    name: 'mcp__s__t',
    remoteName: 't',
    server: 's',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    permission: 'exec',
    call: async () => ({ content: [] }),
  })

  const a = makeAgent()
  const before = a.contextTokens()
  a.setTools([...ALL_TOOLS, extra])
  const delta = a.contextTokens() - before
  const expected = estimateTokens(JSON.stringify(toolSpecs([extra])))
  // 漏算的话 MCP 的 schema 不进上下文核算，压缩触发点会系统性偏晚
  check('setTools 重算 specsTokens，增量正好是新工具 schema', delta === expected, `增量 ${delta} 预期 ${expected}`)
  check('setTools 换了工具集', a.listTools().length === ALL_TOOLS.length + 1)

  a.setTools(ALL_TOOLS)
  check('setTools 摘掉后能还原', a.contextTokens() === before, `${a.contextTokens()} vs ${before}`)

  // 红线：ALL_TOOLS 恒为 7 个内置工具，新工具必须走 setTools/构造参数注入
  check('ALL_TOOLS 仍是 7 个内置工具', ALL_TOOLS.length === 7, `实际 ${ALL_TOOLS.length}`)
}

// ---------------------------------------------------------------- 记忆库
console.log('\n== 记忆库 ==')
{
  const { listMemories, readMemory, writeMemory, memoryDir, MAX_BODY_BYTES } = await import(
    `${dist}agent/memory-store.js`
  )
  const { makeMemoryTools } = await import(`${dist}tools/memory.js`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-memory-'))
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = path.join(home, 'clauda')

  // 还没写过任何记忆是最常见的情况（第一次装完就是），不能抛异常
  check('目录不存在时是空索引而不是报错', listMemories().entries.length === 0 && listMemories().total === 0)
  check('读不存在的记忆返回 null 而不是抛异常', readMemory('nope') === null)

  const first = writeMemory({
    name: 'Git Commit In Chinese',
    description: '提交信息一律用中文',
    type: 'feedback',
    body: '这个仓库的 commit message 用中文写。',
  })
  check('名字被 slug 化成文件名', first.name === 'git-commit-in-chinese', JSON.stringify(first))
  check('首次写入报告为新建', first.created === true)

  const idx = listMemories()
  check('索引靠扫目录得出', idx.entries.length === 1 && idx.entries[0].name === 'git-commit-in-chinese', JSON.stringify(idx))
  check('type 按 frontmatter 存下来', idx.entries[0].type === 'feedback', idx.entries[0].type)
  check('description 进索引', idx.entries[0].description === '提交信息一律用中文')
  // 索引是常驻注入的，正文绝不能混进去 —— 那等于把整库都塞进每轮请求
  check('索引里不含正文', !JSON.stringify(idx).includes('commit message 用中文写'), JSON.stringify(idx))

  check('memory_read 取到正文且剥掉 frontmatter', readMemory('git-commit-in-chinese')?.body === '这个仓库的 commit message 用中文写。')

  const again = writeMemory({
    name: 'git-commit-in-chinese',
    description: '提交信息一律用中文',
    type: 'feedback',
    body: '改过的正文。',
  })
  check('同名写入报告为更新而不是新建', again.created === false, JSON.stringify(again))
  check('同名覆盖后仍然只有一条', listMemories().entries.length === 1)
  check('覆盖后读到的是新正文', readMemory('git-commit-in-chinese')?.body === '改过的正文。')

  writeMemory({ name: 'weird-type', description: '类型乱写', type: '乱七八糟', body: 'x' })
  check(
    '非法 type 退回默认 project 而不是原样存进去',
    listMemories().entries.find((m) => m.name === 'weird-type')?.type === 'project',
  )

  const badName = await catchErr(() => writeMemory({ name: '!!!', description: 'x', body: 'x' }))
  check('名字没法 slug 化时明确报错', /slug/.test(badName.error ?? ''), badName.error)

  const tooBig = await catchErr(() =>
    writeMemory({ name: 'too-big', description: 'x', body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
  )
  check('正文超上限被拒绝且给出可行建议', /超过/.test(tooBig.error ?? '') && /拆/.test(tooBig.error ?? ''), tooBig.error)

  // 手写的记忆（不经过 writeMemory）也得能读：description 缺失时退回正文首行
  fs.writeFileSync(
    path.join(memoryDir(), 'hand-written.md'),
    '---\nname: hand-written\n---\n\n没有 description，首行应当顶上来。\n第二行。\n',
    'utf8',
  )
  check(
    '缺 description 时拿正文第一个有意义行兜底',
    listMemories().entries.find((m) => m.name === 'hand-written')?.description === '没有 description，首行应当顶上来。',
    JSON.stringify(listMemories().entries.find((m) => m.name === 'hand-written')),
  )

  // 超长正文截断必须落在字符边界上。这条直接盯着一个真实写错的版本：
  // 「丢尾部续字节」的写法会把完整字符也一起吃掉，只剩开头几个 ASCII。
  const cjk = '中'.repeat(3000) // 9000 字节，远超上限
  fs.writeFileSync(path.join(memoryDir(), 'huge.md'), `---\nname: huge\ndescription: 超大\n---\n\n${cjk}\n`, 'utf8')
  const got = readMemory('huge').body
  check(
    '超长正文截断后不留替换字符',
    !got.includes('�') && got.includes('已截断'),
    JSON.stringify(got.slice(-30)),
  )
  check(
    '截断确实保留了绝大部分内容（不是被啃到只剩开头）',
    got.replace('\n…（已截断）', '').length > 1000,
    `实际保留 ${got.replace('\n…（已截断）', '').length} 字`,
  )

  const [readTool, writeTool] = makeMemoryTools()
  check('memory_read 是只读权限', readTool.permission === 'read', readTool.permission)
  check('memory_write 是写权限（跨会话的持久状态值得一次授权）', writeTool.permission === 'write', writeTool.permission)
  // 写完要当轮可见，所以必须声明会改写提示词；漏了的话模型刚记下的事自己都看不见
  check('memory_write 声明会改写系统提示词', writeTool.invalidatesPrompt === true)
  check('两个工具都标了记忆来源', readTool.source?.kind === 'memory' && writeTool.source?.kind === 'memory')

  const toolOut = await writeTool.run(
    { name: 'tool-written', description: '通过工具写的', type: 'project', body: '正文' },
    ctx(),
  )
  check('新建走「已记住」措辞', toolOut.startsWith('已记住'), toolOut)
  const toolUpd = await writeTool.run({ name: 'tool-written', description: '通过工具写的', body: '新正文' }, ctx())
  check('覆盖走「已更新既有记忆」措辞', toolUpd.includes('已更新既有记忆'), toolUpd)

  const unknown = await catchErr(() => readTool.run({ name: 'nope' }, ctx()))
  check(
    'memory_read 找不到时列出可用的',
    /不存在名为/.test(unknown.error ?? '') && unknown.error.includes('git-commit-in-chinese'),
    unknown.error,
  )

  // 段落顺序：索引段必须在「项目记忆」之前，否则会把 /memory 的切片弄坏
  const prompt = buildSystemPrompt({
    cwd: home,
    config: agentConfig(),
    mode: 'default',
    memoryIndex: listMemories(),
  })
  const iIdx = prompt.indexOf('## 记忆索引')
  const iMem = prompt.indexOf('## 项目记忆')
  const iCfg = prompt.indexOf('## 会话配置')
  check(
    '记忆索引排在项目记忆之前，「项目记忆」仍紧邻「会话配置」',
    iIdx > 0 && iIdx < iMem && iMem < iCfg,
    `索引=${iIdx} 项目记忆=${iMem} 配置=${iCfg}`,
  )
  check('索引只露名字和用途，不塞正文', prompt.includes('git-commit-in-chinese（feedback）') && !prompt.includes('改过的正文'), prompt.slice(iIdx, iIdx + 300))
  // 空库不占位：省下每轮都要付的 token，可写性由工具描述负责
  const emptyPrompt = buildSystemPrompt({ cwd: home, config: agentConfig(), mode: 'default', memoryIndex: { entries: [], total: 0 } })
  check('没有记忆时不输出索引段', !emptyPrompt.includes('## 记忆索引'), emptyPrompt.slice(0, 200))

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 会话文件
// 会话列表是按目录扫出来的，任何一个手改坏、或旧版本写下的文件都可能缺字段。
// 之前 sort 写在 try/catch 外面，一条缺 updatedAt 的记录就能把 /sessions 打挂。
console.log('\n== 会话文件 ==')
{
  const { saveSession, loadSession, listSessions, latestSessionId, deriveTitle, newSessionId } =
    await import(`${dist}agent/session.js`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-session-'))
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = home

  const rec = (n, updatedAt = `2026-01-0${n}T00:00:00.000Z`) => ({
    id: `s${n}`,
    cwd,
    model: 'm',
    createdAt: `2026-01-0${n}T00:00:00.000Z`,
    updatedAt,
    title: `会话${n}`,
    messages: [],
    todos: [],
    totalUsage: { input: 0, output: 0 },
    cost: 0,
  })

  saveSession(cwd, rec(1))
  saveSession(cwd, rec(3))
  const saved = listSessions(cwd)
  check('listSessions 按 updatedAt 倒序', saved.map((r) => r.id).join(',') === 's3,s1', saved.map((r) => r.id).join(','))
  check('latestSessionId 取最新一条', latestSessionId(cwd) === 's3', latestSessionId(cwd))
  check('loadSession 读得回原记录', loadSession(cwd, 's1')?.title === '会话1')

  // 坏文件混进来：合法 JSON 但缺 updatedAt / updatedAt 不是字符串
  const dir = path.join(home, 'projects', fs.readdirSync(path.join(home, 'projects'))[0])
  fs.writeFileSync(path.join(dir, 'bad-no-date.json'), JSON.stringify({ id: 'bad-no-date', title: '没有日期' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'bad-date-type.json'), JSON.stringify({ id: 'bad-date-type', updatedAt: 42 }), 'utf8')
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ 这不是 JSON', 'utf8')

  let crashed = null
  try {
    listSessions(cwd)
  } catch (e) {
    crashed = e
  }
  check('坏会话文件不会让 listSessions 抛出', crashed === null, crashed?.message ?? '')
  check('坏会话文件被跳过，好记录照常返回', listSessions(cwd).length === 2, `实际 ${listSessions(cwd).length}`)
  check('坏会话文件不会让 latestSessionId 打挂', latestSessionId(cwd) === 's3', latestSessionId(cwd))

  check('deriveTitle 取第一条用户消息', deriveTitle([{ role: 'user', content: '修个 bug\n详细说明' }]) === '修个 bug')
  check('deriveTitle 空会话给占位', deriveTitle([]) === '(空会话)')

  // 会话 id 直接拼进文件路径。它不是只有内部 generate 一个来源：桌面端 IPC 的
  // `session/resume` 载荷、CLI 的 `--resume <id>`、以及**会话文件里的 id 字段**
  // （恢复后会被接管）都能喂进来。而且它一路流到 `saveSession` 的写路径 ——
  // `persist.ts` 用同一个 id 续写，所以穿越出去的不是「读错文件」，是「写到别处」。
  {
    const { isSafeSessionId, saveSession: save, loadSession: load } = await import(`${dist}agent/session.js`)
    const outside = path.join(home, '被穿越出来的.json')

    for (const bad of [
      '../被穿越出来的',
      '..\\被穿越出来的',
      '../../../../tmp/evil',
      '/abs/evil',
      'C:/abs/evil',
      '',
      '.hidden',
      '-leading-dash',
      `a${'/'.repeat(3)}b`,
    ]) {
      check(`拒绝非法会话 id：${JSON.stringify(bad)}`, !isSafeSessionId(bad), bad)
    }
    check('newSessionId 造出来的 id 一定过闸', isSafeSessionId(newSessionId()), newSessionId())
    check('旧数据里的下划线 id 仍然认', isSafeSessionId('s_1-a2'), 's_1-a2')

    check('loadSession 拒绝穿越', load(cwd, '../../被穿越出来的') === null)
    let threw = null
    try {
      save(cwd, { ...rec(9), id: '../../被穿越出来的' })
    } catch (e) {
      threw = e
    }
    check('saveSession 拒绝穿越（抛而不是静默跳过）', threw !== null, threw?.message ?? '没抛')
    check('被穿越的路径上确实没写出文件', !fs.existsSync(outside), outside)

    // 形状不对的 `.json` 不能当成会话喂回去：恢复会话的人直接读 `messages`，
    // 少一个字段就是运行期崩溃（`persistSession` 会读 `.length`）
    fs.writeFileSync(path.join(dir, 'shapeless.json'), JSON.stringify({ hello: 'world' }), 'utf8')
    check('loadSession 不把形状不对的 JSON 当会话', load(cwd, 'shapeless') === null)
  }

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 工具装配配方
// CLI（index.ts）和桌面端必须共用同一份装配逻辑，否则两边迟早会漂。这个模块只是把
// index.ts 里那几行搬出来，所以测试要钉住的不是「做了什么」，而是它**照搬的三条隐含语义**：
// 技能工具有条件注入、记忆工具无条件注入、assemble() 每次现算 MCP 工具。
console.log('\n== 工具装配配方 ==')
{
  const { createToolAssembly } = await import(`${dist}runtime/tools-assembly.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)

  // 假 mcp 只要能 tools() 就够了 —— 真 McpManager 要起子进程，而装配逻辑不该依赖它
  const fakeMcp = (tools) => ({ tools: () => tools })
  const mcpToolNamed = (name) => ({
    name,
    description: name,
    permission: 'exec',
    parameters: { type: 'object', properties: {} },
    summary: () => name,
    run: async () => '',
  })

  const noSkills = { list: () => [] }
  const withSkills = { list: () => [{ name: 'demo', description: '演示技能' }] }

  const plain = createToolAssembly(noSkills, fakeMcp([]))
  check('零技能时 baseTools 就是 ALL_TOOLS 本身（引用相等，不是副本）', plain.baseTools === ALL_TOOLS)
  check('零技能时工具数 = 7 内置 + 2 记忆', plain.assemble().length === 9, `实际 ${plain.assemble().length}`)
  check(
    'assemble() 含 memory_write（记忆工具无条件注入）',
    plain.assemble().some((t) => t.name === 'memory_write'),
    plain.assemble().map((t) => t.name).join(','),
  )

  const skilled = createToolAssembly(withSkills, fakeMcp([]))
  check('有技能时 baseTools 多出 skill 工具', skilled.baseTools.length === 8, `实际 ${skilled.baseTools.length}`)
  check('有技能时挂的是 skill 工具', skilled.baseTools[7]?.name === 'skill', skilled.baseTools[7]?.name)
  check('有技能时 baseTools 不再是 ALL_TOOLS 本身', skilled.baseTools !== ALL_TOOLS)
  check(
    '有技能也不会污染 ALL_TOOLS（恒为 7 个内置）',
    ALL_TOOLS.length === 7 && !ALL_TOOLS.some((t) => t.name === 'skill'),
    `实际 ${ALL_TOOLS.length}`,
  )

  const mcpTool = mcpToolNamed('mcp__demo__ping')
  const wired = createToolAssembly(noSkills, fakeMcp([mcpTool]))
  const names = wired.assemble().map((t) => t.name)
  check(
    'assemble() 顺序为 baseTools → memoryTools → mcp.tools()',
    names[names.length - 1] === 'mcp__demo__ping' && names.indexOf('memory_read') < names.indexOf('mcp__demo__ping'),
    names.join(','),
  )
  check('MCP 工具不进 baseTools', !wired.baseTools.some((t) => t.name.startsWith('mcp__')))

  // assemble() 必须每次现算：`/mcp off` 之后靠它把新工具集算出来，快照的话就永远停在初始状态
  let live = []
  const growing = createToolAssembly(noSkills, { tools: () => live })
  check('assemble() 起初没有 MCP 工具', growing.assemble().length === 9, `实际 ${growing.assemble().length}`)
  live = [mcpTool]
  check('assemble() 每次现算，MCP 工具增减能跟上', growing.assemble().length === 10, `实际 ${growing.assemble().length}`)
}

// ------------------------------------------------------------------ MCP token 提示
// 这段文案要同时给终端和桌面端用，所以抽出来时**必须只返回纯文本**：CLI 自己用 style
// 套颜色，桌面端拿到的是能直接进 DOM 的字符串。混进 ANSI 的话桌面端会显示成一堆乱码。
console.log('\n== MCP token 提示 ==')
{
  const { mcpCostNotice } = await import(`${dist}runtime/mcp-cost.js`)

  const fakeMcp = ({ tokens = 0, connected = 0, failed = 0, toolCount = 0 } = {}) => ({
    tokenHint: () => tokens,
    tools: () => Array.from({ length: toolCount }, (_, i) => ({ name: `mcp__s${i}` })),
    status: () => [
      ...Array.from({ length: connected }, (_, i) => ({ name: `s${i}`, transport: 'stdio', state: 'connected', toolCount: 1 })),
      ...Array.from({ length: failed }, (_, i) => ({ name: `f${i}`, transport: 'stdio', state: 'failed', toolCount: 0 })),
    ],
  })

  const none = mcpCostNotice(fakeMcp(), 1000)
  check('没有 MCP 工具时 tokens 为 0', none.tokens === 0, `实际 ${none.tokens}`)
  check('没有 MCP 工具时不提示接入', none.infoText === '', JSON.stringify(none.infoText))
  check('没有 MCP 工具时不告警', none.warnText === '', JSON.stringify(none.warnText))

  // 真机复现：一个 MCP 都没配的会话，页脚曾经多出一句「已接入 MCP：0 个服务器 /
  // 0 个工具，约 +1 token 上下文」。根因在 `tokenHint()` —— `JSON.stringify([])`
  // 是 `"[]"`，估算器会把它算成 1，而上面这条守卫判的是 `tokens <= 0`
  const { McpManager } = await import(`${dist}mcp/manager.js`)
  const idle = new McpManager({}, { version: '0.0.0-test', view: { warn() {} } })
  check('没接入任何工具时 tokenHint 是 0 而不是 1', idle.tokenHint() === 0, String(idle.tokenHint()))
  check('没配服务器的会话不显示 MCP 开销提示', mcpCostNotice(idle, 1000).infoText === '', JSON.stringify(mcpCostNotice(idle, 1000)))

  // 200/1000 = 20%，卡在阈值下沿 —— 是这条用来验「不告警」，上面那条才验数量
  const small = mcpCostNotice(fakeMcp({ tokens: 200, connected: 2, failed: 1, toolCount: 5 }), 1000)
  check('tokens 透传 tokenHint', small.tokens === 200, `实际 ${small.tokens}`)
  check('servers 只数 connected（failed 不算）', small.servers === 2, `实际 ${small.servers}`)
  check('tools 数的是实际工具数', small.tools === 5, `实际 ${small.tools}`)
  check('接入提示里有服务器数、工具数、token 数', small.infoText.includes('2 个服务器') && small.infoText.includes('5 个工具') && small.infoText.includes('200'), small.infoText)
  check('未超过 25% 时不告警', small.warnText === '', JSON.stringify(small.warnText))

  // 阈值是「严格大于 1/4」：正好等于时不该告警，否则每个刚好卡线的配置都会平白吃一条警告
  const exact = mcpCostNotice(fakeMcp({ tokens: 250, connected: 1, toolCount: 1 }), 1000)
  check('正好占 25% 时不告警（阈值严格大于）', exact.warnText === '', JSON.stringify(exact.warnText))

  const heavy = mcpCostNotice(fakeMcp({ tokens: 400, connected: 1, toolCount: 3 }), 1000)
  check('超过 25% 时告警', heavy.warnText !== '', JSON.stringify(heavy.warnText))
  check('告警里带百分比', heavy.warnText.includes('40%'), heavy.warnText)
  check('告警里告诉用户怎么摘掉（/mcp off）', heavy.warnText.includes('/mcp off'), heavy.warnText)

  // 抽这个模块的**全部理由**就是「返回纯文本」——ANSI 漏进来的话桌面端会显示乱码
  const withAnsi = /\x1b\[/.test(small.infoText + small.warnText + heavy.infoText + heavy.warnText)
  check('文案里不含 ANSI 转义（颜色由调用方自己套）', !withAnsi, JSON.stringify(small.infoText))
}

// ------------------------------------------------------------------ IPC View
// 桌面端不共享进程，`View` 的每个回调都得变成一条能过 IPC 的事件。sink 是接口而不是
// Electron 的 webContents，所以这层能在单测里验 —— 「多会话串台」正是这里最容易出的错。
console.log('\n== IPC View ==')
{
  const { IpcView } = await import(`${dist}runtime/ipc-view.js`)

  const seen = []
  const sink = { send: (sessionId, ev) => seen.push([sessionId, ev]) }
  const types = () => seen.map(([, ev]) => ev.type)

  const view = new IpcView('s1', sink)
  const stream = view.assistantStart()
  stream.write('你好')
  stream.write('，世界')
  stream.end()

  check(
    'assistant-start/delta/delta/end 成对',
    types().join(',') === 'assistant-start,assistant-delta,assistant-delta,assistant-end',
    types().join(','),
  )
  check('delta 带原文', seen[1][1].text === '你好' && seen[2][1].text === '，世界', JSON.stringify(seen[1][1]))

  view.toolStart('read_file', 'Read(a.txt)')
  view.toolOutput('部分输出')
  view.toolEnd(true, '结果', 12)
  check('工具事件序列正确', types().slice(4).join(',') === 'tool-start,tool-output,tool-end', types().join(','))
  check(
    'tool-start 带 name 与 summary',
    seen[4][1].name === 'read_file' && seen[4][1].summary === 'Read(a.txt)',
    JSON.stringify(seen[4][1]),
  )
  check(
    'tool-end 带 ok/result/elapsedMs',
    seen[6][1].ok === true && seen[6][1].result === '结果' && seen[6][1].elapsedMs === 12,
    JSON.stringify(seen[6][1]),
  )

  view.info('信息')
  view.warn('警告')
  view.error('出错')
  view.thinking('思考中')
  view.thinkingDone()

  const summary = {
    steps: 2,
    usage: { input: 1, output: 2 },
    totalUsage: { input: 3, output: 4 },
    cost: 0.01,
    currency: 'USD',
    aborted: false,
    compactions: 0,
  }
  view.turnEnd(summary)

  check('10 个 View 方法各出一条事件', types().length === 13, `实际 ${types().length}：${types().join(',')}`)
  check('thinking 带 label', seen[10][1].label === '思考中', JSON.stringify(seen[10][1]))
  check('turnEnd 原样透传摘要（渲染端要读 steps/cost）', seen[12][1].summary === summary, JSON.stringify(seen[12][1]))
  check('每条事件都带本会话的 sessionId', seen.every(([id]) => id === 's1'))

  // 多会话并行时最要命的错就是把 A 的流式增量发到 B 的窗口里
  const seenB = []
  const viewB = new IpcView('s2', { send: (id, ev) => seenB.push([id, ev]) })
  const streamA = view.assistantStart()
  const streamB = viewB.assistantStart()
  streamA.write('A 的增量')
  streamB.write('B 的增量')
  check('两个会话各自收到自己的流式增量', seen.at(-1)[1].text === 'A 的增量' && seenB.at(-1)[1].text === 'B 的增量')
  check('第二个会话的事件带自己的 sessionId', seenB.every(([id]) => id === 's2'), JSON.stringify(seenB))
}

// ------------------------------------------------------------------ 授权桥
// 桌面端弹授权框要走 IPC，于是「等用户点按钮」变成了一个可能永远不 settle 的 Promise。
// 这些用例盯的就是它 settle 不掉的那些路径 —— 挂住的表现是 runTurn 永不返回、
// 会话卡在「运行中」，而不是报错。
console.log('\n== 授权桥 ==')
{
  const { PermissionBridge, toolNameOf } = await import(`${dist}runtime/permission-bridge.js`)

  const events = []
  const bridge = new PermissionBridge({ send: (sid, ev) => events.push([sid, ev]) })
  const lastId = () => events.at(-1)[1].requestId

  check('toolNameOf 取括号前的工具名', toolNameOf('write_file(a.txt)') === 'write_file', toolNameOf('write_file(a.txt)'))
  check('toolNameOf 对没有括号的 label 原样返回', toolNameOf('write_file') === 'write_file', toolNameOf('write_file'))

  const p1 = bridge.ask('s1', 'write_file(a.txt)', '将修改文件：a.txt')
  check('发起授权时立刻发出 permission-request', events.length === 1 && events[0][1].type === 'permission-request', JSON.stringify(events))
  check('请求里带 label 和风险说明', events[0][1].label === 'write_file(a.txt)' && events[0][1].detail === '将修改文件：a.txt', JSON.stringify(events[0][1]))
  check('请求里带 sessionId', events[0][0] === 's1')
  bridge.reply('s1', lastId(), 'allow')
  check('allow 放行', (await p1) === true)

  const p2 = bridge.ask('s1', 'bash(rm -rf build)')
  bridge.reply('s1', lastId(), 'deny')
  check('deny 拒绝', (await p2) === false)

  // 晚到的回复不能替已经过期的请求放行 —— 用户点「允许」的那一刻，界面上那条请求
  // 可能早就被下一次调用顶掉了
  const p3 = bridge.ask('s1', 'write_file(b.txt)')
  const stale = lastId() - 1
  bridge.reply('s1', stale, 'allow')
  check('陈旧的 requestId 被忽略，请求仍挂着', bridge.hasPending('s1'))
  bridge.reply('s1', lastId(), 'deny')
  check('正确的 requestId 才结清', (await p3) === false)

  const p4 = bridge.ask('s1', 'write_file(c.txt)')
  bridge.reply('s1', lastId(), 'allow')
  bridge.reply('s1', lastId(), 'deny')
  check('重复回复被忽略（先到的算数）', (await p4) === true)

  const ids = events.map(([, ev]) => ev.requestId)
  check('requestId 单调递增', ids.every((id, i) => i === 0 || id > ids[i - 1]), ids.join(','))

  const p5 = bridge.ask('s2', 'bash(ls)')
  check('等待授权时 hasPending 为真', bridge.hasPending('s2'))
  bridge.denyAll('s2')
  check('denyAll 结清待决（不结清 runTurn 就永远不返回）', (await p5) === false && !bridge.hasPending('s2'))
  check('denyAll 对没有待决的会话是空操作', (() => { bridge.denyAll('没这个会话'); return true })())

  // 多会话并行：A 的授权回复绝不能结清 B 的
  const pa = bridge.ask('sA', 'write_file(x)')
  const pb = bridge.ask('sB', 'write_file(y)')
  const idA = events.at(-2)[1].requestId
  const idB = events.at(-1)[1].requestId
  bridge.reply('sA', idA, 'allow')
  check('结清一个会话不影响另一个', (await pa) === true && bridge.hasPending('sB'), `idA=${idA} idB=${idB}`)
  check('用 A 的 requestId 回复 A，B 不受影响', bridge.hasPending('sB'))
  bridge.denyAll('sB')
  await pb

  // 接到真 PermissionManager 上：这才是「本次会话总是允许」的实际语义
  const asked = []
  const bridge2 = new PermissionBridge(
    { send: (sid, ev) => asked.push([sid, ev]) },
    {
      onAllowForSession: (sid, label) => {
        perms.allowForSession(toolNameOf(label))
        perms.allowForSession(label)
        allowedSession.push(`${sid}:${label}`)
      },
    },
  )
  const allowedSession = []
  const perms = new PermissionManager({ mode: 'default', allow: [], deny: [] }, bridge2.askerFor('s1'))
  const writeTool = findTool('write_file')

  const d1 = perms.check(writeTool, { path: 'a.txt' })
  check('default 模式下写操作会去问桥', asked.length === 1, JSON.stringify(asked))
  bridge2.reply('s1', asked.at(-1)[1].requestId, 'allow')
  check('桥放行后 check 通过', (await d1).ok === true)

  const d2 = perms.check(writeTool, { path: 'b.txt' })
  bridge2.reply('s1', asked.at(-1)[1].requestId, 'allow-session')
  check('allow-session 放行', (await d2).ok === true)
  check('allow-session 回调收到了会话与 label', allowedSession.length === 1 && allowedSession[0] === 's1:write_file(b.txt)', JSON.stringify(allowedSession))

  const before = asked.length
  const d3 = perms.check(writeTool, { path: 'c.txt' })
  check('allow-session 之后同类调用不再询问', (await d3).ok === true && asked.length === before, `新增了 ${asked.length - before} 次询问`)

  // 已知的隐患：PermissionManager 的 ask 不监听 signal，所以桥必须能被人为结清。
  // 这里要换个**没被会话放行**的工具 —— write_file 已经被上面的 allow-session 放行了，
  // 再拿它试永远不会重新询问，等于什么都没验到。
  const bashTool2 = findTool('bash')
  const d4 = perms.check(bashTool2, { command: 'echo hi' })
  check('没被会话放行的工具仍会询问', asked.length === before + 1, `实际多了 ${asked.length - before} 次`)
  bridge2.denyAll('s1')
  check('denyAll 让等待中的 check 得到拒绝而不是挂死', (await d4).ok === false)
}

// ------------------------------------------------------------------ 会话管理（基础）
// 桌面端要同时跑多个会话，而这些缺陷在单会话的 CLI 里一辈子碰不到：
// 同一个 Agent 上并发 runTurn、以及 /model 和 /mode 写进共享 config 后串台。
console.log('\n== 会话管理：并发守卫与配置隔离 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)

  const events = []
  const sink = { send: (sid, ev) => events.push([sid, ev]) }
  const textProvider = (text) => ({
    model: 'm',
    async *stream() {
      yield { type: 'text', text }
      yield { type: 'done', finishReason: 'stop' }
    },
  })

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-proj-'))
  const disposed = []
  // 一个 project 实例被同项目的多个会话共用 —— config 是**同一个对象**，
  // 这正是不克隆就会串台的原因
  const openProject = (dir) => ({
    cwd: dir,
    config: agentConfig(),
    provider: textProvider('回答'),
    skills: { list: () => [] },
    assembleTools: () => ALL_TOOLS,
    mcp: { setEnabled: async () => {}, status: () => [], tokenHint: () => 0, tools: () => [] },
    dispose: () => { disposed.push(dir) },
  })

  const mgr = new SessionManager({ sink, openProject })
  const a = await mgr.openSession(projDir)
  const b = await mgr.openSession(projDir)

  check('两个会话拿到不同的 id', a.id !== b.id, `${a.id} / ${b.id}`)
  check('同项目两个会话共用一份 project（MCP 子进程不能开两份）', disposed.length === 0)

  // 缺陷 #3：连点两次发送
  const first = mgr.send(a.id, '你好')
  const second = mgr.send(a.id, '又来一条')
  const secondResult = await second
  check('运行中再发一条被拒', secondResult.ok === false, JSON.stringify(secondResult))
  check('被拒时给出原因', typeof secondResult.reason === 'string' && secondResult.reason.length > 0, secondResult.reason)
  await first
  const userMsgs = mgr.getSession(a.id).agent.messages.filter((m) => m.role === 'user')
  check('被拒的那条没进历史（否则会交错入栈）', userMsgs.length === 1, JSON.stringify(userMsgs))
  check('轮次结束后回到空闲', mgr.getSession(a.id).status === 'idle', mgr.getSession(a.id).status)

  // 缺陷 #1：config 被多会话共享
  mgr.setModel(a.id, '模型A')
  check('setModel 后本会话的系统提示词换了模型', a.agent.messages[0].content.includes('模型A'), a.agent.messages[0].content.slice(0, 200))
  check('setModel 不串到同项目的另一个会话', !b.agent.messages[0].content.includes('模型A'), b.agent.messages[0].content.slice(0, 200))

  const writeTool = findTool('write_file')
  mgr.setMode(b.id, 'plan')
  check('setMode(plan) 后本会话写操作被拒', !(await b.permissions.check(writeTool, { path: 'x.txt' })).ok)
  check('setMode 不串到另一个会话（A 仍是 auto）', (await a.permissions.check(writeTool, { path: 'x.txt' })).ok)
  check('setMode 改变的是本会话 config 里的 mode', b.config.permissions.mode === 'plan', b.config.permissions.mode)

  // 生命周期：同一项目最后一个会话关掉才 dispose
  await mgr.closeSession(a.id)
  check('关掉一个会话还不 dispose（另一个还开着）', disposed.length === 0)
  await mgr.closeSession(b.id)
  check('最后一个会话关掉后才 dispose project', disposed.length === 1, JSON.stringify(disposed))
  check('关掉后 getSession 取不到', mgr.getSession(a.id) === undefined)

  fs.rmSync(projDir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ provider 的 client 冻死
// 界面能改的两个键（baseUrl / apiKey）在 `openai.ts` 里是被 constructor **捕获**进 client 的。
// 不修的话：设置页显示新地址、请求发往旧地址，**且不报任何错** —— 症状是「改了没反应」。
console.log('\n== provider：改了地址，client 必须跟着换 ==')
{
  const { OpenAICompatibleProvider } = await import(`${dist}provider/openai.js`)

  const cfg = {
    baseUrl: 'http://old-host.invalid/v1',
    apiKey: 'k1',
    model: 'm-old',
    temperature: 0,
    maxTokens: 10,
    includeUsage: true,
    timeoutMs: 1000,
    maxRetries: 0,
  }
  // 这个 cfg 就是项目运行时那一份（`project.ts` 把 `config.provider` 传了进来），
  // 所以下面「改 cfg」等价于桌面端改配置
  const p = new OpenAICompatibleProvider(cfg)

  check('构造时 client 用的是当时的地址', p.client.baseURL === 'http://old-host.invalid/v1', p.client.baseURL)
  check('model 也是构造快照（所以换厂商必须刷会话的 model，见下一组）', p.model === 'm-old', p.model)

  cfg.baseUrl = 'http://new-host.invalid/v1'
  check('只改 config 不动 client —— 这正是「冻死」本身', p.client.baseURL === 'http://old-host.invalid/v1', p.client.baseURL)

  // 真走一遍 `stream()` 的入口（syncClient 就在它的第一行）。**给一个已 abort 的 signal**：
  // 请求在开 socket 之前就被拒掉，于是这里不会产生任何真实网络 I/O
  // —— 本文件至今一个 socket 都不开，别在这儿破例
  const controller = new AbortController()
  controller.abort()
  const noop = () => {}
  const gen = p.stream({
    model: 'm',
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 1,
    signal: controller.signal,
  })
  try {
    for await (const _ of gen) noop(_)
    check('已 abort 的请求必须抛出来，而不是静默返回', false)
  } catch {
    check('已 abort 的请求必须抛出来，而不是静默返回', true)
  }
  check('stream() 开头把 client 换到了新地址', p.client.baseURL === 'http://new-host.invalid/v1', p.client.baseURL)

  const kept = p.client
  try {
    for await (const _ of p.stream({
      model: 'm',
      messages: [],
      tools: [],
      temperature: 0,
      maxTokens: 1,
      signal: controller.signal,
    })) {
      noop(_)
    }
  } catch {
    /* 已经验过会抛，这里只关心 client 有没有被重建 */
  }
  check('地址没变就不重建 client（否则每个请求都新建一个连接池）', p.client === kept)
}

// ------------------------------------------------------------------ 切厂商
// 换端点会踩两个坑，任一都是「下一条消息必 404」：
// provider 的 client 是构造时建的快照（改了 baseUrl 请求还打往旧地址，且不报错），
// 以及会话的 model 是开会话时克隆出来的旧值（拿 gpt-4o-mini 去问 DeepSeek）。
console.log('\n== 会话管理：切厂商写盘并刷活会话 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { findVendor } = await import(`${dist}provider/vendors.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-vhome-'))
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-vproj-'))
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = home

  try {
    const config = agentConfig()
    config.provider.baseUrl = 'http://127.0.0.1:9/v1'
    config.provider.model = 'old-model'

    /** 每轮真正用到的地址 —— 读的就是那个会被 setVendor 改掉的活对象 */
    const hit = []
    const project = {
      cwd: projDir,
      config,
      provider: {
        model: config.provider.model,
        async *stream() {
          hit.push(config.provider.baseUrl)
          yield { type: 'text', text: '好的' }
          yield { type: 'done', finishReason: 'stop' }
        },
      },
      skills: { list: () => [] },
      assembleTools: () => ALL_TOOLS,
      mcp: { setEnabled: async () => {}, status: () => [], tokenHint: () => 0, tools: () => [] },
      dispose: () => {},
    }

    const mgr = new SessionManager({ sink: { send: () => {} }, openProject: () => project })
    const a = await mgr.openSession(projDir)
    await mgr.send(a.id, '第一轮')
    check('第一轮打的是项目原来的地址', hit.at(-1) === 'http://127.0.0.1:9/v1', JSON.stringify(hit))
    check('provider.model 是构造时的快照（所以换厂商必须刷会话模型）', project.provider.model === 'old-model', project.provider.model)

    const ds = findVendor('deepseek')
    const file = mgr.setVendor(projDir, ds)
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    check(
      '切厂商把地址与模型一起写盘（只换地址会留着旧模型名，必 404）',
      disk.provider.baseUrl === ds.baseUrl && disk.provider.model === ds.models[0],
      JSON.stringify(disk.provider),
    )
    check('切厂商同步了内存里那份项目配置（否则已开的项目仍发往旧地址）', config.provider.baseUrl === ds.baseUrl, config.provider.baseUrl)
    check(
      '切厂商把活会话的模型也刷了',
      a.config.provider.model === ds.models[0],
      a.config.provider.model,
    )
    check('活会话的系统提示词里也换成新模型名', a.agent.messages[0].content.includes(ds.models[0]), a.agent.messages[0].content.slice(0, 300))

    const opened = await mgr.openSession(projDir)
    check('切完之后新建的会话直接用新模型', opened.config.provider.model === ds.models[0], opened.config.provider.model)

    await mgr.send(a.id, '第二轮')
    check('第二轮真的打到了新地址', hit.at(-1) === ds.baseUrl, JSON.stringify(hit))
  } finally {
    if (prevHome === undefined) delete process.env.CLAUDA_HOME
    else process.env.CLAUDA_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(projDir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ 会话管理（协作）
// 授权等待、MCP 开关、记忆写入这三件事都**跨会话**：
// 「等用户点按钮」的 Promise 挂住会让整轮永不返回，MCP 开关只改当前会话等于没改，
// 而记忆是全局的，A 写完 B 的提示词还是旧的。
console.log('\n== 会话管理：授权等待、MCP 与记忆广播 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)

  const until = async (fn, ms = 3000) => {
    const t0 = Date.now()
    while (!fn()) {
      if (Date.now() - t0 > ms) return false
      await new Promise((r) => setTimeout(r, 5))
    }
    return true
  }
  const text = (t) => ({ type: 'text', text: t })
  const done = (finishReason) => ({ type: 'done', finishReason })
  // ToolCall 是**解析后**的形状（`name` / `args` 在顶层），不是 wire 形状 —— 写成
  // wire 的话 agent 会当成「未知工具」，工具永远不执行，测试却看起来在跑
  const toolCall = (name, args) => ({
    type: 'tool_call',
    call: { id: 'c1', name, args, rawArgs: JSON.stringify(args) },
  })

  // 按「最后一条消息的 role」分流，和 e2e 的 mock 服务端同一条规矩：
  // 换成「消息里有没有 tool 结果」的话，多轮对话下会把后续每一轮都判成收尾
  const routingProvider = {
    model: 'm',
    async *stream(opts) {
      const last = opts.messages[opts.messages.length - 1]
      const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      if (last.role === 'tool') {
        yield text('做完了')
        yield done('stop')
      } else if (lastUser.includes('写文件')) {
        yield toolCall('write_file', { path: path.join(dir, 'out.txt'), content: 'hi' })
        yield done('tool_calls')
      } else if (lastUser.includes('记住')) {
        yield toolCall('memory_write', { name: 'demo-fact', description: '演示用的事实', type: 'project', body: '这条是测试写的' })
        yield done('tool_calls')
      } else {
        yield text('聊天回复')
        yield done('stop')
      }
    },
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-runtime-'))
  const enabledCalls = []
  let mcpOn = true
  const mcpTool = {
    name: 'mcp__demo__ping',
    description: '假 MCP 工具',
    permission: 'exec',
    parameters: { type: 'object', properties: {} },
    summary: () => 'ping',
    run: async () => '',
  }
  const openProject = (d) => ({
    cwd: d,
    config: agentConfig({ permissions: { mode: 'default', allow: [], deny: [] } }),
    provider: routingProvider,
    skills: { list: () => [] },
    assembleTools: () => (mcpOn ? [...ALL_TOOLS, mcpTool] : [...ALL_TOOLS]),
    mcp: {
      setEnabled(name, enabled) {
        enabledCalls.push([name, enabled])
        mcpOn = enabled
      },
    },
    dispose() {},
  })

  const events = []
  const sink = { send: (sid, ev) => events.push([sid, ev]) }
  const mgr = new SessionManager({ sink, openProject })

  const a = await mgr.openSession(dir)
  const b = await mgr.openSession(dir)

  // ---- 缺陷 #2：等授权时中断
  const turnA = mgr.send(a.id, '帮我写文件')
  const asked = await until(() => events.some(([id, ev]) => id === a.id && ev.type === 'permission-request'))
  check('写文件前弹出了授权请求', asked, JSON.stringify(events.map(([id, ev]) => `${id}:${ev.type}`)))

  // B 同时也在跑：A 的授权等待不该波及 B
  const resultB = await mgr.send(b.id, '聊两句')
  check('B 不受 A 等待授权的影响', resultB.ok === true, JSON.stringify(resultB))

  mgr.abort(a.id)
  const resultA = await turnA
  check('等授权时 abort，A 正常收尾而不是挂死', resultA.ok === true, JSON.stringify(resultA))
  check('被中断的轮次标记为 aborted', resultA.outcome?.aborted === true, JSON.stringify(resultA.outcome))
  check('abort 后待决授权被结清', mgr.hasPendingPermission(a.id) === false)
  check('被拒的写操作没有落盘', !fs.existsSync(path.join(dir, 'out.txt')))
  check('A 回到空闲', mgr.getSession(a.id).status === 'idle', mgr.getSession(a.id).status)

  // ---- 缺陷 #5：MCP 开关必须广播到同项目的每个会话
  check('开关前两个会话都拿得到 MCP 工具', a.agent.listTools().some((t) => t.name === 'mcp__demo__ping') && b.agent.listTools().some((t) => t.name === 'mcp__demo__ping'))
  // 必须 await：`setMcpEnabled` 现在要把连接失败冒泡出去，广播工具集挪到了 await 之后
  await mgr.setMcpEnabled(dir, 'demo', false)
  check('转发给了 project.mcp.setEnabled', JSON.stringify(enabledCalls) === JSON.stringify([['demo', false]]), JSON.stringify(enabledCalls))
  check('关掉后 A 的工具集里没有 MCP 工具', !a.agent.listTools().some((t) => t.name === 'mcp__demo__ping'), a.agent.listTools().map((t) => t.name).join(','))
  check('关掉后 B 的工具集里也没有（只改当前会话等于没改）', !b.agent.listTools().some((t) => t.name === 'mcp__demo__ping'), b.agent.listTools().map((t) => t.name).join(','))

  fs.rmSync(dir, { recursive: true, force: true })
}

// 记忆是**全局**的，但记忆索引是拼进各会话系统提示词里的。A 写了新记忆之后，
// B 的提示词还是旧的 —— 这在单会话 CLI 里碰不到，多会话下必然发生。
console.log('\n== 会话管理：记忆写入后广播给同项目其它会话 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)
  const { makeMemoryTools } = await import(`${dist}tools/memory.js`)
  const { listMemories } = await import(`${dist}agent/memory-store.js`)

  // 记忆库落在 CLAUDA_HOME 下，指到临时目录，别污染真实的记忆库
  const prevHome = process.env.CLAUDA_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-membcast-'))
  process.env.CLAUDA_HOME = home

  const text = (t) => ({ type: 'text', text: t })
  const done = (f) => ({ type: 'done', finishReason: f })
  const provider = {
    model: 'm',
    async *stream(opts) {
      const last = opts.messages[opts.messages.length - 1]
      const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      if (last.role === 'tool') {
        yield text('记住了')
        yield done('stop')
      } else if (lastUser.includes('记住')) {
        const args = { name: 'shared-fact', description: '全局共享的事实', type: 'project', body: '正文' }
        yield { type: 'tool_call', call: { id: 'c1', name: 'memory_write', args, rawArgs: JSON.stringify(args) } }
        yield done('tool_calls')
      } else {
        yield text('聊天回复')
        yield done('stop')
      }
    },
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-memproj-'))
  const events = []
  const sink = { send: (sid, ev) => events.push([sid, ev]) }
  const mgr = new SessionManager({
    sink,
    openProject: (d) => ({
      cwd: d,
      // auto 模式：记忆工具是 write 权限，不然会卡在授权框上
      config: agentConfig({ permissions: { mode: 'auto', allow: [], deny: [] } }),
      provider,
      skills: { list: () => [] },
      assembleTools: () => [...ALL_TOOLS, ...makeMemoryTools()],
      memoryIndex: () => { const entries = listMemories().entries; return { entries, total: entries.length } },
      mcp: { setEnabled() {} },
      dispose() {},
    }),
  })

  const a = await mgr.openSession(dir)
  const b = await mgr.openSession(dir)
  check('写之前两个会话的提示词里都没有这条记忆', !a.agent.messages[0].content.includes('shared-fact') && !b.agent.messages[0].content.includes('shared-fact'))

  const result = await mgr.send(a.id, '请记住这件事')
  check('A 的写入轮次跑完', result.ok === true, JSON.stringify(result))
  check('记忆真的写进了记忆库', listMemories().entries.some((m) => m.name === 'shared-fact'), JSON.stringify(listMemories().entries.map((m) => m.name)))
  check('A 自己的提示词当轮就有这条记忆', a.agent.messages[0].content.includes('shared-fact'))
  check('B 的提示词也跟着更新了（否则它按旧索引决策）', b.agent.messages[0].content.includes('shared-fact'))

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 项目运行时
// 桌面端会同时开着多个项目，而 `loadConfig` 里的 dotenv 是**改全局 `process.env`** 的，
// 且不覆盖已存在的键 —— 先开 A 再开 B，B 的 `.env` 会静默不生效、继承 A 的配置。
console.log('\n== 项目运行时：按项目隔离配置 ==')
{
  const { createProjectRuntime } = await import(`${dist}runtime/project.js`)

  const prevModel = process.env.CLAUDA_MODEL
  const prevHome = process.env.CLAUDA_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-projhome-'))
  process.env.CLAUDA_HOME = home

  const mkCwd = (tag, model) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clauda-${tag}-`))
    fs.writeFileSync(path.join(dir, '.env'), `CLAUDA_MODEL=${model}\nCLAUDA_API_KEY=mock\n`, 'utf8')
    return dir
  }
  const dirA = mkCwd('pa', '模型甲')
  const dirB = mkCwd('pb', '模型乙')

  const pa = await createProjectRuntime({ cwd: dirA, version: '0.0.0' })
  const pb = await createProjectRuntime({ cwd: dirB, version: '0.0.0' })

  check('甲项目用自己的 .env 里的模型', pa.config.provider.model === '模型甲', pa.config.provider.model)
  check('乙项目用自己的 .env 里的模型（不被甲顶掉）', pb.config.provider.model === '模型乙', pb.config.provider.model)
  check('加载配置没有把 .env 漏进全局 process.env', process.env.CLAUDA_MODEL === prevModel, String(process.env.CLAUDA_MODEL))

  // 临时目录里没有技能，所以是 7 内置 + 2 记忆
  check('工具集 = 7 内置 + 2 记忆', pa.assembleTools().length === 9, `实际 ${pa.assembleTools().length}`)
  check('项目的 cwd 就是传进去的那个', pa.cwd === dirA, pa.cwd)
  check('dispose 是幂等的', (await pa.dispose(), await pa.dispose(), true))

  await pb.dispose()
  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
}

// 侧边栏每切一次项目就刷一次列表。现在这条路会把每个会话文件的**整份历史对话**
// 都解析一遍，会话一多就卡 —— 列表只需要元数据。
console.log('\n== 会话列表：按项目分组、只读元数据 ==')
{
  const { listProjects, listSessionSummaries, saveSession } = await import(`${dist}agent/session.js`)

  const prevHome = process.env.CLAUDA_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-listhome-'))
  process.env.CLAUDA_HOME = home

  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-la-'))
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-lb-'))
  const rec = (cwd, id, updatedAt, title) => ({
    id,
    cwd,
    model: 'm',
    createdAt: updatedAt,
    updatedAt,
    title,
    messages: [{ role: 'user', content: title }],
    todos: [],
    totalUsage: { input: 0, output: 0 },
    cost: 0,
  })

  saveSession(cwdA, rec(cwdA, 'a1', '2026-01-01T00:00:00.000Z', '甲的旧会话'))
  saveSession(cwdA, rec(cwdA, 'a2', '2026-01-03T00:00:00.000Z', '甲的新会话'))
  saveSession(cwdB, rec(cwdB, 'b1', '2026-01-02T00:00:00.000Z', '乙的会话'))

  const projects = listProjects()
  check('listProjects 分出两个项目', projects.length === 2, JSON.stringify(projects.map((p) => p.cwd)))
  const projA = projects.find((p) => p.cwd === cwdA)
  check('项目 cwd 从会话文件里读回来（目录 slug 不可逆，只能读字段）', !!projA, JSON.stringify(projects.map((p) => p.cwd)))
  check('项目下只挂自己的会话', projA?.sessions.length === 2, JSON.stringify(projA?.sessions.map((s) => s.id)))
  check('项目内按 updatedAt 倒序', projA?.sessions.map((s) => s.id).join(',') === 'a2,a1', projA?.sessions.map((s) => s.id).join(','))

  const sums = listSessionSummaries(cwdA)
  check('摘要按 updatedAt 倒序', sums.map((s) => s.id).join(',') === 'a2,a1', sums.map((s) => s.id).join(','))
  check('摘要带标题、模型、时间', sums[0].title === '甲的新会话' && sums[0].model === 'm' && sums[0].updatedAt === '2026-01-03T00:00:00.000Z', JSON.stringify(sums[0]))
  check('摘要不含 messages（不解析整份历史）', sums.every((s) => !('messages' in s)), JSON.stringify(sums[0]))
  check('摘要不含 todos', sums.every((s) => !('todos' in s)))

  // 旧版本写下的文件：messages 结构已经不对了。摘要只读元数据，所以照样列得出来，
  // 而要求 messages 是数组的老 listSessions 会把它整个跳过
  const legacyFile = saveSession(cwdA, rec(cwdA, 'legacy', '2026-01-04T00:00:00.000Z', '旧版会话'))
  fs.writeFileSync(legacyFile, JSON.stringify({ id: 'legacy', updatedAt: '2026-01-04T00:00:00.000Z', title: '旧版会话', messages: '不是数组' }), 'utf8')
  check('messages 坏掉的旧会话，摘要照样列得出来', listSessionSummaries(cwdA).some((s) => s.id === 'legacy'), JSON.stringify(listSessionSummaries(cwdA).map((s) => s.id)))

  // 完全不是 JSON 的文件不能把整个列表打挂
  fs.writeFileSync(path.join(path.dirname(legacyFile), 'broken.json'), '{ 这不是 JSON', 'utf8')
  let crashed = null
  try {
    listSessionSummaries(cwdA)
    listProjects()
  } catch (e) {
    crashed = e
  }
  check('坏文件不会让列表抛出', crashed === null, crashed?.message ?? '')

  check('没有会话的目录返回空列表', listSessionSummaries(cwdB + '-不存在').length === 0)

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(cwdA, { recursive: true, force: true })
  fs.rmSync(cwdB, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 会话落盘
// 既有 bug：`createdAt` 每轮都重写成 `new Date()`，于是它恒等于 `updatedAt`，
// 「按创建时间排序」整个失真。抽出来给 CLI 和桌面端共用时顺手修掉。
console.log('\n== 会话落盘：createdAt 不被每轮刷新 ==')
{
  const { persistSession } = await import(`${dist}runtime/persist.js`)
  const { loadSession } = await import(`${dist}agent/session.js`)

  const prevHome = process.env.CLAUDA_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-persist-'))
  process.env.CLAUDA_HOME = home
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-persistcwd-'))

  const snap = (n) => ({
    messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `第 ${i} 条` })),
    todos: [],
    totalUsage: { input: 0, output: 0 },
    cost: 0,
  })

  persistSession({ cwd: dir, sessionId: 'p1', model: 'm', snapshot: snap(2) })
  const first = loadSession(dir, 'p1')
  check('第一轮落盘写下了会话', first?.id === 'p1' && first.messages.length === 2, JSON.stringify(first?.id))
  check('第一轮 createdAt 与 updatedAt 相同（刚建的）', first.createdAt === first.updatedAt, `${first.createdAt} / ${first.updatedAt}`)

  // 把 createdAt 改成过去的时间，模拟「这是几轮之前建的会话」
  first.createdAt = '2026-01-01T00:00:00.000Z'
  const { saveSession } = await import(`${dist}agent/session.js`)
  saveSession(dir, first)

  persistSession({ cwd: dir, sessionId: 'p1', model: 'm', snapshot: snap(4) })
  const second = loadSession(dir, 'p1')
  check('再落盘时保留了原来的 createdAt', second.createdAt === '2026-01-01T00:00:00.000Z', second.createdAt)
  check('再落盘时 updatedAt 跟着走', second.updatedAt !== '2026-01-01T00:00:00.000Z', second.updatedAt)
  check('createdAt 与 updatedAt 不再恒等（排序才有意义）', second.createdAt !== second.updatedAt)
  check('新消息进了落盘文件', second.messages.length === 4, String(second.messages.length))

  // 只有系统提示词（<= 1 条）的会话不落盘，免得侧边栏全是空会话
  persistSession({ cwd: dir, sessionId: 'p2', model: 'm', snapshot: { ...snap(1) } })
  check('只有系统提示词时不落盘', loadSession(dir, 'p2') === null)

  check('落盘失败不抛出（磁盘问题不该影响对话）', (() => { persistSession({ cwd: ' 非法路径', sessionId: 'p3', model: 'm', snapshot: snap(3) }); return true })())

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
}

// 渲染层是纯 JS、住在 desktop/ 下（不在 tsc 的 rootDir 里），所以直接 import 源码来测。
// 前提是它在 import 期不能碰 document —— 碰了这里就炸，正好当护栏。
console.log('\n== 桌面端渲染层：消息流归约 ==')
{
  const { createState, reduce, changedFiles } = await import(
    new URL('../desktop/renderer/state.js', import.meta.url).href
  )

  const openedEvent = (id) => ({
    type: 'session-opened',
    session: {
      id,
      cwd: 'C:/proj',
      model: 'm',
      mode: 'default',
      tools: [],
      todos: [],
      contextTokens: 0,
      contextRatio: 0,
    },
  })
  const itemsOf = (state, id) => state.sessions[id].items

  let st = createState()
  st = reduce(st, openedEvent('s1'))
  st = reduce(st, openedEvent('s2'))
  check('会话登记进 state 并按打开顺序排列', JSON.stringify(st.order) === '["s1","s2"]', JSON.stringify(st.order))
  check('最后一个打开的会话成为当前会话', st.activeId === 's2', String(st.activeId))

  st = reduce(st, { type: 'select', id: 's1' })
  check('切会话只动 activeId', st.activeId === 's1' && itemsOf(st, 's1').length === 0, String(st.activeId))

  const frozen = st
  st = reduce(st, { type: 'user-send', sessionId: 's1', text: '项目叫什么' })
  check('用户消息进了自己那个会话', itemsOf(st, 's1').length === 1 && itemsOf(st, 's2').length === 0)
  check('归约不改原 state（旧对象留着给渲染层做 diff）', frozen.sessions.s1.items.length === 0)

  st = reduce(st, { type: 'assistant-start', sessionId: 's1' })
  st = reduce(st, { type: 'assistant-delta', sessionId: 's1', text: '我' })
  st = reduce(st, { type: 'assistant-delta', sessionId: 's1', text: '在读' })
  st = reduce(st, { type: 'assistant-end', sessionId: 's1' })
  const assistant = itemsOf(st, 's1')[1]
  // 流式增量必须并进同一条：每次 delta 新起一条的话，界面上会变成一行一个字往下堆
  check('流式增量累积成一条助手消息', itemsOf(st, 's1').length === 2 && assistant.text === '我在读', JSON.stringify(assistant))
  check('助手消息结束后不再是流式中', assistant.streaming === false, JSON.stringify(assistant))

  st = reduce(st, { type: 'tool-start', sessionId: 's1', name: 'read_file', summary: 'package.json' })
  st = reduce(st, { type: 'tool-output', sessionId: 's1', chunk: '{"name":' })
  st = reduce(st, { type: 'tool-output', sessionId: 's1', chunk: '"clauda"}' })
  st = reduce(st, { type: 'tool-end', sessionId: 's1', ok: true, result: '读完了', elapsedMs: 12 })
  const card = itemsOf(st, 's1')[2]
  check(
    '工具卡片记下了名字、摘要、状态和耗时',
    card.kind === 'tool' && card.name === 'read_file' && card.summary === 'package.json' && card.status === 'ok' && card.elapsedMs === 12,
    JSON.stringify(card),
  )
  check('工具输出增量并进同一条', card.output === '{"name":"clauda"}', JSON.stringify(card.output))
  check('工具跑的时候卡片是 running', reduce(st, { type: 'tool-start', sessionId: 's1', name: 'bash', summary: 'ls' }).sessions.s1.items[3].status === 'running')

  st = reduce(st, { type: 'tool-start', sessionId: 's1', name: 'write_file', summary: 'note.txt' })
  st = reduce(st, { type: 'tool-end', sessionId: 's1', ok: false, result: '用户拒绝了', elapsedMs: 3 })
  check('被拒绝的工具卡片状态是 error', itemsOf(st, 's1')[3].status === 'error', JSON.stringify(itemsOf(st, 's1')[3]))

  st = reduce(st, { type: 'error', sessionId: 's1', msg: '接口 401' })
  st = reduce(st, { type: 'warn', sessionId: 's1', msg: 'MCP 占了 30%' })
  check(
    'info/warn/error 当通知条目插进消息流',
    itemsOf(st, 's1').slice(4).map((i) => i.level).join(',') === 'error,warn',
    JSON.stringify(itemsOf(st, 's1').slice(4)),
  )

  st = reduce(st, { type: 'session-status', sessionId: 's2', status: 'running' })
  check('会话状态进侧边栏数据', st.sessions.s2.status === 'running' && st.sessions.s1.status === 'idle', st.sessions.s2.status)

  st = reduce(st, { type: 'thinking', sessionId: 's2', label: '读文件' })
  check('思考状态挂在对应会话上', st.sessions.s2.thinking === '读文件' && st.sessions.s1.thinking === null)
  st = reduce(st, { type: 'thinking-done', sessionId: 's2' })
  check('思考结束清空', st.sessions.s2.thinking === null, String(st.sessions.s2.thinking))

  // 事件可能比 session-opened 先到（比如别的窗口刚建的会话）——丢掉，不能把 state 打挂
  const ghost = reduce(st, { type: 'assistant-delta', sessionId: '不存在', text: 'x' })
  check('认不出的会话，事件直接丢掉', ghost === st, JSON.stringify(Object.keys(ghost.sessions)))

  st = reduce(st, { type: 'session-state', sessionId: 's1', session: { tools: ['read_file'], todos: [{ content: '写测试' }], contextRatio: 0.3, model: 'm2', mode: 'plan' } })
  check(
    '会话快照回填工具 / 待办 / 上下文占用 / 模型 / 模式',
    st.sessions.s1.todos.length === 1 &&
      st.sessions.s1.contextRatio === 0.3 &&
      st.sessions.s1.model === 'm2' &&
      st.sessions.s1.mode === 'plan' &&
      st.sessions.s1.tools[0] === 'read_file',
    JSON.stringify({ todos: st.sessions.s1.todos, r: st.sessions.s1.contextRatio, m: st.sessions.s1.model }),
  )
  check('回填快照不会把消息流冲掉', itemsOf(st, 's1').length === 6, String(itemsOf(st, 's1').length))

  st = reduce(st, { type: 'permission-request', sessionId: 's2', requestId: 7, label: 'write_file(note.txt)', detail: '将修改文件：note.txt' })
  check(
    '授权请求挂到发起它的那个会话上',
    st.sessions.s2.pending?.requestId === 7 && st.sessions.s2.pending.label === 'write_file(note.txt)' && st.sessions.s1.pending === null,
    JSON.stringify(st.sessions.s2.pending),
  )
  st = reduce(st, { type: 'permission-replied', sessionId: 's2', requestId: 7 })
  check('回复之后弹窗状态清空', st.sessions.s2.pending === null)

  st = reduce(st, { type: 'permission-request', sessionId: 's2', requestId: 8, label: 'bash(ls)' })
  st = reduce(st, { type: 'permission-replied', sessionId: 's2', requestId: 7 })
  check('陈旧的回复不会误清掉新弹窗', st.sessions.s2.pending?.requestId === 8, JSON.stringify(st.sessions.s2.pending))

  st = reduce(st, { type: 'projects', projects: [{ cwd: 'C:/proj', sessions: [] }] })
  st = reduce(st, { type: 'history', cwd: 'C:/proj', sessions: [{ id: 'h1', title: '旧会话' }] })
  check('项目分组与历史会话分开存', st.projects.length === 1 && st.history['C:/proj'][0].id === 'h1')

  // 同一个 id 再打开一次（关掉历史会话又重新点开）不能在侧边栏里出现两条
  const reopened = reduce(reduce(st, openedEvent('s1')), openedEvent('s1'))
  check('重复打开同一个 id 不会在侧边栏排两条', JSON.stringify(reopened.order) === '["s1","s2"]', JSON.stringify(reopened.order))
  check(
    '重开的会话拿到新的 openSeq（渲染层靠它决定要不要重建消息流）',
    reopened.sessions.s1.openSeq !== st.sessions.s1.openSeq,
    `${reopened.sessions.s1.openSeq} vs ${st.sessions.s1.openSeq}`,
  )

  // 项目级警告（MCP 连不上之类）不带 sessionId，不能塞进任何一个会话的消息流
  st = reduce(st, { type: 'app-notice', level: 'warn', text: 'MCP「fs」连接失败' })
  check(
    '应用级通知进通知栏，不挂到任何会话上',
    st.notices.length === 1 && st.notices[0].level === 'warn' && itemsOf(st, 's1').length === 6,
    JSON.stringify(st.notices),
  )
  for (let i = 0; i < 80; i++) st = reduce(st, { type: 'app-notice', level: 'info', text: `第 ${i} 条` })
  check('通知栏有上限，长时间挂着不会把 state 撑爆', st.notices.length === 50 && st.notices.at(-1).text === '第 79 条', String(st.notices.length))

  // 右栏「改动文件」：只认真写成功的，且按首次出现去重
  check('只把成功的写入算进改动文件', JSON.stringify(changedFiles(st.sessions.s1)) === '[]', JSON.stringify(changedFiles(st.sessions.s1)))
  let files = reduce(st, { type: 'tool-start', sessionId: 's9', name: 'write_file', summary: 'a.txt' })
  files = reduce(files, openedEvent('s9'))
  files = reduce(files, { type: 'tool-start', sessionId: 's9', name: 'write_file', summary: 'a.txt' })
  files = reduce(files, { type: 'tool-end', sessionId: 's9', ok: true, result: 'ok', elapsedMs: 1 })
  files = reduce(files, { type: 'tool-start', sessionId: 's9', name: 'edit_file', summary: 'src/b.ts' })
  files = reduce(files, { type: 'tool-end', sessionId: 's9', ok: true, result: 'ok', elapsedMs: 1 })
  files = reduce(files, { type: 'tool-start', sessionId: 's9', name: 'write_file', summary: 'c.txt' })
  files = reduce(files, { type: 'tool-end', sessionId: 's9', ok: false, result: '拒绝', elapsedMs: 1 })
  check(
    '改动文件列表去重且按出现顺序',
    JSON.stringify(changedFiles(files.sessions.s9)) === '["a.txt","src/b.ts"]',
    JSON.stringify(changedFiles(files.sessions.s9)),
  )
}

// 从历史会话恢复出来的对话，得能画成和当时一样的消息流。落盘的是 OpenAI wire 格式，
// 而 wire 格式里**没有 tool 消息的工具名** —— 名字在它前面那条 assistant 的 tool_calls 里，
// 只能靠 tool_call_id 对回去。这是这个函数存在的全部理由。
console.log('\n== 桌面端渲染层：历史会话还原成消息流 ==')
{
  const { toItems, changedFiles } = await import(new URL('../desktop/renderer/state.js', import.meta.url).href)

  const messages = [
    { role: 'system', content: '你是 clauda' },
    { role: 'user', content: '项目叫什么' },
    {
      role: 'assistant',
      content: '我看一下。',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } },
        { id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"x"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"name":"clauda"}' },
    { role: 'tool', tool_call_id: 'c2', content: '已创建 out.txt（1 字节，1 行）' },
    { role: 'user', content: '谢谢' },
  ]

  const items = toItems(messages)
  check('系统提示词不画进消息流（恢复时 Agent 会自己重建）', !items.some((i) => i.text === '你是 clauda'), JSON.stringify(items.map((i) => i.kind)))
  check(
    '顺序与角色对得上',
    items.map((i) => i.kind).join(',') === 'user,assistant,tool,tool,user',
    items.map((i) => i.kind).join(','),
  )
  check(
    '工具卡片靠 tool_call_id 从前面那条 assistant 找回名字与路径',
    items[2].name === 'read_file' && items[2].summary === 'package.json' && items[3].name === 'write_file' && items[3].summary === 'out.txt',
    JSON.stringify(items.slice(2, 4)),
  )
  check('工具结果填回卡片', items[2].result === '{"name":"clauda"}' && items[3].result.includes('已创建 out.txt'), JSON.stringify(items[2].result))
  check('还原出来的卡片不是流式中', items[1].streaming === false && items[0].text === '项目叫什么')

  // 落盘格式里没有「这次工具调用成没成功」，所以还原时不敢认成功 ——
  // 认了的话，用户当初点了拒绝的那次写入，重开会话后右栏会凭空多一个文件
  check(
    '还原出来的工具卡片状态是 done，不算进改动文件',
    items[2].status === 'done' && JSON.stringify(changedFiles({ items })) === '[]',
    JSON.stringify(changedFiles({ items })),
  )

  check('坏参数不炸（工具参数不是合法 JSON 时摘要留空）', toItems([
    { role: 'assistant', tool_calls: [{ id: 'c9', function: { name: 'bash', arguments: '不是 json' } }] },
    { role: 'tool', tool_call_id: 'c9', content: 'ok' },
  ])[0].summary === '')
  check('空历史不炸', toItems([]).length === 0 && toItems(null).length === 0)

  const { createState: cs, reduce: rd } = await import(new URL('../desktop/renderer/state.js', import.meta.url).href)
  let h = rd(cs(), { type: 'session-opened', session: { id: 'h1', cwd: 'C:/p' } })
  h = rd(h, { type: 'messages-restored', sessionId: 'h1', messages })
  check(
    '打开历史会话时整份对话被还原成消息流',
    h.sessions.h1.items.length === 5 && h.sessions.h1.items[0].text === '项目叫什么',
    JSON.stringify(h.sessions.h1.items.length),
  )
}

console.log('\n== 桌面端渲染层：markdown ==')
{
  const { markdown } = await import(new URL('../desktop/renderer/markdown.js', import.meta.url).href)

  const injected = markdown('<script>alert(1)</script>')
  check('HTML 标签被转义，不会被当标签执行', injected.includes('&lt;script&gt;') && !injected.includes('<script>'), injected)
  check('属性注入也被挡住', !markdown('<img src=x onerror=alert(1)>').includes('<img'), markdown('<img src=x onerror=alert(1)>'))

  const fenced = markdown('```js\nconst a = 1 < 2 && 3 > 2\n```')
  check('围栏代码块渲染成 pre/code', fenced.includes('<pre><code') && fenced.includes('</code></pre>'), fenced)
  check('代码块里的尖括号与 & 照样转义', fenced.includes('1 &lt; 2 &amp;&amp; 3 &gt; 2'), fenced)
  const fenceMd = markdown('```\n**不该加粗**\n# 不是标题\n```')
  check('代码块内部不再解析 markdown', fenceMd.includes('**不该加粗**') && !fenceMd.includes('<strong>') && !fenceMd.includes('<h1>'), fenceMd)

  check('行内代码', markdown('用 `npm test` 跑').includes('<code>npm test</code>'), markdown('用 `npm test` 跑'))
  check('行内代码里的星号不会被加粗', markdown('`a**b**c`').includes('<code>a**b**c</code>'), markdown('`a**b**c`'))
  check('粗体', markdown('这**很重要**').includes('<strong>很重要</strong>'), markdown('这**很重要**'))
  check('标题', markdown('## 小结').includes('<h2>小结</h2>'), markdown('## 小结'))
  const list = markdown('- 甲\n- 乙')
  check('无序列表合成一个 <ul>', list.includes('<ul><li>甲</li><li>乙</li></ul>'), list)
  check('空输入不炸', markdown('') === '' && markdown(null) === '' && markdown(undefined) === '')

  // 占位符借 NUL / SOH 两个控制字符，而 `escape` 不动它们 —— 模型直接吐一个占位符
  // 就能伪造，`blocks[i]` / `codes[i]` 被顶到别的位置上。换进去的都是转义过的字符串，
  // 注不进标签，但输入里先删掉这两个字符，唯一性才是真的成立的。
  const NUL = String.fromCharCode(0)
  const SOH = String.fromCharCode(1)
  const count = (s, sub) => s.split(sub).length - 1

  // 输入里那段 `${NUL}0${NUL}` 正好是代码块占位符的写法。没删控制字符的话它会和
  // 真的占位符撞车，同一个代码块被吐出来两次。删掉之后它只是个普通的 0。
  const forged = markdown(`\`\`\`\n代码\n\`\`\`\n${NUL}0${NUL}`)
  check('伪造的块占位符不会让代码块出现两次', count(forged, '代码') === 1, forged)
  check('输出里不留占位符控制字符', !forged.includes(NUL) && !forged.includes(SOH), JSON.stringify(forged))

  const forgedInline = markdown(`\`x\`${SOH}0${SOH}`)
  check('伪造的行内占位符不会让代码出现两次', count(forgedInline, '<code>x</code>') === 1, forgedInline)
}

// 消息流是增量画的（全量重绘会在流式输出时整块闪），于是就有了「哪个 DOM 节点该重画」
// 这个判断。它出错的症状极隐蔽：新建的节点忘了画 ⇒ 切走再切回来，前面几条全空白、
// 只有最后一条有内容 —— 而「切回来只有最后一条」看着特别像数据丢了，不像渲染漏了。
// 单测盯不到 app.js 那层 DOM，就把这段判断抽成纯函数放在这里判。
console.log('\n== 桌面端渲染层：增量重绘的节点挑选 ==')
{
  const { streamPlan } = await import(new URL('../desktop/renderer/state.js', import.meta.url).href)

  const sorted = (a) => JSON.stringify([...a].sort((x, y) => x - y))

  // 全新建：每一条都得画，漏一条就是一个空白块。**这条是那个 bug 的回归** ——
  // 只画最后一条的实现会返回 `[2]`，界面上就是「切回会话只有最后一条有内容」
  check('从空到 3 条，三条都要画', sorted(streamPlan(0, 3)) === '[0,1,2]', sorted(streamPlan(0, 3)))
  // 「新建的每一个都要在名单里」比逐条比对更贴紧不变量，也容得下重复下标
  const grown = streamPlan(2, 6)
  check('新建的每一个节点都在名单里', [2, 3, 4, 5].every((i) => grown.includes(i)), JSON.stringify(grown))
  check('尾巴也在名单里（增量改的就是它）', grown.includes(5), JSON.stringify(grown))
  // 条数没变时没有新建的，只剩尾巴
  check('条数不变时只重画尾巴', sorted(streamPlan(3, 3)) === '[2]', sorted(streamPlan(3, 3)))
  check('空消息流什么都不画', JSON.stringify(streamPlan(0, 0)) === '[]', JSON.stringify(streamPlan(0, 0)))
  // 变少（恢复历史时可能发生）：剩下的尾巴仍要重画，多的交给调用方删
  check('条数变少时只重画新的尾巴', sorted(streamPlan(5, 2)) === '[1]', sorted(streamPlan(5, 2)))
  check(
    '挑出来的下标都不越界',
    streamPlan(3, 5).every((i) => i >= 0 && i < 5),
    JSON.stringify(streamPlan(3, 5)),
  )
}

// app.js 是这次改动里最大的一块没被覆盖的代码。它最容易出的错不是「算错了」而是
// 「漏画了」—— streamPlan 那种纯逻辑单测盯不到。这里套一层假 DOM 把真实的
// renderStream / paint / renderModal 走一遍。抓到过一次真 bug：
// 「切走再切回来，A 的 3 条里前两条是空白」。
// **注意别把长度断言当全部** —— 出 bug 时节点数照样是 3，只是内容是空的。
console.log('\n== 桌面端渲染层：真实渲染路径（假 DOM） ==')
{
  const { bootRenderer, tick, uninstallDom } = await import(new URL('./renderer-dom.mjs', import.meta.url).href)
  const app = await bootRenderer()

  /** 每个条目节点里有没有真的画出东西 */
  const painted = () =>
    app.el('stream').children.map((node) => {
      if (node.children.length === 0) return '[空节点]'
      const inner = node.children[0]
      const text = inner.textContent || inner.innerHTML || (inner.children.length ? '<dom/>' : '')
      return text ? 'ok' : '[空白块]'
    })
  const allPainted = (n) => app.el('stream').children.length === n && painted().every((p) => p === 'ok')

  await app.el('new-session').click()
  await tick()
  check('新建会话后它成为当前会话', app.el('chat-title').textContent === 'C:/p', app.el('chat-title').textContent)
  check('新会话的消息流是空的', app.el('stream').children.length === 0)

  // 一轮完整对话：助手 → 工具 → 助手，共 3 条
  app.emit('s1', { type: 'assistant-start' })
  app.emit('s1', { type: 'assistant-delta', text: '我先看' })
  app.emit('s1', { type: 'assistant-end' })
  app.emit('s1', { type: 'tool-start', name: 'read_file', summary: 'package.json' })
  app.emit('s1', { type: 'tool-end', ok: true, result: '{"name":"x"}', elapsedMs: 3 })
  app.emit('s1', { type: 'assistant-start' })
  app.emit('s1', { type: 'assistant-delta', text: '项目是 x' })
  app.emit('s1', { type: 'assistant-end' })
  check('三条消息都画出来了', app.el('stream').children.length === 3, String(app.el('stream').children.length))
  check('每一条都有内容，没有空白块', allPainted(3), painted().join(' '))

  const card = app.el('stream').children[1].children[0]
  check('工具卡片带上了工具名', card.children[0].children[0].textContent === 'read_file', card.children[0].children[0].textContent)
  check('工具卡片带上了工具结果', card.children[1].textContent === '{"name":"x"}', card.children[1].textContent)
  check(
    '助手气泡走了 markdown（全文件唯一一处 innerHTML）',
    app.el('stream').children[2].children[0].innerHTML.includes('项目是 x'),
    app.el('stream').children[2].children[0].innerHTML,
  )

  // 再开一个会话 B。切走再切回来是增量重绘最容易漏的地方
  await app.el('new-session').click()
  await tick()
  check('切到新会话后消息流清空了', app.el('stream').children.length === 0)
  app.emit('s2', { type: 'assistant-start' })
  app.emit('s2', { type: 'assistant-delta', text: 'B 说的' })
  app.emit('s2', { type: 'assistant-end' })
  check('B 的那条画出来了', allPainted(1), painted().join(' '))

  app.row(1).click()
  await tick()
  check('切回 A 后三条都还在', app.el('stream').children.length === 3, String(app.el('stream').children.length))
  check('切回 A 后每一条都还有内容（增量重绘漏画新节点的现场）', allPainted(3), painted().join(' '))
  check('切回 A 后没混进 B 的消息', !app.el('stream').children.some((n) => n.innerHTML?.includes('B 说的')))

  app.row(2).click()
  await tick()
  check('切回 B 后只有它自己那一条', allPainted(1), `${app.el('stream').children.length} ${painted().join(' ')}`)

  // 授权弹窗。此刻停在 B，A 要授权 —— 弹窗不该冒出来打断，靠侧边栏的状态点提示
  const dot = (n) => app.row(n).children[1]
  check('空闲会话的状态点是 idle', dot(1).className.includes('idle'), dot(1).className)
  app.emit('s1', { type: 'permission-request', requestId: 7, label: 'write_file(note.txt)', detail: '会覆盖同名文件' })
  check('别的会话要授权时不打断当前会话', app.el('modal-host').hidden === true)
  check('但侧边栏把 A 标成了等待授权', dot(1).className.includes('waiting'), dot(1).className)
  check('状态点带上了 tooltip', dot(1).title === '等待授权', dot(1).title)

  // 消息流变短（恢复一份更短的历史）时多出来的节点要被摘掉。
  // 正常路径走不到 —— session/resume 会把 openSeq 推进一格、整份重画 —— 所以这里直接压
  app.emit('s1', { type: 'messages-restored', messages: [{ role: 'user', content: '只剩这一条' }] })
  await tick()
  check('消息流变短时多出来的节点被摘掉了', app.el('stream').children.length === 1, String(app.el('stream').children.length))
  check('剩下的那条还画着', allPainted(1), painted().join(' '))

  app.row(1).click()
  await tick()
  check('切到 A 后授权弹窗才弹出来', app.el('modal-host').hidden === false)
  const modal = app.el('modal-host').children[0]
  check('弹窗上写着工具名', modal.children[1].textContent === 'write_file(note.txt)', modal.children[1].textContent)
  check('弹窗上带着风险说明', modal.children[2].textContent === '会覆盖同名文件', modal.children[2].textContent)
  check('弹窗给了三个选项', modal.children[3].children.length === 3, String(modal.children[3].children.length))

  // 点「允许」必须先把回复发出去，再关弹窗 —— 顺序反了用户会以为没点上
  modal.children[3].children[1].click()
  await tick()
  check('点允许后弹窗关掉了', app.el('modal-host').hidden === true)
  check('点允许真的发了授权回复', app.calls.includes('permission/reply'), app.calls.join(','))
  check('状态点不再标等待授权', !dot(1).className.includes('waiting'), dot(1).className)

  // ---- 左导航与模型 / 技能 / MCP 三个设置页
  // 假 DOM 的 textContent 不做聚合，断言文案只能自己把子树拼起来
  const textOf = (node) => (node.textContent || '') + node.children.map(textOf).join(' ')
  const find = (node, pred) => {
    if (pred(node)) return node
    for (const child of node.children) {
      const hit = find(child, pred)
      if (hit) return hit
    }
    return null
  }

  check('默认停在会话视图', app.el('app').dataset.view === 'sessions', app.el('app').dataset.view)
  check('会话视图下设置容器是藏着的', app.el('view-settings').hidden === true)
  check('会话视图下对话区还在', app.el('view-sessions').hidden === false)

  app.el('nav-model').click()
  await tick()
  check('点「模型」切到模型页', app.el('app').dataset.view === 'model', app.el('app').dataset.view)
  check('设置容器显示出来了', app.el('view-settings').hidden === false)
  check('对话区让位了', app.el('view-sessions').hidden === true)
  check('当前导航项被标出来', app.el('nav-model').className.includes('is-current'), app.el('nav-model').className)
  check('其余导航项没被误标', !app.el('nav-sessions').className.includes('is-current'))
  check('导航条上的模型徽标跟着当前会话', app.el('badge-model').textContent === 'm', app.el('badge-model').textContent)

  const body = app.el('settings-body')
  const modelText = textOf(body)
  check('模型页有标题', app.el('settings-title').textContent === '模型配置', app.el('settings-title').textContent)
  check('模型页的密钥是打码的', modelText.includes('····abcd') && !modelText.includes('sk-'), modelText)
  check('模型页显示温度与上下文窗口', modelText.includes('0.3') && modelText.includes('128000'))
  check('模型页显示权限规则', modelText.includes('Read') && modelText.includes('Bash(rm:*)'))

  /** 取「设置页里 key 那一行」的右侧值节点 */
  const rowValue = (key) =>
    find(body, (n) => n.className === 'set-row' && n.children[0]?.textContent === key)?.children[1] ?? null
  /**
   * 编辑行**按 aria-label 定位**，不能取「文档序第一个 .set-edit」——
   * 接口地址那行现在排在默认模型前面，按下标取会点到「存为接口地址」上去。
   */
  const editLineOf = (label) =>
    find(body, (n) => n.className === 'set-edit' && n.children[0]?.getAttribute('aria-label') === label)

  // 接口地址是可编辑的（各家的区域变体、公司自建网关都靠它）
  const baseUrlEdit = editLineOf('接口地址')
  check('接口地址那一格是可编辑的', baseUrlEdit !== null)
  check('接口地址框里是当前生效的地址', baseUrlEdit?.children[0].value === 'http://127.0.0.1:9/v1', baseUrlEdit?.children[0].value)

  // 厂商选择器：预置 + 自定义。fixture 的地址匹配不到任何预置，所以停在「自定义」
  const vendorPick = find(body, (n) => n.tagName === 'select')
  check('厂商那一格是个选择器', vendorPick !== null)
  check(
    '选项数 = 预置数 + 自定义',
    vendorPick?.children.length === app.vendors.length + 1,
    `${vendorPick?.children.length} vs ${app.vendors.length + 1}`,
  )
  check('匹配不到预置时选中「自定义」', vendorPick?.value === '__custom__', vendorPick?.value)
  const keySourceText = textOf(rowValue('密钥来源'))
  check('自定义地址的密钥来源指向通用变量', keySourceText.includes('CLAUDA_API_KEY'), keySourceText)

  // 换厂商：一次写盘同时改地址和模型，页面还得立刻重画（指纹里漏了 baseUrl 就不动）
  const deepseek = app.vendors.find((v) => v.key === 'deepseek')
  vendorPick.value = 'deepseek'
  vendorPick.fire('change')
  await tick()
  check(
    '选厂商后发了 set-vendor，且带上了 cwd',
    app.calls.includes('project/set-vendor') && app.savedVendors[0]?.cwd === 'C:/p',
    JSON.stringify(app.savedVendors),
  )
  const repainted = find(body, (n) => n.tagName === 'select')
  check('切完厂商选择器停在新的那一项上', repainted?.value === 'deepseek', repainted?.value)
  check('切完厂商接口地址跟着变了', editLineOf('接口地址')?.children[0].value === deepseek.baseUrl, editLineOf('接口地址')?.children[0].value)
  check(
    '切完厂商「密钥来源」说得出该设哪个变量',
    textOf(rowValue('密钥来源')).includes('DEEPSEEK_API_KEY'),
    textOf(rowValue('密钥来源')),
  )
  check(
    '切完厂商默认模型换成该厂商的',
    editLineOf('默认模型')?.children[0].value === deepseek.models[0],
    editLineOf('默认模型')?.children[0].value,
  )

  // 候选模型名：点一下只填输入框，**不写盘**
  const modelEdit = editLineOf('默认模型')
  check('默认模型那一格是可编辑的', modelEdit !== null)
  // children[0]=input / children[1]=按钮 是契约，插错顺序这条立刻红
  check('编辑行的头两个孩子仍是 输入框 + 按钮', modelEdit.children[1].textContent === '存为默认', modelEdit.children[1].textContent)
  const savedBefore = app.savedModels.length
  // 候选挂在编辑行**外面**（`.set-edit` 是 flex 行，塞进去会被挤到输入框同一行），
  // 所以从这一格（`.set-val`）找，而不是从编辑行找
  const tag = find(rowValue('默认模型'), (n) => n.className === 'tag')
  check('默认模型那行给出了候选', tag !== null)
  tag.click()
  await tick()
  check('点候选只把模型名填进输入框', modelEdit.children[0].value === tag.textContent, modelEdit.children[0].value)
  check('点候选不写盘', app.savedModels.length === savedBefore, String(app.savedModels.length))

  modelEdit.children[0].value = 'gpt-x'
  modelEdit.children[1].click()
  await tick()
  check(
    '点「存为默认」把模型写回了项目配置',
    app.savedModels.length === savedBefore + 1 && app.savedModels.at(-1).model === 'gpt-x',
    JSON.stringify(app.savedModels),
  )
  check('写完提示了写到哪个文件', textOf(app.el('notices')).includes('config.json'), textOf(app.el('notices')))

  // 手填接口地址走另一条通道；「自定义」那一项本身不该发任何请求
  const vendorCallsBefore = app.savedVendors.length
  const select2 = find(body, (n) => n.tagName === 'select')
  select2.value = '__custom__'
  select2.fire('change')
  await tick()
  check('选中「自定义」不发任何请求（没有可写的地址）', app.savedVendors.length === vendorCallsBefore)

  const urlInput = editLineOf('接口地址').children[0]
  urlInput.value = 'http://localhost:8080'
  editLineOf('接口地址').children[1].click()
  await tick()
  check(
    '点「存为接口地址」发了 set-base-url 且带上了地址',
    app.savedBaseUrls.at(-1)?.baseUrl === 'http://localhost:8080' && app.savedBaseUrls.at(-1)?.cwd === 'C:/p',
    JSON.stringify(app.savedBaseUrls),
  )

  app.el('nav-skills').click()
  await tick()
  check('点「技能」切到技能页', app.el('app').dataset.view === 'skills', app.el('app').dataset.view)
  const skillText = textOf(app.el('settings-body'))
  check('技能页列出了技能名', skillText.includes('/demo'), skillText)
  check('技能页列出了技能文件路径', skillText.includes('SKILL.md'), skillText)
  check('技能页的说明写了技能从哪来', textOf(app.el('settings-sub')).includes('skills'))
  check('技能数画进了导航徽标', app.el('badge-skills').textContent === '1', app.el('badge-skills').textContent)

  app.el('nav-mcp').click()
  await tick()
  check('点「MCP」切到 MCP 页', app.el('app').dataset.view === 'mcp', app.el('app').dataset.view)
  const mcpText = textOf(app.el('settings-body'))
  check('MCP 页列出了服务器名', mcpText.includes('demo') && mcpText.includes('broken'), mcpText)
  check('MCP 页列出了 transport', mcpText.includes('stdio') && mcpText.includes('http'), mcpText)
  check('MCP 页显示已连接 / 已配置', app.el('badge-mcp').textContent === '1/2', app.el('badge-mcp').textContent)
  // 文案由 `mcpCostNotice` 出，桌面端只摆位置 —— 这里换了措辞就会被抓到
  check('MCP 页用了后端给的开销文案', mcpText.includes('已接入 MCP：1 个服务器 / 2 个工具'), mcpText)

  // 陷阱 1 的验收点：服务器连不上时必须报失败，且开关不能停在「已接入」
  app.mcp.fail = { broken: 'spawn ENOENT' }
  const brokenRow = find(app.el('settings-body'), (n) => n.dataset?.name === 'broken')
  check('MCP 页给每一行挂上了服务器名', brokenRow !== null)
  const toggle = brokenRow.children[0]
  check('没连上的服务器开关是关的', toggle.checked === false, String(toggle.checked))
  toggle.checked = true
  toggle.fire('change')
  await tick()
  const mcpNotices = textOf(app.el('notices'))
  check('MCP 开关失败时报错而不是报成功', mcpNotices.includes('spawn ENOENT'), mcpNotices)
  check('报错里点名了是哪台', mcpNotices.includes('broken'), mcpNotices)
  const after = find(app.el('settings-body'), (n) => n.dataset?.name === 'broken').children[0]
  check('失败后开关回到真实状态（没接上就不该是开的）', after.checked === false, String(after.checked))

  // 切回会话视图：三栏布局塌了的话，这里能抓到「视图藏反了」
  app.el('nav-sessions').click()
  await tick()
  check('切回会话视图', app.el('app').dataset.view === 'sessions', app.el('app').dataset.view)
  check('切回后对话区回来了', app.el('view-sessions').hidden === false)
  check('切回后设置容器藏起来了', app.el('view-settings').hidden === true)
  check('切回后消息流还在', app.el('stream').children.length === 1, String(app.el('stream').children.length))

  uninstallDom()
}

// 「Electron 只活在 desktop/ 里」是这次改动最容易被无声破坏的架构约束：某天有人在
// src/runtime 里顺手 `import { app } from 'electron'`，本地能跑、测试全绿，只有真正
// 打包或换外壳时才炸。把约束写成断言，破坏它的那一刻就红。
console.log('\n== 自检：Electron 不许漏进运行时 ==')
{
  const root = fileURLToPath(new URL('../', import.meta.url))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

  const RUNTIME_DEPS = ['@modelcontextprotocol/client', 'commander', 'dotenv', 'openai']
  check(
    '运行时依赖恒为那 4 个',
    JSON.stringify(Object.keys(pkg.dependencies).sort()) === JSON.stringify([...RUNTIME_DEPS].sort()),
    JSON.stringify(Object.keys(pkg.dependencies).sort()),
  )
  check(
    'electron 只在 devDependencies（用户 npm i -g 时不该拖下来几百兆）',
    !('electron' in pkg.dependencies) && 'electron' in pkg.devDependencies,
    JSON.stringify(pkg.dependencies),
  )
  check('main 字段仍指着 CLI（改了会破坏 bin）', pkg.main === './dist/index.js', pkg.main)

  const jsFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) jsFiles.push(full)
    }
  }
  walk(path.join(root, 'dist'))

  const ELECTRON_REF = /(?:from|require\()\s*['"]electron['"]/
  const leaked = jsFiles.filter((f) => ELECTRON_REF.test(fs.readFileSync(f, 'utf8')))
  check('dist 里没有任何一个文件引用 electron', leaked.length === 0, leaked.join(', '))
  check('dist 确实扫到了文件（否则上一条是白验的）', jsFiles.length > 20, String(jsFiles.length))

  // 渲染层那两个模块要能在没有 DOM 的 Node 里被 import（上面已经 import 过了），
  // 但那条路是「炸了就整份测试挂掉」。再补一道源码级的护栏，added-by-hand 的 DOM 代码
  // 在评审时就能被看见，而不是等到某天在 Node 里跑测试才炸
  const DOM_USE = /\bdocument\s*\.|\bwindow\s*\./
  for (const name of ['state.js', 'markdown.js']) {
    const src = fs.readFileSync(path.join(root, 'desktop', 'renderer', name), 'utf8')
    check(`${name} 是纯逻辑，不碰 DOM`, !DOM_USE.test(src), (DOM_USE.exec(src) ?? [''])[0])
  }

  // app.js 只能靠人工点窗口验，但「它要的元素在不在 HTML 里」不用点窗口就能查。
  // 改了 id 忘了同步两边的话，`getElementById` 返回 null，启动时第一个 addEventListener
  // 就抛 TypeError —— 窗口一片空白、控制台里一行红字，看着像整个渲染层都没生效。
  const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')
  const appJs = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
  const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const idsWanted = [...appJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
  const missingIds = idsWanted.filter((id) => !idsInHtml.has(id))
  check('app.js 绑的每个 id 在 index.html 里都存在', missingIds.length === 0, missingIds.join(', '))
  check('确实绑到了一批 id（否则上一条是白验的）', idsWanted.length >= 10, String(idsWanted.length))

  // 通知栏不能待在侧栏里。侧栏在模型/技能/MCP 三个设置视图下是 `display: none`，
  // 于是「MCP 开关接不上」这种恰好发生在设置页上的报错，会死在引发它的那一页上，
  // 一个字都看不到 —— 而这正是当初把通道改成 `{ok:false, reason}` 要解决的事。
  // 纯结构断言，不点窗口就能查。
  const sidebar = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf('</aside>'))
  check(
    '通知栏不在侧栏里（否则设置页上看不见报错）',
    !sidebar.includes('id="notices"'),
    sidebar.slice(0, 80),
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
