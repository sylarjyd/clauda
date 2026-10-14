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

// **入口就把 home 指到临时目录**：会话落盘（`persist.ts`）与记忆库都挂在 CLAUDA_HOME
// 下，而下面一百多个检查块里只有一部分记得覆盖它 —— 漏掉的那几块会往用户真实的
// `~/.clauda/` 里写会话文件。症状不显眼但很脏：每跑一次测试就多一个以临时 cwd 命名的
// 孤儿项目目录（那台机器上攒了一百多个），而且桌面端启动时会恢复到那个**早已被删掉**
// 的临时目录上。
//
// 用「哪个块忘了」的角度去补是治标的，新加一块忘了写就复发；在入口兜底才是治本的。
// 需要验「没设 CLAUDA_HOME 时会怎样」的用例自己 delete 它（见下面的厂商回退那一段）。
process.env.CLAUDA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-unit-home-'))
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
    const { writeProjectProvider, configPath } = await import(`${dist}config.js`)
    const file = configPath(proj)
    process.env.CLAUDA_WRITE_KEY = 'sk-super-secret'
    writeCfg(path.join(proj, '.clauda'), {
      provider: { apiKey: '${CLAUDA_WRITE_KEY}', model: 'old' },
      permissions: { mode: 'auto', allow: [], deny: [] },
    })
    const written = writeProjectProvider(proj, { model: 'new-model' })
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
      writeProjectProvider(proj, { model: 'y' })
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
  const {
    loadConfig,
    writeProjectProvider,
    writeProjectProfile,
    writeActiveProfile,
    removeProjectProfile,
    writeDefaultAgent,
    configPath,
    writeConfigTemplate,
  } = await import(`${dist}config.js`)
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
    const onDisk = JSON.parse(fs.readFileSync(written, 'utf8'))
    const disk = fs.readFileSync(written, 'utf8')
    check('写回落在项目配置文件上', written === file, written)
    check('地址与模型同时写进去了', loadConfig(proj).provider.baseUrl === ds.baseUrl && loadConfig(proj).provider.model === ds.models[0])
    check('写回保留 ${VAR} 引用，没把密钥明文落盘', disk.includes('${CLAUDA_VENDOR_KEY}'), disk)
    check('写回没把明文密钥写进磁盘', !disk.includes('sk-super-secret'), disk)
    // 老文件（端点还住在 `provider` 段里）第一次落笔会被**原样搬**进一份档案，段里只留传输旋钮
    const key = onDisk.activeProvider
    check('第一次落笔把端点字段搬进了档案', typeof key === 'string' && !!onDisk.profiles?.[key], disk)
    check('搬完段里只剩传输旋钮（没有 baseUrl/model 了）', onDisk.provider.baseUrl === undefined && onDisk.provider.model === undefined, JSON.stringify(onDisk.provider))
    check('搬的时候是整条搬的（temperature 也跟过去了）', onDisk.profiles[key].temperature === 7, disk)
    check('写回不碰别的段落', onDisk.permissions.mode === 'auto', disk)
    check('写回不碰 mcpServers', !!onDisk.mcpServers?.demo, disk)
    delete process.env.CLAUDA_VENDOR_KEY

    // 没给的键一个都不能碰 —— `{ model: undefined }` 展开进去会把磁盘上原有的抹掉
    const before = fs.readFileSync(file, 'utf8')
    writeProjectProvider(proj, { baseUrl: 'https://api.deepseek.com/v1' })
    check('只给地址时不碰模型', JSON.parse(fs.readFileSync(file, 'utf8')).profiles[key].model === ds.models[0], before)

    // 只给模型时同理，一条薄封装，性质一条不少
    const onlyModel = JSON.parse(fs.readFileSync(writeProjectProvider(proj, { model: 'some-model' }), 'utf8'))
    check('只给模型时不碰地址', onlyModel.profiles[key].model === 'some-model' && onlyModel.profiles[key].baseUrl === 'https://api.deepseek.com/v1', JSON.stringify(onlyModel.profiles[key]))
    check('改完还是那份档案在用', onlyModel.activeProvider === key, String(onlyModel.activeProvider))

    // ---- 多厂商：加一份 / 切当前 / 删一份
    // 「添加一份」**绝不改当前厂商** —— 会改的话「同时配好几家」就不成立了
    writeProjectProfile(proj, 'kimi', { baseUrl: 'https://api.moonshot.cn/v1', apiKey: '${KIMI_KEY}', model: 'kimi-k2.6' }, key)
    const added = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('新档案写进去了', added.profiles.kimi?.model === 'kimi-k2.6', JSON.stringify(added.profiles))
    check('加一份档案不会顺手换掉当前那份', added.activeProvider === key, String(added.activeProvider))
    check('两份档案并存，老那份一个字没动', added.profiles[key].baseUrl === 'https://api.deepseek.com/v1', JSON.stringify(added.profiles[key]))
    check('新档案的 ${VAR} 也原样保留', JSON.stringify(added.profiles.kimi).includes('${KIMI_KEY}'), JSON.stringify(added.profiles.kimi))
    check('新档案能解析出来，且不继承老那份的地址', loadConfig(proj).profiles.kimi.baseUrl === 'https://api.moonshot.cn/v1', loadConfig(proj).profiles.kimi.baseUrl)
    // 继承过来的症状是「切到 B 家，发出去的却是 A 家的 key」—— 拿两份的 key 直接比，
    // 不去假设开发机上有没有挂着 MOONSHOT_API_KEY
    check(
      '新档案不继承老那份的密钥',
      loadConfig(proj).profiles.kimi.apiKey !== loadConfig(proj).profiles[key].apiKey,
      `${loadConfig(proj).profiles.kimi.apiKey} vs ${loadConfig(proj).profiles[key].apiKey}`,
    )
    check('当前那份仍是老的，没被新档案顶掉', loadConfig(proj).provider.baseUrl === 'https://api.deepseek.com/v1', loadConfig(proj).provider.baseUrl)

    writeActiveProfile(proj, 'kimi')
    check('切当前之后解析出的是新那份', loadConfig(proj).provider.baseUrl === 'https://api.moonshot.cn/v1', loadConfig(proj).provider.baseUrl)
    check('切当前不搬家端点字段（档案本来就是它的）', JSON.parse(fs.readFileSync(file, 'utf8')).profiles[key].baseUrl === 'https://api.deepseek.com/v1')
    check('切完 activeProvider 落在磁盘上', JSON.parse(fs.readFileSync(file, 'utf8')).activeProvider === 'kimi')

    removeProjectProfile(proj, key)
    const afterRemove = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('删掉的那份不在文件里了', afterRemove.profiles[key] === undefined, JSON.stringify(afterRemove.profiles))
    check('删一份不碰别的那份', afterRemove.profiles.kimi?.model === 'kimi-k2.6', JSON.stringify(afterRemove.profiles))
    check('删完剩下的照旧解析得出来', loadConfig(proj).provider.baseUrl === 'https://api.moonshot.cn/v1', loadConfig(proj).provider.baseUrl)

    // ---- 本项目默认智能体：一个顶层键，只动它
    const beforeDefault = JSON.parse(fs.readFileSync(file, 'utf8'))
    writeDefaultAgent(proj, 'code-review')
    const withDefault = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('默认智能体写在项目配置里', withDefault.defaultAgent === 'code-review', JSON.stringify(withDefault))
    check(
      '只多出这一个键，别的一个字没动',
      JSON.stringify({ ...withDefault, defaultAgent: undefined }) === JSON.stringify(beforeDefault),
      JSON.stringify(withDefault),
    )
    check('写它不会把 ${VAR} 换成明文', withDefault.profiles.kimi.apiKey === '${KIMI_KEY}', withDefault.profiles.kimi.apiKey)
    check('名字能解析回来（空串 = 没设）', loadConfig(proj).defaultAgent === 'code-review')

    // merge() 的浅合并陷阱：项目配置里只要出现这一个键，全局那几段就不能被整张顶掉
    const homeCfg = path.join(home, 'config.json')
    fs.writeFileSync(
      homeCfg,
      JSON.stringify({
        profiles: { globalp: { baseUrl: 'https://g/v1', model: 'g-model' } },
        activeProvider: 'globalp',
        mcpServers: { gmcp: { command: 'x' } },
      }),
      'utf8',
    )
    writeCfg(path.join(proj, '.clauda'), { defaultAgent: 'code-review' })
    const merged = loadConfig(proj)
    check(
      '项目里只写 defaultAgent 时，全局的档案 / 当前档案 / MCP 都还在',
      !!merged.profiles.globalp && merged.activeProvider === 'globalp' && !!merged.mcpServers?.gmcp && merged.defaultAgent === 'code-review',
      JSON.stringify({ profiles: Object.keys(merged.profiles), active: merged.activeProvider, mcp: Object.keys(merged.mcpServers ?? {}), d: merged.defaultAgent }),
    )
    fs.rmSync(homeCfg, { force: true }) // 后面的环境变量回退用例不能被这份全局配置搅了

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
    const tplObj = JSON.parse(tplText)
    check(
      '配置模板的地址与模型来自预置表',
      tplObj.profiles?.deepseek?.baseUrl === ds.baseUrl && tplObj.profiles?.deepseek?.model === ds.models[0],
      tplText,
    )
    // 模板必须自带 activeProvider：少了它，用户第一次打开就会落在「文件里第一个档案」上
    check('模板声明了当前用的是哪一份', tplObj.activeProvider === 'deepseek', String(tplObj.activeProvider))
    check('模板不往里塞明文密钥', !/sk-[a-zA-Z0-9]{8,}/.test(tplText), tplText)
    check('模板能原样解析出预置地址', loadConfig(proj).provider.baseUrl === ds.baseUrl, loadConfig(proj).provider.baseUrl)
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

// ------------------------------------------------ 子进程输出的编码嗅探

console.log('\n== 子进程输出的编码嗅探 ==')
{
  const { ConsoleDecoder, sniffBytes } = await import(`${dist}util/console-decoder.js`)

  // 夹具是这台中文 Windows 上真抓的字节：`chcp` 和 `certutil` 的输出（控制台代码页 936）。
  // 别用 Buffer.from(中文, 'gbk') 造 —— Node 不认 'gbk' 这个标签，会静默按 UTF-8 编，
  // 于是夹具本身是 UTF-8，测试就变成在验一个不存在的场景
  const chcpOut = Buffer.from('bbeeb6afb4fac2ebd2b33a203933360d0a', 'hex') // 活动代码页: 936\r\n
  const certTail = Buffer.from('c3fcc1eeb3c9b9a6cdeab3c9a1a3', 'hex') // 命令成功完成。
  const gbkCn = Buffer.from('d6d0cec4b2e2cad4', 'hex') // 中文测试
  const utf8Cn = Buffer.from('中文测试', 'utf8')

  const run = (chunks, platform = 'win32') => {
    const d = new ConsoleDecoder(platform)
    let out = ''
    for (const c of chunks) out += d.push(c)
    return out + d.flush()
  }

  const first = new ConsoleDecoder('win32')
  check('纯 ASCII 的块立刻出字（流式没被压住）', first.push(Buffer.from('hello ')) === 'hello ')
  check('ASCII 之后接着来 ASCII 也不会压住', first.push(Buffer.from('world')) === 'world')

  check('整块 GBK 解成中文', run([chcpOut]) === '活动代码页: 936\r\n', JSON.stringify(run([chcpOut])))
  check(
    '开头的 ASCII 前缀不会把编码锁死',
    run([Buffer.from('MD5 '), certTail]) === 'MD5 命令成功完成。',
    JSON.stringify(run([Buffer.from('MD5 '), certTail])),
  )

  // 下面三条盯的是同一件事：**块边界切在多字节字符中间**时不能急着定调
  check('GBK 被切成两块也能拼回来', run([gbkCn.subarray(0, 3), gbkCn.subarray(3)]) === '中文测试')
  check(
    'GBK 汉字被切成两个单字节块也能拼回来',
    run([gbkCn.subarray(0, 1), gbkCn.subarray(1, 2), gbkCn.subarray(2)]) === '中文测试',
    JSON.stringify(run([gbkCn.subarray(0, 1), gbkCn.subarray(1, 2), gbkCn.subarray(2)])),
  )
  // 这条是最容易写错的一处：UTF-8 的中文被切在字符中间时同样「解不通」，把它当成
  // GB18030 的证据就会让**每一个**被切开的汉字变成一个错字 —— 也就是又一种乱码
  check(
    'UTF-8 中文被切在字符中间，不会误判成 GB18030',
    run([utf8Cn.subarray(0, 1), utf8Cn.subarray(1, 2), utf8Cn.subarray(2)]) === '中文测试',
    JSON.stringify(run([utf8Cn.subarray(0, 1), utf8Cn.subarray(1, 2), utf8Cn.subarray(2)])),
  )
  check('UTF-8 中文整块原样通过', run([utf8Cn]) === '中文测试')

  check('定调之后后续块不再重新判定', run([gbkCn, Buffer.from(' tail')]) === '中文测试 tail')

  // 非 Windows 不嗅探：同样的字节在那里只当 UTF-8。这是刻意的，不给 macOS / Linux
  // 引入一份没有收益、只有误判风险的逻辑
  check(
    '非 Windows 平台不走嗅探（GBK 字节照旧解不出来）',
    run([gbkCn], 'linux').includes('�'),
    JSON.stringify(run([gbkCn], 'linux')),
  )

  check(
    'sniffBytes 的三种结论各就各位',
    sniffBytes(utf8Cn) === 'utf-8' &&
      sniffBytes(gbkCn) === 'gb18030' &&
      sniffBytes(utf8Cn.subarray(0, 2)) === 'incomplete',
    [sniffBytes(utf8Cn), sniffBytes(gbkCn), sniffBytes(utf8Cn.subarray(0, 2))].join(' / '),
  )
}

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

// 技能的写路径：设置页的新增表单和对话里的 skill_write 都走它
{
  const { writeSkill, removeSkill, skillRoot } = await import(`${dist}skills/writer.js`)
  const { makeSkillWriteTool, makeSkillRemoveTool } = await import(`${dist}tools/skill.js`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-skillwrite-'))
  const proj = path.join(home, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = path.join(home, 'clauda')

  const made = writeSkill({ scope: 'project', cwd: proj, name: 'weekly-report', description: '每周汇总', body: '第一步…' })
  check('写到了项目自己的 .clauda/skills 下', made.file === path.join(proj, '.clauda', 'skills', 'weekly-report', 'SKILL.md'), made.file)
  check('首次写入报告为新建', made.created === true)
  const text = fs.readFileSync(made.file, 'utf8')
  check('文件是 frontmatter + 正文', text.startsWith('---\nname: weekly-report\ndescription: 每周汇总\n---\n'), JSON.stringify(text))
  check('正文写进去了', text.includes('第一步…'))
  // 说明里带换行会把单行 frontmatter 撑破，压平是必须的（同 writeMemory）
  const flat = writeSkill({ scope: 'global', cwd: proj, name: 'multi-line', description: '第一行\n第二行', body: 'x' })
  check('说明里的换行被压平', fs.readFileSync(flat.file, 'utf8').includes('description: 第一行 第二行'))
  check('同名的第二次写入报告为覆盖', writeSkill({ scope: 'global', cwd: proj, name: 'multi-line', description: '改了', body: 'y' }).created === false)
  check('global 落在 CLAUDA_HOME 下', flat.file.startsWith(skillRoot('global', proj)), flat.file)

  // 名字不合法要当场抛，**绝不静默改名** —— 界面上的名字和目录名对不上最难查
  const bad = await catchErr(() => writeSkill({ scope: 'project', cwd: proj, name: '中文名', description: '', body: '' }))
  check('名字不合规时抛人话错误', /不合规/.test(bad.error ?? ''), bad.error)
  const bad2 = await catchErr(() => writeSkill({ scope: 'project', cwd: proj, name: '-lead', description: '', body: '' }))
  check('短横线不能打头', bad2.error !== null, String(bad2.error))

  // 注册表得能看见刚写的那个：不重扫的话它永远停在打开项目那一刻的名单上
  const reg = SkillRegistry.discover(proj)
  check('刚写的技能立刻能被发现', reg.has('weekly-report'), JSON.stringify(reg.list().map((s) => s.name)))
  writeSkill({ scope: 'project', cwd: proj, name: 'brand-new', description: '刚加的', body: '正文' })
  check('重扫之前看不见', !reg.has('brand-new'))
  reg.refresh()
  check('refresh() 之后看见了', reg.has('brand-new'), JSON.stringify(reg.list().map((s) => s.name)))
  check('refresh 认得出刚写的那条正文', reg.read('brand-new') === '正文', JSON.stringify(reg.read('brand-new')))

  // 删技能的两条护栏：少了任何一条，一个手滑的入参就能递归删掉任意目录
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-notaskill-'))
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'x', 'utf8')
  const stray = await catchErr(() => removeSkill(path.join(outside, 'SKILL.md')))
  check('不在 skills 目录下的拒删', /拒绝删除/.test(stray.error ?? ''), stray.error)
  const noFile = path.join(proj, '.clauda', 'skills', 'empty-dir')
  fs.mkdirSync(noFile, { recursive: true })
  const noMd = await catchErr(() => removeSkill(path.join(noFile, 'SKILL.md')))
  check('目录里没有 SKILL.md 的拒删', /拒绝删除/.test(noMd.error ?? ''), noMd.error)
  check('拒删之后目录还在', fs.existsSync(noFile))

  const meta = reg.get('weekly-report')
  const gone = removeSkill(meta.file)
  check('删技能删的是整个目录', gone === path.dirname(meta.file) && !fs.existsSync(meta.file))
  reg.refresh()
  check('删完重扫就看不见了', !reg.has('weekly-report'))

  // ---- 对话里的两个技能工具
  const empty = SkillRegistry.discover(proj)
  const writeTool = makeSkillWriteTool(empty, { cwd: proj })
  const removeTool = makeSkillRemoveTool(empty)
  check('skill_write 是写权限（会落一个文件到磁盘上）', writeTool.permission === 'write', writeTool.permission)
  check('skill_remove 同样是写权限', removeTool.permission === 'write', removeTool.permission)
  // 写完要当轮可见：提示词里的「## 可用技能」和工具集都得跟着变
  check('skill_write 声明会改写提示词', writeTool.invalidatesPrompt === true)
  check('skill_write 声明工具集会变（第一个技能要能当场用上）', writeTool.invalidatesTools === true)
  check('skill_remove 两条都声明了', removeTool.invalidatesPrompt === true && removeTool.invalidatesTools === true)
  check('两个工具都标了技能来源', writeTool.source?.kind === 'skill' && removeTool.source?.kind === 'skill')

  // agent 默认写**项目**：用户填表时眼在看「范围」，agent 是趁人不在动手
  await writeTool.run({ name: 'from-dialog', description: '对话里建的', body: '正文' }, ctx())
  check(
    '不写 scope 时落进本项目（不是全局）',
    fs.existsSync(path.join(proj, '.clauda', 'skills', 'from-dialog', 'SKILL.md')),
    JSON.stringify(fs.readdirSync(path.join(proj, '.clauda', 'skills'))),
  )
  check('工具自己重扫了注册表（当轮就能用）', empty.has('from-dialog'))
  const out = await removeTool.run({ name: 'from-dialog' }, ctx())
  check('skill_remove 删掉了它', !empty.has('from-dialog'))
  check('删完的说法里带名字', out.includes('from-dialog'), out)
  const unknownSkill = await catchErr(() => removeTool.run({ name: 'never-existed' }, ctx()))
  check('删不存在的技能会抛，并列出可用的', /不存在名为/.test(unknownSkill.error ?? ''), unknownSkill.error)

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 智能体
// 智能体 = 一整套装配配方（人格 + 模型 + 工具/技能白名单 + 权限 + 空态问题），
// 存成「目录 + AGENT.md」，frontmatter 是标量配置、**正文就是系统提示词**。
// 这里只测纯模块：解析 / 写盘 / 过滤。装配与恢复要开会话，在后面那几组里测。
console.log('\n== 智能体 ==')
{
  const { AgentRegistry, AGENT_FILENAME } = await import(`${dist}agents/registry.js`)
  const { writeAgent, removeAgent } = await import(`${dist}agents/writer.js`)
  const { applyAgentToConfig, agentAllowsTool, scopedSkills, toSpec, readAgentSpec } = await import(
    `${dist}agents/apply.js`
  )

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-agents-'))
  const proj = path.join(home, 'work', 'proj')
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = path.join(home, 'clauda')
  fs.mkdirSync(proj, { recursive: true })

  const put = (root, dirName, content) => {
    const d = path.join(root, dirName)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, AGENT_FILENAME), content, 'utf8')
  }

  // ---- 解析
  put(
    path.join(proj, '.clauda', 'agents'),
    'full',
    [
      '---',
      'name: full',
      'description: 全都写了',
      'profile: deepseek',
      'model: Qwen/Qwen3-32B',
      'temperature: 0',
      'permission: plan',
      'allow: write_file, read_file',
      'deny: bash',
      'tools: read_file, grep, glob, mcp__linear',
      'skills: code-review',
      'questions: 这次改动有什么风险，要重点看哪几个文件？|测试怎么跑',
      '---',
      '',
      '你是一名严格的代码审查员。',
    ].join('\n'),
  )

  const reg = AgentRegistry.discover(proj)
  const full = reg.get('full')
  check(
    'frontmatter 的标量字段都解析出来了',
    full?.description === '全都写了' &&
      full?.profile === 'deepseek' &&
      full?.permission === 'plan' &&
      full?.temperature === 0,
    JSON.stringify(full),
  )
  check('模型 id 里的斜杠原样保留', full?.model === 'Qwen/Qwen3-32B', full?.model)
  check(
    'tools 按逗号分',
    JSON.stringify(full?.tools) === JSON.stringify(['read_file', 'grep', 'glob', 'mcp__linear']),
    JSON.stringify(full?.tools),
  )
  check('allow / deny 各自成列', JSON.stringify(full?.allow) === '["write_file","read_file"]' && full?.deny?.[0] === 'bash')
  check(
    'questions 按竖线分，且问题里的逗号不被切开',
    full?.questions.length === 2 && full.questions[0].includes('，'),
    JSON.stringify(full?.questions),
  )
  check('resolve() 带回正文', reg.resolve('full')?.body === '你是一名严格的代码审查员。', reg.resolve('full')?.body)

  // ---- 提示词：正文进得去、位置对、没有智能体时不占位
  const { buildSystemPrompt: buildPrompt } = await import(`${dist}agent/system-prompt.js`)
  const withAgent = buildPrompt({
    cwd: proj,
    config: agentConfig(),
    mode: 'default',
    agent: { name: 'full', prompt: '你是一名严格的代码审查员。' },
  })
  const iAgent = withAgent.indexOf('## 智能体：full')
  const iMem = withAgent.indexOf('## 项目记忆')
  const iCfg = withAgent.indexOf('## 会话配置')
  check('智能体的正文进了系统提示词', iAgent >= 0 && withAgent.includes('你是一名严格的代码审查员。'))
  check(
    '插在项目记忆之前，且项目记忆仍紧邻会话配置（/memory 靠这两个标题切片）',
    iAgent >= 0 && iAgent < iMem && iMem < iCfg,
    `智能体=${iAgent} 记忆=${iMem} 配置=${iCfg}`,
  )
  const noAgent = buildPrompt({ cwd: proj, config: agentConfig(), mode: 'default' })
  check('没有智能体时不输出这一段', !noAgent.includes('## 智能体'))
  check(
    '正文为空的智能体也不留一个空标题',
    !buildPrompt({ cwd: proj, config: agentConfig(), mode: 'default', agent: { name: 'x', prompt: '  \n ' } }).includes('## 智能体'),
  )

  // 校验的取向和技能一致：能退回默认的就退回并继续，不能退的才丢
  const badDir = path.join(proj, '.clauda', 'agents')
  put(badDir, 'bad-name', '---\nname: 中文 名字\ndescription: 名字不合规\n---\n正文')
  put(badDir, '中文目录', '---\ndescription: 连目录名都不合规\n---\n正文')
  put(badDir, 'hot', '---\nname: hot\ntemperature: 5\n---\n正文')
  put(badDir, 'texty', '---\nname: texty\ntemperature: 热\n---\n正文')
  put(badDir, 'weird-perm', '---\nname: weird-perm\npermission: yolo\n---\n正文')
  const reg2 = AgentRegistry.discover(proj)
  check('名字不合规时退回目录名', reg2.has('bad-name') && !reg2.has('中文 名字'), JSON.stringify(reg2.list().map((a) => a.name)))
  check('目录名也不合规时整条丢掉', !reg2.list().some((a) => a.dir.endsWith('中文目录')))
  check('温度越界只忽略这一项，智能体还在', reg2.has('hot') && reg2.get('hot').temperature === undefined)
  check('温度不是数字同样只忽略这一项', reg2.has('texty') && reg2.get('texty').temperature === undefined)
  check('permission 不在三值里时忽略', reg2.has('weird-perm') && reg2.get('weird-perm').permission === undefined)

  // 发现顺序：全局 < 中间层 < 项目，离 cwd 越近越优先（同技能）
  put(path.join(home, 'clauda', 'agents'), 'shared', '---\nname: shared\ndescription: 全局版本\n---\n全局正文')
  put(path.join(home, 'work', '.clauda', 'agents'), 'shared', '---\nname: shared\ndescription: 中间层版本\n---\n中间层正文')
  put(badDir, 'shared', '---\nname: shared\ndescription: 项目版本\n---\n项目正文')
  put(path.join(home, 'clauda', 'agents'), 'only-global', '---\nname: only-global\ndescription: 只在全局\n---\n正文')
  const reg3 = AgentRegistry.discover(proj)
  check('离 cwd 最近的项目智能体压过中间层和全局', reg3.get('shared')?.description === '项目版本', reg3.get('shared')?.description)
  check('scope 记得住它来自哪一层', reg3.get('shared')?.scope === 'project' && reg3.get('only-global')?.scope === 'global')
  check('全局独有的仍可见', reg3.has('only-global'))

  // ---- 写盘
  const input = {
    scope: 'project',
    cwd: proj,
    name: 'round-trip',
    description: '往返一遍',
    body: '正文：先看结论。',
    profile: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0,
    permission: 'default',
    allow: ['write_file'],
    deny: ['bash'],
    tools: ['read_file', 'grep'],
    skills: ['code-review'],
    questions: ['这次改动有什么风险', '测试怎么跑'],
  }
  const made = writeAgent(input)
  check(
    '写到了项目自己的 .clauda/agents/<name>/AGENT.md',
    made.file === path.join(proj, '.clauda', 'agents', 'round-trip', AGENT_FILENAME),
    made.file,
  )
  check('首次写入报告为新建', made.created === true)
  check('同名的第二次写入报告为覆盖', writeAgent(input).created === false)

  const back = AgentRegistry.discover(proj).resolve('round-trip')
  check(
    'round-trip：标量原样回来（温度 0 没被当成「没写」）',
    !!back &&
      back.name === input.name &&
      back.description === input.description &&
      back.profile === input.profile &&
      back.model === input.model &&
      back.temperature === 0 &&
      back.permission === input.permission,
    JSON.stringify(back),
  )
  check(
    'round-trip：五个列表原样回来',
    !!back &&
      JSON.stringify([back.allow, back.deny, back.tools, back.skills, back.questions]) ===
        JSON.stringify([input.allow, input.deny, input.tools, input.skills, input.questions]),
    JSON.stringify(back && [back.allow, back.deny, back.tools, back.skills, back.questions]),
  )
  check('round-trip：正文原样回来', back?.body === input.body, JSON.stringify(back?.body))

  // 没给的键一个字都不许写：`temperature:` 那一行读回来是「写了 0」的意思，会把档案的温度钉死
  const minimal = writeAgent({ scope: 'project', cwd: proj, name: 'minimal', description: '只有必填', body: '正文' })
  const minimalText = fs.readFileSync(minimal.file, 'utf8')
  check(
    '只写给出过的键',
    !/^(temperature|profile|model|permission|allow|deny|tools|skills|questions):/m.test(minimalText),
    JSON.stringify(minimalText),
  )
  check('没写 description 时列表里拿正文第一句兜底', AgentRegistry.discover(proj).get('minimal')?.description === '只有必填')

  // 换行撑破 frontmatter / 竖线切碎一条问题，两个坑都在 writer 里堵住
  const flat = writeAgent({
    scope: 'project',
    cwd: proj,
    name: 'flat',
    description: '第一行\n第二行',
    body: '正文',
    questions: ['A | B 选哪个？'],
  })
  const flatText = fs.readFileSync(flat.file, 'utf8')
  check('说明里的换行被压平', flatText.includes('description: 第一行 第二行'), JSON.stringify(flatText))
  check(
    '问题里的竖线被换成全角，读回来还是一条',
    AgentRegistry.discover(proj).get('flat')?.questions.length === 1 &&
      AgentRegistry.discover(proj).get('flat').questions[0] === 'A ｜ B 选哪个？',
    JSON.stringify(AgentRegistry.discover(proj).get('flat')?.questions),
  )
  // 正文里写这两个标题会让 /memory 打印一堆垃圾（它按标题切片，切的是第一处）
  const clash = await catchErr(() =>
    writeAgent({ scope: 'project', cwd: proj, name: 'clash', description: '', body: '## 会话配置\n\n乱写' }),
  )
  check('正文里出现内部标题时当场拒收', /会话配置/.test(clash.error ?? ''), clash.error)

  const badName = await catchErr(() => writeAgent({ scope: 'project', cwd: proj, name: '中文名', description: '', body: '' }))
  check('名字不合规当场抛人话错误，绝不静默改名', /不合规/.test(badName.error ?? ''), badName.error)

  // 两条护栏：少了任何一条，一个手滑的入参就能递归删掉任意目录
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-notanagent-'))
  fs.writeFileSync(path.join(outside, AGENT_FILENAME), 'x', 'utf8')
  const stray = await catchErr(() => removeAgent(path.join(outside, AGENT_FILENAME)))
  check('不在 agents 目录下的拒删', /拒绝删除/.test(stray.error ?? ''), stray.error)
  const emptyDir = path.join(proj, '.clauda', 'agents', 'empty-dir')
  fs.mkdirSync(emptyDir, { recursive: true })
  const noMd = await catchErr(() => removeAgent(path.join(emptyDir, AGENT_FILENAME)))
  check('目录里没有 AGENT.md 的拒删', /拒绝删除/.test(noMd.error ?? ''), noMd.error)
  check('拒删之后目录还在', fs.existsSync(emptyDir))
  check('删智能体删的是整个目录', removeAgent(minimal.file) === path.dirname(minimal.file) && !fs.existsSync(minimal.file))

  // ---- 过滤
  const a = { tools: ['read_file', 'mcp__linear'] }
  check('白名单为空 = 全都不限制', agentAllowsTool({ tools: [] }, 'bash') && agentAllowsTool({}, 'bash'))
  check('名单里的放行，名单外的挡住', agentAllowsTool(a, 'read_file') && agentAllowsTool(a, 'bash') === false)
  check('mcp__linear 盖住整台服务器', agentAllowsTool(a, 'mcp__linear__create_issue'))
  check('别的服务器的工具仍被挡住', agentAllowsTool(a, 'mcp__other__x') === false)
  check(
    '白名单连 extraTools 一起挡（skill_write / memory_* / mcp_add 都进不来）',
    agentAllowsTool(a, 'skill_write') === false &&
      agentAllowsTool(a, 'memory_write') === false &&
      agentAllowsTool(a, 'mcp_add') === false,
  )
  check('两边都过别名归一，Read 和 read_file 是同一个', agentAllowsTool({ tools: ['Read'] }, 'read_file'))

  const skillMeta = (n) => ({ name: n, description: n, dir: `/x/${n}`, file: `/x/${n}/SKILL.md` })
  const fakeRegistry = {
    list: () => ['a', 'b'].map(skillMeta),
    get: (n) => (n === 'a' || n === 'b' ? skillMeta(n) : undefined),
    has: (n) => n === 'a' || n === 'b',
    read: (n) => (n === 'a' ? 'A正文' : n === 'b' ? 'B正文' : null),
  }
  const view = scopedSkills(fakeRegistry, { skills: ['a'] })
  check('技能视图只露白名单里的', view.list().map((s) => s.name).join(',') === 'a')
  check('拿别人家的技能读不到', view.read('b') === null && view.read('a') === 'A正文')
  check('视图是委托：真注册表刷新后它自动跟着变', scopedSkills(fakeRegistry, { skills: ['a'] }).has('b') === false)
  check(
    '白名单为空时不收窄（原样返回真注册表）',
    scopedSkills(fakeRegistry, { skills: [] }) === fakeRegistry && scopedSkills(fakeRegistry, undefined) === fakeRegistry,
  )

  // ---- 折进会话配置：逐键各管各的
  const cfg = () => ({
    provider: { baseUrl: 'http://now/v1', apiKey: 'now', model: 'now-model', temperature: 0.7, maxTokens: 100 },
    profiles: {
      deepseek: { baseUrl: 'http://ds/v1', apiKey: 'sk-ds', model: 'deepseek-chat', temperature: 1, maxTokens: 4096 },
    },
    permissions: { mode: 'auto', allow: ['x'], deny: ['y'] },
  })
  const c1 = cfg()
  applyAgentToConfig(c1, { name: 'g', prompt: 'p', profile: 'deepseek' })
  check(
    '档案换掉了端点与密钥',
    c1.provider.baseUrl === 'http://ds/v1' && c1.provider.apiKey === 'sk-ds' && c1.provider.model === 'deepseek-chat',
    JSON.stringify(c1.provider),
  )
  check('没写的键一律沿用', c1.permissions.mode === 'auto' && JSON.stringify(c1.permissions.allow) === '["x"]')

  const c2 = cfg()
  applyAgentToConfig(c2, { name: 'g', prompt: 'p', model: 'm2', temperature: 0, permission: 'plan', allow: [], deny: ['bash'] })
  check('写了的键盖上，温度写 0 也算写了', c2.provider.model === 'm2' && c2.provider.temperature === 0, String(c2.provider.temperature))
  check(
    'permission / allow / deny 覆盖，空数组是「显式清空」',
    c2.permissions.mode === 'plan' && c2.permissions.allow.length === 0 && c2.permissions.deny[0] === 'bash',
    JSON.stringify(c2.permissions),
  )

  const c3 = cfg()
  applyAgentToConfig(c3, { name: 'g', prompt: 'p', profile: 'nope' })
  check('档案找不到时端点原封不动（由界面标降级提示）', c3.provider.baseUrl === 'http://now/v1', c3.provider.baseUrl)

  // ---- 冻结快照的形状：随会话落盘，坏数据降级不崩
  const spec = toSpec({ ...reg3.get('full'), ...AgentRegistry.discover(proj).resolve('full') })
  check(
    'toSpec 搬的是装配要用的字段，不带 dir/file/scope',
    spec.name === 'full' && spec.prompt === '你是一名严格的代码审查员。' && !('file' in spec) && !('scope' in spec),
    JSON.stringify(spec),
  )
  check('AgentSpec 里一个密钥、一个端点都没有', !/apiKey|baseUrl|sk-/.test(JSON.stringify(spec)), JSON.stringify(spec))
  const roundSpec = readAgentSpec(JSON.parse(JSON.stringify(spec)))
  check('快照能原样读回来', JSON.stringify(roundSpec) === JSON.stringify(spec), JSON.stringify(roundSpec))
  check(
    '缺 name / prompt 的快照当作没有',
    readAgentSpec({ prompt: 'p' }) === undefined && readAgentSpec({ name: 'n' }) === undefined && readAgentSpec('x') === undefined,
  )
  check('坏掉的 permission / 非字符串列表被剔掉', (() => {
    const s = readAgentSpec({ name: 'n', prompt: 'p', permission: 'yolo', tools: ['a', 7, ''] })
    return s.permission === undefined && JSON.stringify(s.tools) === '["a"]'
  })())

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}

// ------------------------------------------------------- 智能体：会话装配与恢复
// 这一组盯的是这次改动最容易写错的两件事：「**按会话**过滤而不是按项目」（同项目两个会话可以
// 绑不同智能体），以及「**冻结**」（改一个智能体只影响之后新开的会话）。
console.log('\n== 智能体：会话装配与恢复 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { DesktopApp } = await import(`${dist}runtime/desktop-app.js`)
  const { createToolAssembly } = await import(`${dist}runtime/tools-assembly.js`)
  const { AgentRegistry, AGENT_FILENAME } = await import(`${dist}agents/registry.js`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-agentsess-'))
  const proj = path.join(home, 'proj')
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = path.join(home, 'clauda')
  fs.mkdirSync(proj, { recursive: true })

  const put = (name, lines) => {
    const d = path.join(proj, '.clauda', 'agents', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, AGENT_FILENAME), lines.join('\n'), 'utf8')
  }
  put('code-review', [
    '---',
    'name: code-review',
    'description: 审查',
    'model: agent-model',
    'temperature: 0',
    'permission: plan',
    'allow: write_file',
    'deny: bash',
    'tools: read_file, grep',
    'skills: a',
    'questions: 风险在哪？|测试怎么跑',
    '---',
    '',
    '你是一名严格的代码审查员。',
  ])
  put('readonly', ['---', 'name: readonly', 'tools: read_file', '---', '', '只看不改。'])
  // 绑了智能体却**没写 tools** —— 白名单为空 = 不限制（和 allow 的空数组语义不同）
  put('open', ['---', 'name: open', '---', '', '什么都能干。'])

  const fakeTool = (name) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    permission: 'write',
    summary: () => name,
    async run() {
      return { content: '' }
    },
  })
  let mcpOn = false
  const skillList = () => [
    { name: 'a', description: 'SKILL-A', dir: '/x/a', file: '/x/a/SKILL.md' },
    { name: 'b', description: 'SKILL-B', dir: '/x/b', file: '/x/b/SKILL.md' },
  ]
  const skills = {
    list: skillList,
    get: (n) => skillList().find((s) => s.name === n),
    has: (n) => n === 'a' || n === 'b',
    read: (n) => (n === 'a' ? 'A正文' : n === 'b' ? 'B正文' : null),
  }

  const openProject = (dir) => {
    const assembly = createToolAssembly(
      skills,
      { tools: () => (mcpOn ? [fakeTool('mcp__linear__create_issue')] : []) },
      [fakeTool('skill_write'), fakeTool('mcp_add')],
    )
    return {
      cwd: dir,
      config: agentConfig({
        defaultAgent: '',
        profiles: {
          deepseek: { baseUrl: 'http://ds/v1', apiKey: 'sk-ds', model: 'deepseek-chat', temperature: 1, maxTokens: 4096 },
        },
      }),
      skills,
      agents: AgentRegistry.discover(dir),
      memoryIndex: () => ({ entries: [], total: 0 }),
      assembleTools: assembly.assemble,
      mcp: {
        setEnabled: async (_n, enabled) => {
          mcpOn = enabled === true
        },
        status: () => [],
        tokenHint: () => 0,
        tools: () => [],
      },
      dispose: () => {},
    }
  }

  // 抓 `createProvider` 收到的那份 config：它是「智能体在会话诞生那一刻就冻住」的探针
  const seenProviders = []
  const mgr = new SessionManager({
    sink: { send: () => {} },
    openProject,
    createProvider: (cfg) => {
      seenProviders.push(cfg)
      return {
        model: 'm',
        async *stream() {
          yield { type: 'done' }
        },
      }
    },
  })

  const namesOf = (s) => s.agent.listTools().map((t) => t.name)

  const s1 = await mgr.openSession(proj, { agent: 'code-review' })
  check('新会话记住了自己绑的智能体', s1.agentName === 'code-review', s1.agentName)
  check(
    '模型 / 温度在建 provider 之前就折进去了（晚一步就是「提示词说 A、请求打到 B」）',
    seenProviders.at(-1).model === 'agent-model' && seenProviders.at(-1).temperature === 0,
    JSON.stringify(seenProviders.at(-1)),
  )
  check('权限模式被覆盖', s1.permissions.mode === 'plan', s1.permissions.mode)
  check('提示词里带着它的人格', s1.agent.messages[0].content.includes('## 智能体：code-review'))
  const n1 = namesOf(s1)
  check('工具白名单生效：名单外的 write_file 不在手上', !n1.includes('write_file'), n1.join(','))
  check('名单里的在手上', n1.includes('read_file') && n1.includes('grep'), n1.join(','))
  check(
    '白名单连 extraTools / 记忆工具一起挡',
    !n1.includes('skill_write') && !n1.includes('mcp_add') && !n1.includes('memory_write'),
    n1.join(','),
  )
  check(
    '技能白名单同时收窄了提示词里的技能索引',
    s1.agent.messages[0].content.includes('SKILL-A') && !s1.agent.messages[0].content.includes('SKILL-B'),
  )

  const s2 = await mgr.openSession(proj)
  check(
    '不给名字 = 没有智能体（主进程没有「套项目默认」这条魔法）',
    s2.agentName === '' && !s2.agent.messages[0].content.includes('## 智能体'),
    s2.agentName,
  )
  const n2 = namesOf(s2)
  check('没有智能体 = 全量工具', n2.includes('write_file') && n2.includes('bash'), n2.join(','))
  check(
    '没有智能体时技能不收窄',
    s2.agent.messages[0].content.includes('SKILL-A') && s2.agent.messages[0].content.includes('SKILL-B'),
  )

  const s3 = await mgr.openSession(proj, { agent: 'readonly' })
  const s5 = await mgr.openSession(proj, { agent: 'open' })
  const n3 = namesOf(s3)
  const n5 = namesOf(s5)
  check('绑了智能体但没写 tools = 不限制', n5.includes('write_file') && n5.includes('bash'), n5.join(','))
  check(
    '同项目两个会话绑不同智能体时工具集各算各的（一个没有 grep，另一个有）',
    !n3.includes('grep') && n1.includes('grep'),
    `${n3.join(',')} | ${n1.join(',')}`,
  )

  // MCP 开关是**广播**的：白名单外的会话仍拿不到，不限制的会话当场拿到
  await mgr.setMcpEnabled(proj, 'linear', true)
  check('广播之后，白名单把它挡在外面', !namesOf(s1).includes('mcp__linear__create_issue'), namesOf(s1).join(','))
  check('广播对「不限制」的会话照常生效', namesOf(s5).includes('mcp__linear__create_issue'), namesOf(s5).join(','))
  check('没绑智能体的会话也拿到了', namesOf(s2).includes('mcp__linear__create_issue'))

  // ---- 冻结：改磁盘上的那份，老会话不受影响
  const frozen = s1.agentSpec
  check('会话里存着冻结的那份配方', frozen?.name === 'code-review' && frozen.prompt.includes('严格'))
  // 走**真实的编辑路径**：`addAgent` 会 refresh 注册表（手改磁盘上的文件在应用看来不算改过，
  // 和技能一致）。改的是温度、白名单与正文，另外把常见问题留着 —— 下面要验它也跟着冻结
  mgr.addAgent(proj, {
    scope: 'project',
    name: 'code-review',
    description: '审查（改宽了）',
    body: '你是一名宽松的审查员。',
    model: 'agent-model',
    temperature: 1,
    tools: ['read_file', 'grep', 'write_file'],
    questions: ['风险在哪？', '测试怎么跑'],
  })
  const restored = await mgr.openSession(proj, {
    id: 'r1',
    snapshot: {
      messages: [
        { role: 'system', content: '旧的系统提示词' },
        { role: 'user', content: 'hi' },
      ],
      todos: [],
      totalUsage: { input: 0, output: 0 },
      cost: 0,
    },
    // 走一遍 JSON：真实恢复路径正是从磁盘上的 JSON 读回来再 `readAgentSpec` 过形状的
    agentSpec: JSON.parse(JSON.stringify({ ...frozen, prompt: '你是一名严格的代码审查员。' })),
  })
  check(
    '恢复用的是快照里那份正文，不是磁盘上改过的那份',
    restored.agent.messages[0].content.includes('严格的') &&
      !restored.agent.messages[0].content.includes('宽松的'),
  )
  check('恢复出来的会话仍是不带 write_file 的那套工具', !namesOf(restored).includes('write_file'))
  check('恢复出来的权限模式仍是快照里的 plan', restored.permissions.mode === 'plan')

  const fresh = await mgr.openSession(proj, { agent: 'code-review' })
  check(
    '新开的会话才吃改动（温度 1、多了 write_file）',
    fresh.agentSpec.temperature === 1 && namesOf(fresh).includes('write_file'),
    JSON.stringify(fresh.agentSpec),
  )

  const legacy = await mgr.openSession(proj, { id: 'r2', agentSpec: null })
  check(
    '老会话（没有 agent 键）恢复后不偷偷套上默认',
    legacy.agentName === '' && legacy.agentMissing === '',
    `${legacy.agentName} / ${legacy.agentMissing}`,
  )

  const missing = await mgr.openSession(proj, { agent: '已经没有这个了' })
  check('名字找不到不抛，按没有智能体装配', missing.agentName === '' && namesOf(missing).includes('bash'))
  check('但记下了那个名字，界面据此给一条通知', missing.agentMissing === '已经没有这个了', missing.agentMissing)

  // ---- project/info 里的那一份（徽标要数个数，设置页要画列表）
  const info = mgr.projectInfo(proj)
  check(
    '快照里带上智能体清单',
    Array.isArray(info.agents) && info.agents.length === 3,
    JSON.stringify(info.agents.map((a) => a.name)),
  )
  check('清单不带正文', info.agents.every((a) => !('body' in a)))
  check('清单里一个密钥、一个端点都没有', !/apiKey|baseUrl|sk-/.test(JSON.stringify(info.agents)), JSON.stringify(info.agents))
  check('没设默认时 defaultAgent 是空串', info.defaultAgent === '')
  mgr.setDefaultAgent(proj, 'code-review')
  const info2 = mgr.projectInfo(proj)
  check(
    '标了默认之后 isDefault 落在那一行',
    info2.defaultAgent === 'code-review' && info2.agents.find((a) => a.name === 'code-review')?.isDefault === true,
  )
  check('别的行没被误标', info2.agents.filter((a) => a.isDefault).length === 1)

  mgr.addAgent(proj, { scope: 'project', name: 'ghost', description: '档案不存在', body: '正文', profile: 'nope' })
  const info3 = mgr.projectInfo(proj)
  check('addAgent 之后清单里当场就有它（注册表重扫过）', info3.agents.some((a) => a.name === 'ghost'))
  check(
    '档案不存在时那一行带降级提示',
    /nope/.test(info3.agents.find((a) => a.name === 'ghost')?.problem ?? ''),
    info3.agents.find((a) => a.name === 'ghost')?.problem,
  )
  check('档案存在时不乱标', info3.agents.find((a) => a.name === 'code-review')?.problem === '')
  const got = mgr.getAgent(proj, 'code-review')
  check('agent/get 带回正文（改过的那份）', got.body.includes('宽松'), got.body)
  mgr.removeAgent(proj, 'ghost')
  check('removeAgent 删掉它', !mgr.projectInfo(proj).agents.some((a) => a.name === 'ghost'))
  const gone = await catchErr(() => mgr.removeAgent(proj, 'ghost'))
  check('删不存在的智能体抛，不假装删掉了', /没有名为/.test(gone.error ?? ''), gone.error)

  // ---- 通道那一层：警告要真的发得出去
  const app = new DesktopApp({ version: '0', sink: { send: () => {} }, openProject })
  const opened = await app.handle('session/open', { cwd: proj, agent: '已经没有这个了' })
  check(
    'session/open 名字找不到时仍然成功，只是带一条警告',
    opened.ok === true && opened.session.agentName === '' && /不在了/.test(opened.session.agentWarning ?? ''),
    JSON.stringify(opened.session),
  )
  const bound = await app.handle('session/open', { cwd: proj, agent: 'code-review' })
  check('顶栏拿得到这条会话绑的是谁', bound.session.agentName === 'code-review', bound.session.agentName)
  check(
    '空态问题来自这条会话冻结的那份配方',
    JSON.stringify(bound.session.agentQuestions) === '["风险在哪？","测试怎么跑"]',
    JSON.stringify(bound.session.agentQuestions),
  )
  check('没绑智能体的会话没有可点问题', opened.session.agentQuestions.length === 0)
  const badRemove = await app.handle('agent/remove', { cwd: proj, name: 'ghost' })
  check(
    '通道把 manager 抛的人话翻成 {ok:false, reason}',
    badRemove.ok === false && /没有名为/.test(badRemove.reason ?? ''),
    JSON.stringify(badRemove),
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

// ------------------------------------------------------- MCP 服务器：写盘与运行期
// 设置页那个表单和对话里的 `mcp_add` / `mcp_remove` 最后都落到同一组函数上。这里的不变式
// 和「写回接口地址」那一组同源，区别只在动的键不同 —— 少一条就是「加个 MCP 把别的配置
// 一起重写了」或者「把 ${VAR} 展开成明文密钥落盘」。
console.log('\n== MCP 配置写盘 ==')
{
  const { writeMcpServer, removeMcpServer, removeMcpServerAnywhere, configPath } = await import(`${dist}config.js`)

  const prevHome = process.env.CLAUDA_HOME
  const prevSecret = process.env.MCP_SECRET
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcphome-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcpproj-'))
  process.env.CLAUDA_HOME = home
  // 占位符指向的这个变量**必须真实存在**：不设的话展开不出来，下面那条「没被展开成明文」
  // 就成了永远成立的空断言
  process.env.MCP_SECRET = 'sk-mcp-真密钥'

  const file = configPath(proj)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 一份「什么都有」的项目配置：每条断言都要求**除了 mcpServers 之外一个字不动**
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        profiles: { default: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '${MCP_SECRET}', model: 'm' } },
        activeProvider: 'default',
        provider: { timeoutMs: 20000 },
        permissions: { mode: 'auto', allow: ['Read'], deny: [] },
        mcpServers: { demo: { command: 'npx', args: ['-y', 'old'] } },
      },
      null,
      2,
    ),
    'utf8',
  )

  check('写哪儿由调用方给（这里传的是项目配置文件）', writeMcpServer(file, 'fresh', { command: 'node', args: ['s.js'] }) === file)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  const raw = fs.readFileSync(file, 'utf8')
  check('新服务器写进了 mcpServers', after.mcpServers?.fresh?.command === 'node', JSON.stringify(after.mcpServers))
  check('已有的那条服务器一个字没动', after.mcpServers?.demo?.args?.[1] === 'old', JSON.stringify(after.mcpServers?.demo))
  check(
    '别的段落一个字没动',
    after.permissions?.mode === 'auto' && after.permissions.allow[0] === 'Read' && after.provider?.timeoutMs === 20000 && after.activeProvider === 'default',
    JSON.stringify({ p: after.permissions, provider: after.provider }),
  )
  // 这组里最要命的一条：`loadConfig()` 会把 `${MCP_SECRET}` 换成真密钥，拿它的结果回写
  // 就是把密钥明文落盘。写路径里一个字节都不能来自它
  check('写回的是磁盘原文，占位符没被展开成明文', raw.includes('${MCP_SECRET}') && !raw.includes('sk-mcp-真密钥'), raw)
  // 同名整条替换，和厂商档案那套一致 —— 字段级深合并出来的结果事后毫无头绪。
  // 连带的性质是「这一次没给的键会跟着一起没」，所以想替换就得给全（这条不定成
  // 「没给的键原样留着」是有意的：合并出来的半新半旧状态比报错更难查）
  writeMcpServer(file, 'fresh', { url: 'https://example.com/mcp' })
  const replaced = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.fresh
  check(
    '同名是整条替换，不是字段级合并',
    replaced.url === 'https://example.com/mcp' && replaced.command === undefined && replaced.args === undefined,
    JSON.stringify(replaced),
  )
  // 换**另一个名字**时，已有那几条一个键都不许动
  writeMcpServer(file, 'another', { command: 'node' })
  const siblings = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers
  check('新写一条不动别的服务器', siblings.another?.command === 'node' && siblings.demo?.args?.[1] === 'old' && siblings.fresh?.url === 'https://example.com/mcp', JSON.stringify(siblings))

  // 配置文件坏掉时必须抛，且**一个字节都不许改**：覆盖掉的话用户手写的注释和格式全没了，
  // 而且他下次打开文件看到的是「我的配置被清空了」
  const broken = path.join(path.dirname(file), 'broken.json')
  fs.writeFileSync(broken, '{ 这不是 JSON', 'utf8')
  const bad = await catchErr(() => writeMcpServer(broken, 'x', { command: 'node' }))
  check('配置文件不是合法 JSON 时抛', bad.error !== null, String(bad.error))
  check('抛的时候原文一个字节没动', fs.readFileSync(broken, 'utf8') === '{ 这不是 JSON')

  check(
    '删一条只摘掉那一条',
    removeMcpServer(file, 'fresh') === true &&
      Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).join(',') === 'demo,another',
    fs.readFileSync(file, 'utf8'),
  )
  check('删一条不存在的会说实话（返回 false，不假装删掉了）', removeMcpServer(file, 'fresh') === false)

  // 运行期那份是**合并之后**的，看不出某一条来自哪份文件 —— 所以「删哪个文件里的」只能按
  // 「项目优先」的顺序定，先找到的先删
  const globalFile = path.join(home, 'config.json')
  fs.writeFileSync(globalFile, JSON.stringify({ mcpServers: { onlyGlobal: { command: 'x' }, both: { command: 'g' } } }), 'utf8')
  writeMcpServer(file, 'both', { command: 'p' })
  check('两处都定义了就先删项目那份', removeMcpServerAnywhere(proj, 'both') === file)
  check('项目那份删了，全局那份还在（不是把两处一起清了）', JSON.parse(fs.readFileSync(globalFile, 'utf8')).mcpServers?.both?.command === 'g')
  check('只在全局定义的就删全局那份', removeMcpServerAnywhere(proj, 'onlyGlobal') === globalFile)
  check('哪份都没有时返回空串（调用方据此说「没这条」）', removeMcpServerAnywhere(proj, 'never') === '')

  if (prevHome === undefined) delete process.env.CLAUDA_HOME
  else process.env.CLAUDA_HOME = prevHome
  if (prevSecret === undefined) delete process.env.MCP_SECRET
  else process.env.MCP_SECRET = prevSecret
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
}

// 真连一条服务器（起子进程、握手、数工具）在 e2e 里跑：那边本来就是跨进程的。
// 这里只钉**不需要连上**就能判定的那几条契约 —— 它们恰恰是最容易被顺手改坏的。
console.log('\n== McpManager 的增删接口 ==')
{
  const { McpManager } = await import(`${dist}mcp/manager.js`)

  // `enabled: false` 是唯一不用起子进程就能走到「加成功」的分支，拿它钉状态登记
  const mgr = new McpManager({}, { version: '0.0.0-test', view: { warn() {} } })
  await mgr.addServer('off-by-config', { command: 'npx', enabled: false })
  const st = mgr.status()
  check('加进去的服务器会出现在状态列表里', st.length === 1 && st[0].name === 'off-by-config', JSON.stringify(st))
  check('配置里标了 enabled:false 就是 disabled，不去连', st[0].state === 'disabled' && st[0].toolCount === 0, JSON.stringify(st[0]))
  check('没连上就没有工具进集合', mgr.tools().length === 0, String(mgr.tools().length))
  check('名字和参数对不上时删一条会抛（界面不能说「已删除」而配置里还留着）', await catchErr(async () => mgr.removeServer('nope')).then((r) => r.error !== null))
  await mgr.removeServer('off-by-config')
  check('删干净了：状态、工具、配置名字一起没的', mgr.status().length === 0 && mgr.tools().length === 0, JSON.stringify(mgr.status()))
  check('删过之后再删同一个名字会抛', (await catchErr(async () => mgr.removeServer('off-by-config'))).error !== null)

  // `closeAll` 是不可逆的（`closed` 标志），加服务器必须挡在这道门外面 —— 放进去就是一个
  // 谁都关不掉的子进程
  const closed = new McpManager({}, { version: '0.0.0-test', view: { warn() {} } })
  await closed.closeAll()
  const late = await catchErr(async () => closed.addServer('late', { command: 'npx' }))
  check('管理器关掉之后加不进去', late.error !== null, String(late.error))
}

// 对话里那两个 MCP 工具：`mcp_add` 的权限级别**就是**审批机制的开关。
// default 模式下 exec 必然走对话框（见 permissions.ts 的判定顺序），所以「MCP 先弹审批」
// 这条决策不需要另造一套机制 —— 但它依赖 `risk` 把话说清楚，否则弹出来是个只有标题的框。
console.log('\n== 对话里的两个 MCP 工具 ==')
{
  const { makeMcpAddTool, makeMcpRemoveTool } = await import(`${dist}tools/mcp.js`)
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-mcptool-'))
  const mcp = { addServer: async () => {}, removeServer: async () => {} }
  const addTool = makeMcpAddTool(mcp, { cwd: proj })
  const removeTool = makeMcpRemoveTool(mcp, { cwd: proj })

  check('mcp_add 是 exec 权限（default 模式下必然弹框）', addTool.permission === 'exec', addTool.permission)
  check('mcp_remove 是写权限（它不执行任何东西，不该白弹「将以你的身份运行」）', removeTool.permission === 'write', removeTool.permission)
  // 两个都会换掉工具集（接上/摘掉一个服务器的工具）。**不**声明改提示词：声明位说的是
  // 「这个工具让提示词里的内容变了」，而 MCP 没动「## 可用技能」那段。谎报的后果是
  // agent 循环里多一次无谓的重建（`onToolsChanged` 那条回调为了省事，一律连提示词一起重建）
  check('两个都声明工具集会变', addTool.invalidatesTools === true && removeTool.invalidatesTools === true)
  check('两个都不声明改提示词', !addTool.invalidatesPrompt && !removeTool.invalidatesPrompt)

  const seen = []
  const pm = new PermissionManager({ mode: 'default', allow: [], deny: [] }, async (label, risk) => {
    seen.push({ label, risk })
    return true
  })
  const verdict = await pm.check(addTool, {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  })
  check('default 模式下 mcp_add 会弹框（这正是决策 3 的实现）', verdict.ok === true && seen.length === 1, JSON.stringify({ verdict, seen }))
  check('弹框标题是工具名 + 服务器名', seen[0]?.label === 'mcp_add(filesystem)', JSON.stringify(seen[0]?.label))
  // 说明里必须有那条命令：只写「将接入一个 MCP 服务器」等于让用户盲批一个子进程
  check(
    '风险说明里带出要执行的那条命令',
    /npx/.test(seen[0]?.risk ?? '') && /server-filesystem/.test(seen[0]?.risk ?? ''),
    JSON.stringify(seen[0]?.risk),
  )
  check('风险说明点明「以你的身份运行」', /以你的身份/.test(seen[0]?.risk ?? ''), JSON.stringify(seen[0]?.risk))
  check('风险说明写明写进哪个范围', /本项目/.test(seen[0]?.risk ?? ''), JSON.stringify(seen[0]?.risk))
  // 落点是**项目**（和设置页表单默认全局相反）：用户填表时眼在看「范围」那一栏，
  // agent 是趁人不在的时候动手
  check('agent 不写 scope 时按项目算', /本项目/.test(addTool.risk({ name: 'x', url: 'https://e.com/mcp' })), addTool.risk({ name: 'x' }))
  check('http 那条路的风险说明里带出 URL', /https:\/\/e\.com\/mcp/.test(addTool.risk({ name: 'x', url: 'https://e.com/mcp' })))
  check('明写 scope=global 时说明里就是全局', /全局/.test(addTool.risk({ name: 'x', scope: 'global', command: 'npx' })))
  // 删除在 default 模式下**也**会弹框（`write` 同样走 ask，只有 read 和 auto 模式才直放），
  // 区别在于说明必须诚实：用 exec 的话它会套上「将以你的身份运行」那句 —— 而那对删除是假的，
  // 删除不执行任何东西，只是把一条已有配置摘掉并断开
  const removeVerdict = await pm.check(removeTool, { name: 'filesystem' })
  check('default 模式下删除也会问一次', removeVerdict.ok === true && seen.length === 2, JSON.stringify(seen.map((s) => s.label)))
  check('删除的说明里不带「以你的身份运行」（那句话对删除是假的）', !/以你的身份/.test(seen[1]?.risk ?? ''), JSON.stringify(seen[1]?.risk))
  check('删除的说明里带服务器名', /filesystem/.test(seen[1]?.risk ?? ''), JSON.stringify(seen[1]?.risk))
  check('删完的那句话里带服务器名', (await removeTool.run({ name: 'filesystem' }, ctx())).includes('filesystem'))
  check('名字不合法时抛人话错误', (await catchErr(() => removeTool.run({}, ctx()))).error !== null)

  fs.rmSync(proj, { recursive: true, force: true })
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
// index.ts 里那几行搬出来，所以测试要钉住的不是「做了什么」，而是它**照搬的几条隐含语义**：
// 技能工具有条件注入、记忆工具与 skill_write 那几个无条件注入、assemble() 每次现算。
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

  const plain = createToolAssembly(noSkills, fakeMcp([]))
  check('baseTools 就是 ALL_TOOLS 本身（引用相等，不是副本）', plain.baseTools === ALL_TOOLS)
  check('零技能时工具数 = 7 内置 + 2 记忆', plain.assemble().length === 9, `实际 ${plain.assemble().length}`)
  check(
    'assemble() 含 memory_write（记忆工具无条件注入）',
    plain.assemble().some((t) => t.name === 'memory_write'),
    plain.assemble().map((t) => t.name).join(','),
  )
  check(
    '零技能时不挂 skill 工具（省下它 schema 每轮都要付的 token）',
    !plain.assemble().some((t) => t.name === 'skill'),
    plain.assemble().map((t) => t.name).join(','),
  )

  // 技能工具的条件**必须现算**：技能现在能在对话里当场新建，判在 createToolAssembly 里的话
  // 「用对话加的第一个技能」当场用不了 —— 那正是这次改动的核心
  let liveSkills = []
  const liveRegistry = { list: () => liveSkills }
  const growingSkills = createToolAssembly(liveRegistry, fakeMcp([]))
  check('起初没有 skill 工具', !growingSkills.assemble().some((t) => t.name === 'skill'))
  liveSkills = [{ name: 'demo', description: '演示技能' }]
  check(
    '新建技能之后 assemble() 当场把它带上（不必重建装配）',
    growingSkills.assemble().some((t) => t.name === 'skill'),
    growingSkills.assemble().map((t) => t.name).join(','),
  )
  check(
    '技能工具排在 ALL_TOOLS 之后、记忆工具之前',
    growingSkills.assemble().findIndex((t) => t.name === 'skill') === ALL_TOOLS.length,
    growingSkills.assemble().findIndex((t) => t.name === 'skill'),
  )
  check(
    '有技能也不会污染 ALL_TOOLS（恒为 7 个内置）',
    ALL_TOOLS.length === 7 && !ALL_TOOLS.some((t) => t.name === 'skill'),
    `实际 ${ALL_TOOLS.length}`,
  )

  // 对话里增删技能 / MCP 的四个工具走 extraTools：**零技能、零服务器时恰恰最需要它们**
  const extra = mcpToolNamed('skill_write')
  const withExtra = createToolAssembly(noSkills, fakeMcp([]), [extra])
  check(
    'extraTools 无条件注入（零技能时也在）',
    withExtra.assemble().some((t) => t.name === 'skill_write'),
    withExtra.assemble().map((t) => t.name).join(','),
  )

  const mcpTool = mcpToolNamed('mcp__demo__ping')
  const wired = createToolAssembly(liveRegistry, fakeMcp([mcpTool]), [extra])
  const names = wired.assemble().map((t) => t.name)
  check(
    'assemble() 顺序为 baseTools → skill → memoryTools → extraTools → mcp.tools()',
    names.indexOf('skill') < names.indexOf('memory_read') &&
      names.indexOf('memory_read') < names.indexOf('skill_write') &&
      names.indexOf('skill_write') < names.indexOf('mcp__demo__ping') &&
      names[names.length - 1] === 'mcp__demo__ping',
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
    skills: { list: () => [] },
    assembleTools: () => ALL_TOOLS,
    mcp: { setEnabled: async () => {}, status: () => [], tokenHint: () => 0, tools: () => [] },
    dispose: () => { disposed.push(dir) },
  })

  // provider 不再是项目的一部分（一个会话一个），所以从工厂这儿塞假的进去
  const mgr = new SessionManager({ sink, openProject, createProvider: () => textProvider('回答') })
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
// 换端点会踩两个坑，任一都是「下一条消息必 404」：provider 的 client 是构造时建的快照
// （改了 baseUrl 请求还打往旧地址，且不报错），以及会话的 model 是开会话时克隆出来的
// 旧值（拿 gpt-4o-mini 去问 DeepSeek）。
//
// 这两条现在都由「一个会话一个 provider、端点与模型冻在创建那一刻」兜住，所以下面验的
// 不再是「刷得对不对」，而是**活会话压根不许被刷** —— 那正是配置冻结要的效果。
console.log('\n== 会话管理：切厂商写盘、活会话冻结 ==')
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
    // 运行时那份 config 是 `loadConfig` 出来的，档案表与 activeProvider 一定在（`resolveProfiles`
    // 补的）。手动拼的 fixture 得自己补上，否则「加一份档案」没有地方落
    config.profiles = {
      legacy: {
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'x',
        model: 'old-model',
        temperature: 0,
        maxTokens: 100,
      },
    }
    config.activeProvider = 'legacy'

    /** 每轮真正打到的地址。记的是**建 provider 时那份 config** 里的地址 */
    const hit = []
    const project = {
      cwd: projDir,
      config,
      skills: { list: () => [] },
      assembleTools: () => ALL_TOOLS,
      mcp: { setEnabled: async () => {}, status: () => [], tokenHint: () => 0, tools: () => [] },
      dispose: () => {},
    }

    // 单元测试不许碰 socket，所以塞个假 provider 进去（真实现是 OpenAICompatibleProvider）。
    // 关键：它只认**建的时候**拿到的那份 config，项目那份后来被改成什么与它无关 —— 正是冻结
    const fakeProvider = (cfg) => ({
      model: cfg.model,
      async *stream() {
        hit.push(cfg.baseUrl)
        yield { type: 'text', text: '好的' }
        yield { type: 'done', finishReason: 'stop' }
      },
    })
    const mgr = new SessionManager({
      sink: { send: () => {} },
      openProject: () => project,
      createProvider: fakeProvider,
    })
    const a = await mgr.openSession(projDir)
    await mgr.send(a.id, '第一轮')
    check('第一轮打的是项目原来的地址', hit.at(-1) === 'http://127.0.0.1:9/v1', JSON.stringify(hit))

    const ds = findVendor('deepseek')
    // 加一份档案：写盘 + 进内存档案表，但**不碰正在用的那份**
    const added = mgr.addProfile(projDir, ds)
    const afterAdd = JSON.parse(fs.readFileSync(added.file, 'utf8'))
    check(
      '加一份档案把地址与模型一起写盘（只写地址会留着旧模型名，切过去必 404）',
      afterAdd.profiles.deepseek.baseUrl === ds.baseUrl && afterAdd.profiles.deepseek.model === ds.models[0],
      JSON.stringify(afterAdd.profiles),
    )
    check('加一份档案不会顺手把它设为当前使用', afterAdd.activeProvider === 'legacy', String(afterAdd.activeProvider))
    check('加一份档案不动内存里那份项目配置', config.provider.baseUrl === 'http://127.0.0.1:9/v1', config.provider.baseUrl)

    // 显式切换：这才是唯一会换厂商的动作
    const file = mgr.setActiveProfile(projDir, added.key)
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('切当前使用落在磁盘上', disk.activeProvider === added.key, String(disk.activeProvider))
    check('切当前使用同步了内存里那份项目配置（新会话唯一的来源）', config.provider.baseUrl === ds.baseUrl, config.provider.baseUrl)
    // 写这份文件时只写**这份文件里声明过的**档案，别把内存里那份（来自全局/内置层的）
    // 顺手抄进来 —— 抄了就是把别的文件里的密钥复制到项目里
    check('写一个档案不会把别的档案抄进这份文件', Object.keys(disk.profiles).join(',') === added.key, JSON.stringify(Object.keys(disk.profiles)))
    check('内存里那份老档案还在（并存，不是替换）', Object.keys(config.profiles).join(',') === 'legacy,deepseek', JSON.stringify(Object.keys(config.profiles)))
    check(
      '切厂商不动活会话的模型（配置冻结）',
      a.config.provider.model === 'old-model',
      a.config.provider.model,
    )
    check('活会话的系统提示词里还是旧模型名', a.agent.messages[0].content.includes('old-model'), a.agent.messages[0].content.slice(0, 300))

    const opened = await mgr.openSession(projDir)
    check('切完之后新建的会话直接用新模型', opened.config.provider.model === ds.models[0], opened.config.provider.model)

    await mgr.send(a.id, '第二轮')
    check(
      '第二轮仍然打到旧地址（冻结没生效的话，这里会变成新地址）',
      hit.at(-1) === 'http://127.0.0.1:9/v1',
      JSON.stringify(hit),
    )

    // ---- 三条会把配置写坏的路径，一律拦在写盘之前
    /** 跑一段应当抛错的代码，返回错误信息（没抛就是空串） */
    const threw = (fn) => {
      try {
        fn()
        return ''
      } catch (e) {
        return e.message
      }
    }

    // 删掉当前那份，`activeProvider` 就指向一个不存在的名字，配置会静默退回内置默认值
    const delActive = threw(() => mgr.removeProfile(projDir, added.key))
    check('删当前使用那份会被拦下', delActive.includes('当前使用'), delActive)
    check('被拦下时文件一字未动', JSON.parse(fs.readFileSync(file, 'utf8')).activeProvider === added.key)

    // 空地址的档案设成当前使用 = 之后每个新会话都打到一个空 URL
    const custom = mgr.addProfile(projDir, null)
    check('自定义档案拿到一个不重名的 key', custom.key.length > 0 && custom.key !== added.key, custom.key)
    const activateEmpty = threw(() => mgr.setActiveProfile(projDir, custom.key))
    check('缺参数的档案不能设为当前使用', activateEmpty.includes('接口地址'), activateEmpty)
    const dup = threw(() => mgr.addProfile(projDir, ds))
    check('加过的 key 再加一次会被拦下', dup.includes('已经有一份'), dup)

    // 删一份**不是当前**的档案是允许的，且不会连累当前那份
    const removed = JSON.parse(fs.readFileSync(mgr.removeProfile(projDir, custom.key), 'utf8'))
    check('删非当前那份会真的落盘', removed.profiles[custom.key] === undefined, JSON.stringify(Object.keys(removed.profiles)))
    check('删非当前那份不碰当前那份', removed.activeProvider === added.key && !!removed.profiles[added.key], JSON.stringify(removed))
  } finally {
    if (prevHome === undefined) delete process.env.CLAUDA_HOME
    else process.env.CLAUDA_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(projDir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ 项目运行时的生死
// 技能与 MCP 挂在**项目运行时**上，而配技能、配 MCP 恰恰是开第一个会话**之前**想做的事。
// 早先运行时只在开会话时才建、最后一个会话关掉就销毁，于是那三页在「还没开会话」和
// 「刚关掉会话」两个状态下只剩一句「还没有打开的会话」。
//
// 这条运行时还攥着 MCP 子进程，所以「什么时候销毁」不能松：换项目时没人用的那份要收，
// 还有人用的那份一寸都不能动。
console.log('\n== 项目运行时：没会话也拿得到，切目录 / 退出都收得干净 ==')
{
  const { SessionManager } = await import(`${dist}runtime/session-manager.js`)
  const { ALL_TOOLS } = await import(`${dist}tools/index.js`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-phome-'))
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-pproj-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-pproj-b-'))
  const prevHome = process.env.CLAUDA_HOME
  process.env.CLAUDA_HOME = home

  try {
    /** cwd -> 最近一次建出来的假运行时。`disposed` 是本组的主角：谁被收了、谁还活着 */
    const built = new Map()
    const makeProject = (cwd) => {
      const config = agentConfig()
      config.provider.baseUrl = 'http://127.0.0.1:9/v1'
      // 档案表与 activeProvider 由 `loadConfig` 补，手拼的 fixture 得自己来（同上一组）
      config.profiles = {
        legacy: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'm', temperature: 0, maxTokens: 100 },
      }
      config.activeProvider = 'legacy'
      const project = {
        cwd,
        config,
        skills: { list: () => [] },
        assembleTools: () => ALL_TOOLS,
        mcp: { setEnabled: async () => {}, status: () => [], tokenHint: () => 0, tools: () => [] },
        disposed: false,
        dispose() {
          this.disposed = true
        },
      }
      built.set(cwd, project)
      return project
    }

    const mgr = new SessionManager({
      sink: { send: () => {} },
      openProject: (cwd) => makeProject(cwd),
      createProvider: (cfg) => ({ model: cfg.model, async *stream() {} }),
    })

    // ---- 一个会话都没有的时候
    await mgr.ensureProject(dirA)
    const bare = mgr.projectInfo(dirA)
    check('没开会话也能拿到项目快照', bare?.cwd === dirA, JSON.stringify(bare?.cwd))
    check(
      '没开会话时右栏该有的东西也都在（厂商档案）',
      bare?.profiles?.length === 1 && bare.activeProvider === 'legacy',
      JSON.stringify(bare?.profiles),
    )
    check('没碰过的目录仍然是 null（不能凭空造一份）', mgr.projectInfo(dirB) === null)

    // 这条通道每轮结束都会调一次。重建等于每轮重连一次 MCP，所以必须是复用的
    await mgr.ensureProject(dirA)
    check('重复 ensure 复用同一份运行时', built.size === 1, String(built.size))

    const s = await mgr.openSession(dirA)
    check('开会话复用的还是那份运行时（不是另起一份）', built.size === 1, String(built.size))
    await mgr.closeSession(s.id)
    check('关掉最后一个会话不销毁被选中的项目（徽标和三个设置页还得有东西）', built.get(dirA)?.disposed === false)
    check('关掉会话之后快照照样拿得到', mgr.projectInfo(dirA) !== null)

    // ---- 还有会话在跑的目录，换项目也不许被收走（正在跑的会话还攥着它的工具与 MCP）
    const live = await mgr.openSession(dirA)
    await mgr.ensureProject(dirB)
    check('还有会话在跑的项目，切走了也不销毁', built.get(dirA)?.disposed === false)
    check('换过去的项目立刻可用', mgr.projectInfo(dirB) !== null)

    // 那份会话一关，它就成了「没人用、也没被选中」——这时候才该收
    await mgr.closeSession(live.id)
    check('最后一个会话关掉、又没被选中，运行时才销毁', built.get(dirA)?.disposed === true)

    // ---- 退出：被钉住的那份没有会话引用，`closeSession` 带不走它，得单独收
    await mgr.ensureProject(dirA)
    check('切回来会重新建一份', built.get(dirA)?.disposed === false)
    await mgr.disposeAll()
    check(
      '退出时被钉住的那份也收干净了（MCP 子进程不能留）',
      built.get(dirA)?.disposed === true && built.get(dirB)?.disposed === true,
      JSON.stringify({ a: built.get(dirA)?.disposed, b: built.get(dirB)?.disposed }),
    )
  } finally {
    if (prevHome === undefined) delete process.env.CLAUDA_HOME
    else process.env.CLAUDA_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
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
  // routingProvider 无状态（只读 opts），两个会话共用同一个实例没有区别
  const mgr = new SessionManager({ sink, openProject, createProvider: () => routingProvider })

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
    createProvider: () => provider,
    openProject: (d) => ({
      cwd: d,
      // auto 模式：记忆工具是 write 权限，不然会卡在授权框上
      config: agentConfig({ permissions: { mode: 'auto', allow: [], deny: [] } }),
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

  // 临时目录里没有技能、也没配 MCP，所以是 7 内置 + 2 记忆 + 4 个「对话里增删技能 / MCP」
  const names = pa.assembleTools().map((t) => t.name)
  check('工具集 = 7 内置 + 2 记忆 + 4 个增删工具', names.length === 13, `实际 ${names.length}`)
  check(
    '零技能零服务器时也带着 skill_write / mcp_add（没它们就写不进第一条）',
    ['skill_write', 'skill_remove', 'mcp_add', 'mcp_remove'].every((n) => names.includes(n)),
    names.join(','),
  )
  check('零技能时不挂 skill 工具', !names.includes('skill'), names.join(','))
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

  check('落盘失败不抛出（磁盘问题不该影响对话）', (() => { persistSession({ cwd: '\0非法路径', sessionId: 'p3', model: 'm', snapshot: snap(3) }); return true })())

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

// 用户在输入框里带上来的图片。`WireMessage.content` 从 `string` 放宽成了
// `string | ContentPart[]`，于是「content 一定是字符串」这个假设在好几处塌掉了。
// 塌的方式分两档，**两档要分别钉**：
//   - 崩的那一档只有 `messagesTokens`（`estimateTokens` 里 `ch.codePointAt` 不是函数），
//     它经 `contextTokens()` 被 /cost、压缩判定、每轮 infoOf 调用 —— 不改就是打开会话白屏；
//   - 静默的那一档（`summarize` / `deriveTitle` / 渲染层）**不抛**，只是把
//     `[object Object]` 拼进摘要和标题里。不钉的话这类坏数据能安安静静躺在会话文件里。
console.log('\n== 消息内容：从纯文本放宽到 content part 之后 ==')
{
  const { IMAGE_TOKEN_ESTIMATE, buildUserContent, contentTokens, messageText } = await import(
    `${dist}util/message.js`
  )
  const { estimateTokens } = await import(`${dist}util/text.js`)
  const { deriveTitle } = await import(`${dist}agent/session.js`)

  const img = (url = 'data:image/png;base64,AAAA') => ({ type: 'image_url', image_url: { url } })
  const txt = (t) => ({ type: 'text', text: t })

  check('纯字符串原样返回', messageText('你好') === '你好')
  check('text 块拼起来', messageText([txt('第一行'), txt('第二行')]) === '第一行\n第二行')
  check('图片变成占位符', messageText([txt('看这张'), img()]) === '看这张\n[图片]')
  check('空数组得到空串', messageText([]) === '')
  check('不是数组的怪形状不抛', messageText(undefined) === '' && messageText(42) === '')

  // 崩的那一档：`contextTokens()` 走的就是这里
  const withImage = [txt('一段文字'), img()]
  check('数组型 content 估算不抛（contextTokens 的回归护栏）', typeof contentTokens(withImage) === 'number')
  check(
    '图片按固定值计，不按 base64 长度',
    contentTokens(withImage) === estimateTokens('一段文字') + IMAGE_TOKEN_ESTIMATE,
    String(contentTokens(withImage)),
  )
  // 这条是那个「按字节估」的错误实现会当场露馅的地方：2MB 的图会算出 ~70 万
  const huge = [img('data:image/png;base64,' + 'A'.repeat(2_800_000))]
  check(
    '一张 2MB 的图不会算出六位数 token',
    contentTokens(huge) < 5000,
    String(contentTokens(huge)),
  )
  check('字符串仍然走原来的估算', contentTokens('abcd') === estimateTokens('abcd'))

  // 没有附件时必须**还是字符串** —— 老会话文件、CLI、压缩摘要全靠这一支
  check('没有附件时 buildUserContent 返回字符串', typeof buildUserContent('你好', []) === 'string')
  const withParts = buildUserContent('看这张', [
    { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAAA', bytes: 3 },
    { kind: 'file', name: 'b.py', path: 'C:/p/b.py', bytes: 10 },
  ])
  check('有附件时返回数组', Array.isArray(withParts), typeof withParts)
  check('数组第一个块是用户打的字', withParts[0].type === 'text' && withParts[0].text === '看这张')
  check('图片块排在路径清单前面', withParts[1].type === 'image_url' && withParts[1].image_url.url.endsWith('AAAA'))
  check('路径清单在最后一块里', withParts[2]?.type === 'text' && withParts[2].text.includes('C:/p/b.py'), withParts[2]?.text)
  // 一个字没打只丢了一张图 —— 空 text 块有些端点会当非法请求
  const imageOnly = buildUserContent('', [{ kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAAA', bytes: 3 }])
  check('只发图片时正文不是空的', imageOnly[0].text.length > 0, imageOnly[0].text)
  // 只有文件、一个字没打：正文补占位，路径清单照给
  const fileOnly = buildUserContent('', [{ kind: 'file', name: 'b.py', path: 'C:/p/b.py', bytes: 10 }])
  check('只发文件时也有正文', fileOnly[0].text.length > 0, fileOnly[0].text)

  // 静默的那一档：不抛，但绝不能是 [object Object]
  check('数组型 content 也能取标题', deriveTitle([{ role: 'user', content: [txt('修一下登录'), img()] }]) === '修一下登录')
  const titleOfImageOnly = deriveTitle([{ role: 'user', content: [img()] }])
  check('纯图片消息的标题不是空的', titleOfImageOnly.length > 0, JSON.stringify(titleOfImageOnly))
  check('纯图片消息的标题不出现 [object Object]', !titleOfImageOnly.includes('[object Object]'), titleOfImageOnly)
  check(
    '坏形状的 content 不会让取标题抛',
    typeof deriveTitle([{ role: 'user', content: { 怪: '形状' } }]) === 'string',
  )
}

// 附件的归一化只有两条路：renderer 报原始形状（走 fs 读字节），session/send 回传
// 归一化后的描述符（纯核形状）。**「请求体里带没带图」只能在 e2e 里断言**，
// 这里判的是「字节读得对不对、该拒的拒没拒」。
console.log('\n== 桌面端：附件的归一化与校验 ==')
{
  const { ingestAttachments, sanitizeAttachments } = await import(`${dist}runtime/attachment.js`)

  // 一张真的 1×1 PNG。**不能引用磁盘上的 fixture 文件** —— 单测跑在临时目录里
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauda-attach-'))
  const pngPath = path.join(dir, 'shot.png')
  const pyPath = path.join(dir, 'demo.py')
  const bigPath = path.join(dir, 'big.png')
  const fakePngPath = path.join(dir, 'fake.png')
  fs.writeFileSync(pngPath, PNG)
  fs.writeFileSync(pyPath, 'print(1)\n')
  fs.writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024, 1))
  // 名字是 .png、内容却是文本。改名 / 传错文件都会长成这样
  fs.writeFileSync(fakePngPath, 'print(1)\n')

  const img = await ingestAttachments([{ path: pngPath, name: 'shot.png', mime: '' }])
  check('磁盘上的 png 被认成图片', img.attachments[0]?.kind === 'image', JSON.stringify(img.attachments))
  check(
    'png 的 data URL 前缀是 image/png',
    img.attachments[0]?.dataUrl?.startsWith('data:image/png;base64,'),
    img.attachments[0]?.dataUrl?.slice(0, 30),
  )
  check('字节数就是文件大小', img.attachments[0]?.bytes === PNG.length, String(img.attachments[0]?.bytes))
  check('没有被拒的', img.rejected.length === 0, img.rejected.join(' / '))
  // mime 空、扩展名认得出来 —— 拖进来的文件 type 常常是空串
  check('File.type 为空也不影响判图', img.attachments[0]?.kind === 'image')

  const py = await ingestAttachments([{ path: pyPath, name: 'demo.py' }])
  check('非图片只带路径', py.attachments[0]?.kind === 'file' && py.attachments[0]?.path === pyPath)
  check('非图片不读字节', py.attachments[0]?.dataUrl === undefined)

  const big = await ingestAttachments([{ path: bigPath, name: 'big.png' }])
  check('超过 4MB 的图片被拒', big.attachments.length === 0 && big.rejected.length === 1, big.rejected.join(' / '))
  check('拒绝理由说清了是「太大」', /太大/.test(big.rejected[0] ?? ''), big.rejected[0])

  // 认图看的是**字节**，不是名字：名字像图而内容是文本时，得在本地就拦下来。
  // 放过去的话会一路发到端点换回一个 400，用户看到的却是「这个端点不支持图片输入」
  // —— 一句会把用户引到换模型上去的假话。
  const fake = await ingestAttachments([{ path: fakePngPath, name: 'fake.png', mime: 'image/png' }])
  check('名字是 .png 但内容是文本的，被拒', fake.attachments.length === 0 && fake.rejected.length === 1, JSON.stringify(fake))
  check('理由说的是「内容不是图片」', /不是图片/.test(fake.rejected[0] ?? ''), fake.rejected[0])
  check('不会误报成「太大」', !/太大/.test(fake.rejected[0] ?? ''), fake.rejected[0])

  // mime 以字节为准：扩展名说 jpeg、字节里是 PNG，就得报 image/png。
  // 「扩展名 → mime」的表在这里只会给出一个错标签
  const mislabeled = path.join(dir, 'actually.png.jpg')
  fs.writeFileSync(mislabeled, PNG)
  const sniffed = await ingestAttachments([{ path: mislabeled, name: 'actually.png.jpg', mime: 'image/jpeg' }])
  check(
    'mime 取字节嗅出来的，不认扩展名和 File.type',
    sniffed.attachments[0]?.dataUrl?.startsWith('data:image/png;base64,'),
    sniffed.attachments[0]?.dataUrl?.slice(0, 30),
  )

  // 剪贴板那条路：renderer 送进来的字符串。前缀是粗筛，负载同样要嗅
  const pasted = await ingestAttachments([{ dataUrl: PNG_URL, name: '剪贴板图片' }])
  check('没有路径但有 data:image/ 的放行', pasted.attachments[0]?.kind === 'image', JSON.stringify(pasted))
  const badPrefix = await ingestAttachments([{ dataUrl: 'data:text/html;base64,AAAA', name: 'x' }])
  check('data URL 前缀不是 image 的被拒', badPrefix.attachments.length === 0, JSON.stringify(badPrefix))
  const fakePayload = await ingestAttachments([{ dataUrl: 'data:image/png;base64,AAAA', name: 'x' }])
  check(
    '前缀写着 image/png 但负载不是图的，被拒',
    fakePayload.attachments.length === 0 && fakePayload.rejected.length === 1,
    JSON.stringify(fakePayload),
  )
  const noSource = await ingestAttachments([{ name: 'x.png' }])
  check('既没路径也没 data URL 的被拒', noSource.attachments.length === 0 && noSource.rejected.length === 1)
  check('拒绝理由告诉用户怎么办', /另存/.test(noSource.rejected[0] ?? ''), noSource.rejected[0])

  const nul = await ingestAttachments([{ path: `${dir}\0.png` }])
  check('含 \\0 的路径被拒', nul.attachments.length === 0 && nul.rejected.length === 1, JSON.stringify(nul))
  check('拒绝理由不是「没有磁盘路径」', !/没有磁盘路径/.test(nul.rejected[0] ?? ''), nul.rejected[0])

  const many = await ingestAttachments(Array.from({ length: 12 }, (_, i) => ({ path: pyPath, name: `f${i}.py` })))
  check('超过 8 个的附件被截断', many.attachments.length === 8, String(many.attachments.length))
  check('被截断这件事报出来了', many.rejected.some((r) => /最多/.test(r)), many.rejected.join(' / '))

  check('不是数组的入参不抛', (await ingestAttachments(null)).attachments.length === 0)

  // 回传那一侧：纯核形状，不碰 fs
  check(
    '归一化过的图片能过',
    sanitizeAttachments([{ kind: 'image', name: 'a', dataUrl: PNG_URL, bytes: PNG.length }]).length === 1,
  )
  check(
    '伪造的 dataUrl 前缀过不去',
    sanitizeAttachments([{ kind: 'image', name: 'a', dataUrl: 'https://x/a.png' }]).length === 0,
  )
  check(
    '前缀对但负载不是图的过不去',
    sanitizeAttachments([{ kind: 'image', name: 'a', dataUrl: 'data:image/png;base64,AAAA' }]).length === 0,
  )
  check(
    '没有路径的文件过不去',
    sanitizeAttachments([{ kind: 'file', name: 'a' }]).length === 0,
  )
  const recounted = sanitizeAttachments([{ kind: 'image', name: 'a', dataUrl: PNG_URL, bytes: 999999 }])[0]
  check('字节数按 dataUrl 长度重算，不认 renderer 报的', recounted?.bytes === PNG.length, String(recounted?.bytes))
}

// 恢复历史时图片要能重画出来 —— 「图片留在会话历史里」这条决策的真正验收点。
// 同时钉住「纯文本消息还是一个字符串」：老会话文件读回来必须和从前一模一样。
console.log('\n== 桌面端渲染层：把落盘的消息还原成条目 ==')
{
  const { imageUrls, toItems, userText } = await import(
    new URL('../desktop/renderer/state.js', import.meta.url).href
  )

  const content = [
    { type: 'text', text: '这张图右边那个按钮什么颜色' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: '附件（只给了路径，需要内容请用 read_file）：\n- C:/p/a.py' },
  ]
  const items = toItems([{ role: 'user', content }])
  check('还原出一条用户条目', items.length === 1 && items[0].kind === 'user', JSON.stringify(items))
  check('气泡里的字只有用户自己打的那些', items[0].text === '这张图右边那个按钮什么颜色', items[0].text)
  check('追加的附件清单不进气泡', !items[0].text.includes('只给了路径'), items[0].text)
  check('图片被还原成 data URL（重开窗口还看得见图）', items[0].images.length === 1, JSON.stringify(items[0].images))
  check('图片就是那一张', imageUrls(content)[0].endsWith('AAAA'), imageUrls(content)[0])

  const plain = toItems([{ role: 'user', content: '就一句话' }])
  check('纯文本消息照旧（多出来的 images 是空数组）', plain[0].text === '就一句话' && plain[0].images.length === 0)
  check('坏形状不抛', userText({ 怪: 1 }) === '' && imageUrls(undefined).length === 0)

  // 工具卡片那条路完全不能因为这次改动变形
  const tools = toItems([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
  ])
  check('工具卡片仍然对得上名字', tools[0].name === 'read_file', JSON.stringify(tools))
  check('工具卡片仍然收得到结果', tools[0].status === 'done' && tools[0].result === '文件内容', JSON.stringify(tools[0]))
}

// 内置的九家里纯文本端点才是多数，第一次发图很可能撞上「这个端点不收图片」——
// 而 SDK 的原话是一段原始报文，用户只会以为是自己操作错了。400 得有个人话版本，
// 并且点到那个最可能的原因上。
console.log('\n== 报错翻译：400 要点名「可能是图片」 ==')
{
  const { describeError } = await import(`${dist}util/errors.js`)
  const cfg = { provider: { baseUrl: 'https://api.deepseek.com/v1' } }
  const msg = describeError({ status: 400, message: 'Bad Request' }, cfg)
  check('400 不再原样透传 SDK 的话', !msg.includes('Bad Request'), msg)
  check('400 里点出了图片这条可能', msg.includes('图片'), msg)
  check('400 里带上了当前接口地址', msg.includes('api.deepseek.com'), msg)
  // 邻居不能被顺手改坏
  check('401 仍走认证那条', describeError({ status: 401 }).includes('API Key'))
  check('404 仍点名路径前缀', describeError({ status: 404 }, cfg).includes('compatible-mode'))
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

  // 左栏的默认长相：会话在最上，设置压在最下、且**收着**。「主页默认显示会话」靠的
  // 就是这个默认值，所以只能在还没人碰过导航的时候验 —— 下面第一条用例就点了 nav-skills。
  //
  // 这里只盯 `hidden` 这个**属性**：假 DOM 没有样式，`hidden` 真被 `display: flex`
  // 顶掉它看不出来（`.rail[hidden]` / `.browse[hidden]` / `.rail-group[hidden]` 那三条
  // 规则就是为这个坑写的），得靠真窗口看。
  check('设置分组默认是收起的', app.el('settings-group').hidden === true)
  check('「设置」默认没被标成当前', !app.el('nav-settings').className.includes('is-current'))
  check('「设置」默认的 aria-expanded 是 false', app.el('nav-settings').getAttribute('aria-expanded') === 'false')
  check('会话那一格默认在', app.el('rail').hidden === false)
  check('会话列表默认在', app.el('browse').hidden === false)

  // **一个会话都还没开**的时候，三个设置页就该有内容。技能与 MCP 挂在项目运行时上，
  // 而配它们正是开第一个会话之前想做的事 —— 以前运行时只在开会话时才建，这三页在
  // 那一刻只剩一句「还没有打开的会话」，等于把「配」挡在了「用」后面。
  app.el('nav-skills').click()
  await tick()
  check(
    '还没开会话时技能页就有内容（不是空态）',
    textOf(app.el('settings-body')).includes('/demo'),
    textOf(app.el('settings-body')),
  )
  app.el('nav-mcp').click()
  await tick()
  check(
    '还没开会话时 MCP 页就有内容（不是空态）',
    find(app.el('settings-body'), (n) => n.dataset?.name === 'demo') !== null,
    textOf(app.el('settings-body')),
  )
  app.el('nav-sessions').click()
  await tick()
  check('切回会话页', app.el('app').dataset.view === 'sessions', app.el('app').dataset.view)

  // 点开「设置」= 左栏**整个换内容**：四项接替到最上面，会话那一格和会话列表一起让位
  // （用户的原话是「点击设置 隐藏会话相关内容」）。
  //
  // 三块必须**同时**翻。少翻一块，左边就同时挂着两套内容 —— 而每一块单看，`hidden`
  // 都是对的。所以这里断言的是一组，不是一个。
  const settingsShown = () =>
    app.el('settings-group').hidden === false &&
    app.el('rail').hidden === true &&
    app.el('browse').hidden === true
  const sessionsShown = () =>
    app.el('settings-group').hidden === true &&
    app.el('rail').hidden === false &&
    app.el('browse').hidden === false

  check('会话页上左栏是会话那一套', sessionsShown())

  app.el('nav-settings').click()
  await tick()
  // 上面点过 nav-mcp，所以「上次待的设置页」就是工具页 —— 「设置」回跳的是它，不是智能体
  check('点「设置」切进上次那个设置页', app.el('app').dataset.view === 'mcp', app.el('app').dataset.view)
  check('点「设置」把左栏换成设置那套', settingsShown())
  check('展开时 aria-expanded 是 true', app.el('nav-settings').getAttribute('aria-expanded') === 'true')

  app.el('nav-settings').click()
  await tick()
  check('再点一下回会话页', app.el('app').dataset.view === 'sessions', app.el('app').dataset.view)
  check('回会话页时左栏换回会话那套', sessionsShown())
  check('收起后 aria-expanded 跟着翻', app.el('nav-settings').getAttribute('aria-expanded') === 'false')

  // 再切回设置，好让下面那条「别处切进设置页」不是在一个已经收着的状态上空过
  app.el('nav-settings').click()
  await tick()
  check('切回设置页时左栏又换成设置那套', settingsShown())

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
  // （`textOf` / `find` 两个小工具在本组开头就定义了，见「还没开会话时」那几条）
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
  check('进了设置页，「设置」也标成当前', app.el('nav-settings').className.includes('is-current'))
  check('收着的分组进设置页会自己撑开', app.el('settings-group').hidden === false)

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

  // ---- 左栏：所有档案都在，谁在用、正在改谁，三件事各说各的
  const vendorRowOf = (key) => find(body, (n) => n.dataset?.key === key)
  const rowsOf = () => (find(body, (n) => n.className === 'vendor-list')?.children ?? []).filter((n) => n.dataset?.key)
  check('左栏列出了两份档案', rowsOf().length === 2, String(rowsOf().length))
  check(
    '两份就是 fixture 里那两份（不是只剩当前那份）',
    rowsOf().map((r) => r.dataset.key).join(',') === 'custom,kimi',
    rowsOf().map((r) => r.dataset.key).join(','),
  )
  check('当前使用的那份带徽标', textOf(vendorRowOf('custom')).includes('当前使用'), textOf(vendorRowOf('custom')))
  check('别的那份没有徽标', !textOf(vendorRowOf('kimi')).includes('当前使用'), textOf(vendorRowOf('kimi')))
  // 「选中」与「当前使用」是两个状态：默认落在当前使用的 `custom` 上（它不在列表第一位，
  // 判据混成一套的话这条立刻红）
  check('默认选中的是当前使用那份', vendorRowOf('custom')?.className.includes('is-selected'), vendorRowOf('custom')?.className)
  check('选中不靠「当前使用」那个徽标表示', !vendorRowOf('kimi')?.className.includes('is-selected'))

  check('右栏画的是选中那份的接口地址', editLineOf('接口地址')?.children[0].value === 'http://127.0.0.1:9/v1', editLineOf('接口地址')?.children[0].value)
  check('右栏画的是选中那份的模型', editLineOf('默认模型')?.children[0].value === 'desk-model', editLineOf('默认模型')?.children[0].value)
  const keySourceText = textOf(rowValue('密钥来源'))
  check('自定义地址的密钥来源指向通用变量', keySourceText.includes('CLAUDA_API_KEY'), keySourceText)

  // ---- 点左栏：只换「正在改谁」，一个请求都不该发
  const callsBefore = app.calls.length
  vendorRowOf('kimi').click()
  await tick()
  check('点左栏不发任何写请求', app.calls.length === callsBefore, app.calls.slice(callsBefore).join(','))
  check('点过之后高亮跟着走', vendorRowOf('kimi')?.className.includes('is-selected'), vendorRowOf('kimi')?.className)
  check('上一份不再高亮', !vendorRowOf('custom')?.className.includes('is-selected'))
  check('右栏换成了 Kimi 的接口地址', editLineOf('接口地址')?.children[0].value === 'https://api.moonshot.cn/v1', editLineOf('接口地址')?.children[0].value)
  check('右栏换成了 Kimi 的模型', editLineOf('默认模型')?.children[0].value === 'kimi-k2.6', editLineOf('默认模型')?.children[0].value)
  check('切换选中之后密钥提示也换了', textOf(rowValue('密钥来源')).includes('MOONSHOT_API_KEY'), textOf(rowValue('密钥来源')))
  // 预置表里那句坑位提醒是这个表的**主要价值**，得画出来（`modelText` 是切之前抓的，得重取）
  const kimiNote = app.vendors.find((v) => v.key === 'kimi').note
  check('右栏带上了该厂商的坑位提醒', textOf(body).includes(kimiNote.slice(0, 12)), `找不到「${kimiNote.slice(0, 12)}」`)

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
  // 写的是**选中的那份**（kimi），不是当前使用的 `custom` —— 这是「同时配多家」的立足点
  check('存模型带上了选中的档案名', app.savedModels.at(-1).profileKey === 'kimi', JSON.stringify(app.savedModels.at(-1)))
  check('写完提示了写到哪个文件', textOf(app.el('notices')).includes('config.json'), textOf(app.el('notices')))
  check('改完别的那份（custom）的模型没被动', app.projectInfo.profiles.find((p) => p.key === 'custom').model === 'desk-model')

  // 手填接口地址走另一条通道，同样带档案名
  const customUrlBefore = app.projectInfo.profiles.find((p) => p.key === 'custom').baseUrl
  const zhipu = app.vendors.find((v) => v.key === 'zhipu') ?? app.vendors[2]
  const urlInput = editLineOf('接口地址').children[0]
  urlInput.value = zhipu.baseUrl
  editLineOf('接口地址').children[1].click()
  await tick()
  check(
    '点「存为接口地址」发了 set-base-url、带上地址与档案名',
    app.savedBaseUrls.at(-1)?.baseUrl === zhipu.baseUrl &&
      app.savedBaseUrls.at(-1)?.cwd === 'C:/p' &&
      app.savedBaseUrls.at(-1)?.profileKey === 'kimi',
    JSON.stringify(app.savedBaseUrls),
  )
  // 厂商 key 由主进程按 baseUrl 反推后下发，界面只查表 —— 换成智谱的地址，密钥来源
  // 那句真话得跟着变（认错就是「照着设了变量然后对着 401 不知道哪儿错了」）
  check('换地址后密钥来源跟着推导结果走', textOf(rowValue('密钥来源')).includes('ZHIPU_API_KEY'), textOf(rowValue('密钥来源')))
  check(
    '改 kimi 的地址没顺手动了 custom 的',
    app.projectInfo.profiles.find((p) => p.key === 'custom').baseUrl === customUrlBefore,
    app.projectInfo.profiles.map((p) => `${p.key}:${p.baseUrl}`).join(' '),
  )

  // ---- 右栏那两个动作：切当前使用 / 删档案
  const actionsOf = () => find(body, (n) => n.className === 'vendor-actions')
  const activateBtn = () => actionsOf().children[0]
  const removeBtn = () => actionsOf().children[1]
  check('右栏有「设为当前使用的厂商」', activateBtn().textContent === '设为当前使用的厂商', activateBtn().textContent)
  check('非当前使用的那份，这个按钮是能点的', activateBtn().disabled === false)

  activateBtn().click()
  await tick()
  check('点它发了 set-active-provider 且带上了档案名', app.savedActive.at(-1)?.profileKey === 'kimi', JSON.stringify(app.savedActive))
  check('切完徽标落到 kimi 上', textOf(vendorRowOf('kimi')).includes('当前使用'), textOf(vendorRowOf('kimi')))
  check('原来那份的徽标撤了', !textOf(vendorRowOf('custom')).includes('当前使用'), textOf(vendorRowOf('custom')))
  check('已经是当前使用，按钮就该禁用', activateBtn().disabled === true)

  // ---- 「+ 添加厂商」只列还没配过的那几家
  const addSelect = find(body, (n) => n.getAttribute('aria-label') === '添加厂商')
  check('添加厂商那一格是个选择器', addSelect !== null)
  const addValues = addSelect.children.map((o) => o.value)
  check('配过的厂商不再出现在添加列表里', !addValues.includes('kimi') && !addValues.includes('custom'), addValues.join(','))
  check('没配过的那几家在列表里', addValues.includes('deepseek'), addValues.join(','))
  check('「自定义」排在最后', addValues.at(-1) === '__custom__', addValues.join(','))
  check('首项是那句占位提示', addValues[0] === '' && addSelect.children[0].textContent === '+ 添加厂商')

  addSelect.value = 'deepseek'
  addSelect.fire('change')
  await tick()
  check('选完发了 add-profile', app.savedProfileAdds.at(-1)?.vendorKey === 'deepseek', JSON.stringify(app.savedProfileAdds))
  check('下拉自己归位到占位项（它不是个状态）', find(body, (n) => n.getAttribute('aria-label') === '添加厂商').value === '')
  check('新加的那份出现在左栏', rowsOf().map((r) => r.dataset.key).join(',') === 'custom,kimi,deepseek', rowsOf().map((r) => r.dataset.key).join(','))
  check('新加的那份被选中（用户接着要填它的地址）', vendorRowOf('deepseek')?.className.includes('is-selected'), vendorRowOf('deepseek')?.className)
  // 加一份 ≠ 切过去：正在用的还是 kimi
  check('加一份档案不会顺手把正在用的换掉', textOf(vendorRowOf('kimi')).includes('当前使用'), textOf(vendorRowOf('kimi')))

  // ---- 删档案：两步确认；当前使用那份删不掉
  check('新加的那份可以删', removeBtn().disabled === false, String(removeBtn().disabled))
  check('第一步是「删除」两个字', removeBtn().textContent === '删除', removeBtn().textContent)
  removeBtn().click()
  await tick()
  check('点第一下还没删，只换成确认那一对', app.savedRemovals.length === 0, JSON.stringify(app.savedRemovals))
  const confirmBox = actionsOf().children[1]
  check('确认那一对是「确认删除 + 取消」', confirmBox.className === 'vendor-confirm' && confirmBox.children.length === 2, confirmBox.className)
  check('「取消」和「确认删除」一样显眼（都在）', confirmBox.children[1].textContent === '取消', confirmBox.children[1].textContent)
  confirmBox.children[1].click()
  await tick()
  check('点「取消」不发任何请求', app.savedRemovals.length === 0, JSON.stringify(app.savedRemovals))
  check('取消之后按钮回到「删除」', removeBtn().textContent === '删除', removeBtn().textContent)

  removeBtn().click()
  await tick()
  actionsOf().children[1].children[0].click()
  await tick()
  check('点「确认删除」才真的删', app.savedRemovals.at(-1)?.profileKey === 'deepseek', JSON.stringify(app.savedRemovals))
  check('删掉的那份从左栏消失了', rowsOf().map((r) => r.dataset.key).join(',') === 'custom,kimi', rowsOf().map((r) => r.dataset.key).join(','))
  check('删完之后选中落回当前使用那份', vendorRowOf('kimi')?.className.includes('is-selected'), vendorRowOf('kimi')?.className)
  // 删掉当前使用那份会让 activeProvider 指向一个不存在的名字，配置会静默退回内置默认值
  check('当前使用那份的删除按钮是禁用的', removeBtn().disabled === true, String(removeBtn().disabled))
  check('禁用原因写在 title 上，不是干脆不画', removeBtn().title.includes('当前使用'), removeBtn().title)

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

  // ------------------------------------------------------ 设置页：手动新增 / 删除
  //
  // 四条通道的桩在 `renderer-dom.mjs` 里是**显式实现**的。落到兜底的 `{ok:true}` 上的话，
  // 这一整块会「绿着骗人」—— 保存了、磁盘没变，测试也报成功。
  const findAll = (node, pred, out = []) => {
    if (pred(node)) out.push(node)
    for (const child of node.children) findAll(child, pred, out)
    return out
  }
  const ctlIn = (root, label) => find(root, (n) => n.getAttribute?.('aria-label') === label)

  // ---- MCP 页：新增表单
  app.mcp.fail = {}
  const mcpOpen = find(app.el('settings-body'), (n) => n.className === 'form-open')
  check('MCP 页有「+ 新增 MCP 服务器」入口', mcpOpen?.textContent === '+ 新增 MCP 服务器', mcpOpen?.textContent)
  mcpOpen.click()
  await tick()

  const mcpBody = app.el('settings-body')
  check(
    '表单展开后有名字 / 类型 / 范围',
    ctlIn(mcpBody, '服务器名') !== null && ctlIn(mcpBody, '类型') !== null && ctlIn(mcpBody, '范围') !== null,
  )
  check(
    '范围默认「本项目」（写全局会波及每个项目，不该是默认值）',
    ctlIn(mcpBody, '范围').value === 'project',
    ctlIn(mcpBody, '范围').value,
  )

  const groups = findAll(mcpBody, (n) => n.className === 'form-group')
  check('stdio / http 两组字段各占一块', groups.length === 2, String(groups.length))
  check('缺省是 stdio：命令那一组露着、URL 那组藏着', groups[0].hidden === false && groups[1].hidden === true)
  const typeCtl = ctlIn(mcpBody, '类型')
  typeCtl.value = 'http'
  typeCtl.fire('change')
  check('切到 http 就换成 URL 那一组（用不上的藏掉，不留着让人填错）', groups[0].hidden === true && groups[1].hidden === false)
  typeCtl.value = 'stdio'
  typeCtl.fire('change')

  // 打字不能被打断：一次**与表单无关**的重画（别的会话在跑）之后，输入框得是同一个节点、
  // 字还在。指纹里混进输入框的值就会在这里挂掉 —— 那是全套增量重绘的立足点
  const mcpNameInput = ctlIn(mcpBody, '服务器名')
  mcpNameInput.value = 'filesystem'
  mcpNameInput.fire('input')
  app.emit('s1', { type: 'session-status', status: 'running' })
  const mcpNameAfter = ctlIn(app.el('settings-body'), '服务器名')
  check(
    '无关的重画不重建表单（正在打的字和焦点都还在）',
    mcpNameAfter === mcpNameInput && mcpNameAfter.value === 'filesystem',
    String(mcpNameAfter?.value),
  )

  const mcpAddsBefore = app.savedMcpAdds.length
  ctlIn(app.el('settings-body'), '命令').value = 'node'
  ctlIn(app.el('settings-body'), '参数').value = 'tests/mock-mcp.mjs'
  find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  const addPayload = app.savedMcpAdds.at(-1)
  check('点「保存并连接」发了 mcp/add', app.savedMcpAdds.length === mcpAddsBefore + 1, JSON.stringify(app.savedMcpAdds))
  check(
    '发出去的是 stdio + 那条命令，范围跟着选的那一项',
    addPayload?.name === 'filesystem' &&
      addPayload?.scope === 'project' &&
      addPayload?.config?.type === 'stdio' &&
      addPayload?.config?.command === 'node' &&
      JSON.stringify(addPayload?.config?.args) === '["tests/mock-mcp.mjs"]',
    JSON.stringify(addPayload),
  )
  check('空行的参数不会变成空串参数', addPayload?.config?.args.length === 1)
  check(
    '加完表单收起来了',
    find(app.el('settings-body'), (n) => n.className === 'form-open') !== null,
    String(find(app.el('settings-body'), (n) => n.className === 'primary')),
  )
  check(
    '新加的那台出现在列表里',
    find(app.el('settings-body'), (n) => n.dataset?.name === 'filesystem') !== null,
  )
  check('提示里写了写到哪个文件', textOf(app.el('notices')).includes('config.json'), textOf(app.el('notices')))

  // 空地址必须当场拦下：跑一趟 IPC 才拿到报错，用户看到的会是一句更绕的话
  find(app.el('settings-body'), (n) => n.className === 'form-open').click()
  await tick()
  ctlIn(app.el('settings-body'), '服务器名').value = 'no-url'
  find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  check('没填命令就保存：本地就拦下，不发请求', app.savedMcpAdds.at(-1).name === 'filesystem', JSON.stringify(app.savedMcpAdds.at(-1)))
  check('说了缺什么', textOf(app.el('notices')).includes('命令不能为空'), textOf(app.el('notices')))
  find(app.el('settings-body'), (n) => n.className === 'ghost').click()
  await tick()
  check('点「取消」不会留下半个表单', find(app.el('settings-body'), (n) => n.className === 'primary') === null)

  // ---- MCP：两步删除
  const rowOfMcp = (name) => find(app.el('settings-body'), (n) => n.dataset?.name === name)
  const delBtnOf = (name) => find(rowOfMcp(name), (n) => n.className === 'form-del')
  check('每一行末尾有删除', delBtnOf('broken')?.textContent === '删除', delBtnOf('broken')?.textContent)
  check('开关仍然是这一行的第一个孩子（顺序是契约）', rowOfMcp('broken').children[0].type === 'checkbox')

  const mcpRemovalsBefore = app.savedMcpRemovals.length
  delBtnOf('broken').click()
  await tick()
  check('点第一下还没删', app.savedMcpRemovals.length === mcpRemovalsBefore, JSON.stringify(app.savedMcpRemovals))
  const mcpConfirm = find(rowOfMcp('broken'), (n) => n.className === 'vendor-confirm')
  check('只换成「确认删除 + 取消」那一对', mcpConfirm?.children.length === 2, mcpConfirm?.className)
  mcpConfirm.children[1].click()
  await tick()
  check('点「取消」不发请求', app.savedMcpRemovals.length === mcpRemovalsBefore, JSON.stringify(app.savedMcpRemovals))
  check('取消之后按钮回到「删除」', delBtnOf('broken')?.textContent === '删除', delBtnOf('broken')?.textContent)

  delBtnOf('broken').click()
  await tick()
  find(rowOfMcp('broken'), (n) => n.className === 'vendor-confirm').children[0].click()
  await tick()
  check(
    '点「确认删除」才真的删，且带上服务器名',
    app.savedMcpRemovals.at(-1)?.name === 'broken' && app.savedMcpRemovals.at(-1)?.cwd === 'C:/p',
    JSON.stringify(app.savedMcpRemovals),
  )
  check('删掉的那台从列表里消失了', rowOfMcp('broken') === null)
  check('剩下的那台还在', rowOfMcp('demo') !== null)

  // ---- 技能页：新增表单 + 两步删除
  app.el('nav-skills').click()
  await tick()
  const skillBody = app.el('settings-body')
  const skillRowOf = (name) => find(skillBody, (n) => n.dataset?.name === name && n.className === 'skill-row')
  check('技能行挂上了 dataset.name（按名字精确定位）', skillRowOf('demo') !== null)

  find(skillBody, (n) => n.className === 'form-open').click()
  await tick()
  check(
    '技能表单展开了（名字 / 说明 / 正文 / 范围）',
    ['技能名', '说明', '正文', '范围'].every((l) => ctlIn(app.el('settings-body'), l) !== null),
  )
  check(
    '技能范围默认「全局」（决策 1：配一次到处能用）',
    ctlIn(app.el('settings-body'), '范围').value === 'global',
    ctlIn(app.el('settings-body'), '范围').value,
  )

  const skillAddsBefore = app.savedSkillAdds.length
  ctlIn(app.el('settings-body'), '技能名').value = 'weekly-report'
  ctlIn(app.el('settings-body'), '说明').value = '每周汇总'
  ctlIn(app.el('settings-body'), '正文').value = '第一步…'
  find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  const skillPayload = app.savedSkillAdds.at(-1)
  check('点「保存技能」发了 skill/add', app.savedSkillAdds.length === skillAddsBefore + 1, JSON.stringify(app.savedSkillAdds))
  check(
    '名字 / 说明 / 正文 / 范围都带上去了',
    skillPayload?.name === 'weekly-report' &&
      skillPayload?.description === '每周汇总' &&
      skillPayload?.body === '第一步…' &&
      skillPayload?.scope === 'global' &&
      skillPayload?.cwd === 'C:/p',
    JSON.stringify(skillPayload),
  )
  check('加完列表里多了一个', skillRowOf('weekly-report') !== null)
  check('技能数画进了导航徽标', app.el('badge-skills').textContent === '2', app.el('badge-skills').textContent)

  // 失败必须报出来，且表单留着让人改一个字重试
  app.skillBehavior.fail = '技能名只能用小写字母、数字和连字符'
  find(app.el('settings-body'), (n) => n.className === 'form-open').click()
  await tick()
  ctlIn(app.el('settings-body'), '技能名').value = '中文名'
  find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  check('保存失败时报出主进程那句话', textOf(app.el('notices')).includes('小写字母'), textOf(app.el('notices')))
  check('失败后表单留着，不用重打一遍', ctlIn(app.el('settings-body'), '技能名') !== null)
  app.skillBehavior.fail = null
  find(app.el('settings-body'), (n) => n.className === 'ghost').click()
  await tick()

  const skillRemovalsBefore = app.savedSkillRemovals.length
  find(skillRowOf('weekly-report'), (n) => n.className === 'form-del').click()
  await tick()
  check('点第一下还没删', app.savedSkillRemovals.length === skillRemovalsBefore, JSON.stringify(app.savedSkillRemovals))
  const skillConfirm = find(skillRowOf('weekly-report'), (n) => n.className === 'vendor-confirm')
  check('只换成确认那一对', skillConfirm?.children.length === 2, skillConfirm?.className)
  skillConfirm.children[0].click()
  await tick()
  check(
    '点「确认删除」才真的删，带的是技能名',
    app.savedSkillRemovals.at(-1)?.name === 'weekly-report' && app.savedSkillRemovals.at(-1)?.cwd === 'C:/p',
    JSON.stringify(app.savedSkillRemovals),
  )
  check('删掉的那个从列表里消失了', skillRowOf('weekly-report') === null)
  check('技能数跟着退回去', app.el('badge-skills').textContent === '1', app.el('badge-skills').textContent)

  // ---- 空态也得能新增
  //
  // 早先两个 block 都是「列表为空就 return 一句空话」，那正是**最需要**那个按钮的一刻，
  // 而它偏偏什么都不给 —— 用户只能回去手写文件。清空快照逼出空态，再确认入口还在
  app.projectInfo.skills = []
  app.emit('s1', { type: 'session-status', status: 'running' })
  await tick()
  check(
    '一条技能都没有时是空态 + 新增入口',
    textOf(app.el('settings-body')).includes('没有发现技能') &&
      find(app.el('settings-body'), (n) => n.className === 'form-open') !== null,
    textOf(app.el('settings-body')).slice(0, 160),
  )
  app.projectInfo.mcp = []
  app.el('nav-mcp').click()
  await tick()
  check(
    '一台 MCP 服务器都没有时同样留着新增入口',
    textOf(app.el('settings-body')).includes('没有配置 MCP 服务器') &&
      find(app.el('settings-body'), (n) => n.className === 'form-open') !== null,
    textOf(app.el('settings-body')).slice(0, 160),
  )

  // 切回会话视图：三栏布局塌了的话，这里能抓到「视图藏反了」
  app.el('nav-sessions').click()
  await tick()
  check('切回会话视图', app.el('app').dataset.view === 'sessions', app.el('app').dataset.view)
  check('切回后对话区回来了', app.el('view-sessions').hidden === false)
  check('切回后设置容器藏起来了', app.el('view-settings').hidden === true)
  check('切回后消息流还在', app.el('stream').children.length === 1, String(app.el('stream').children.length))

  // ---- 附件：拖拽 / 粘贴 / 选文件 / 发出去
  // 这里的桩只回答「renderer 报了些什么、回来的东西画没画出来」。真字节读得对不对
  // 是 attachment.ts 的单测，请求体里带没带图是 e2e 的事。
  const chips = () => app.el('attach-list').children
  const fileWithPath = (p, name, type = '') => ({ path: p, name, type, size: 100 })

  check('一开始没有附件条，整条是藏着的', chips().length === 0 && app.el('attach-list').hidden === true)

  // `dragover` 不 preventDefault 就没有 drop 事件；不判 types 又会把拖文字也吃掉。
  // 两条都要钉，因为它们错了的表现都是「什么都没发生」
  const fireDrag = (type, dataTransfer) => {
    let prevented = false
    app.el('app').fire(type, { dataTransfer, preventDefault: () => (prevented = true) })
    return prevented
  }
  check('拖文件进来时接住 dragenter', fireDrag('dragenter', { types: ['Files'] }) === true)
  check('接住之后整窗遮罩出来了', app.el('drop-hint').hidden === false)
  check('拖文件时接住 dragover（不接住就没有 drop）', fireDrag('dragover', { types: ['Files'] }) === true)
  check('拖动过程中遮罩不闪（进入计数）', app.el('drop-hint').hidden === false)
  // 拖的是一段选中的文字：不能接管，否则用户没法把文字拖进输入框
  check('拖文字时不去接 dragover', fireDrag('dragover', { types: ['text/plain'] }) === false)

  app.el('app').fire('drop', { dataTransfer: { types: ['Files'], files: [fileWithPath('C:/p/a.png', 'a.png', 'image/png')] } })
  await tick()
  check('松手后遮罩收起来了', app.el('drop-hint').hidden === true)
  check('拖进来的文件变成了一个 chip', chips().length === 1, String(chips().length))
  check('chip 里有缩略图', chips()[0]?.children.some((c) => c.tagName === 'img'), JSON.stringify(chips()[0]?.children.map((c) => c.tagName)))
  check('chip 上写着文件名', textOf(chips()[0]).includes('a.png'), textOf(chips()[0]))
  check('chip 上带着体积', textOf(chips()[0]).includes('12 B'), textOf(chips()[0]))
  check('附件条显示出来了', app.el('attach-list').hidden === false)
  check('拖进来的文件走了磁盘路径那条路', app.ingestCalls.at(-1)?.items[0]?.path === 'C:/p/a.png', JSON.stringify(app.ingestCalls.at(-1)))

  // 同一个文件再拖一次：不该出现两张一模一样的 chip（发出去就是同一张图两遍）
  app.el('app').fire('drop', { dataTransfer: { types: ['Files'], files: [fileWithPath('C:/p/a.png', 'a.png', 'image/png')] } })
  await tick()
  check('同一个文件拖两次不会出现两张 chip', chips().length === 1, String(chips().length))

  app.el('app').fire('drop', {
    dataTransfer: { types: ['Files'], files: [fileWithPath('C:/p/demo.py', 'demo.py'), fileWithPath('C:/p/b.jpg', 'b.jpg', 'image/jpeg')] },
  })
  await tick()
  check('可以一次拖多个', chips().length === 3, String(chips().length))
  check('文本文件没有缩略图，只有一个字形', chips()[1].children[0].className === 'attach-glyph', chips()[1].children[0].className)

  // 粘贴：没有文件时**一个字都不许动**
  let pastePrevented = false
  app.el('input').fire('paste', { clipboardData: { files: [] }, preventDefault: () => (pastePrevented = true) })
  check('粘贴纯文本时不拦（拦了用户就粘不进字）', pastePrevented === false)

  // 粘贴一张截图：没有磁盘路径，只能由 renderer 自己读成 data URL
  app.el('input').fire('paste', {
    clipboardData: { files: [{ path: '', name: 'image.png', type: 'image/png', size: 100 }] },
    preventDefault: () => (pastePrevented = true),
  })
  await tick()
  check('粘贴文件时拦下默认行为（否则文件名会被当文本插进来）', pastePrevented === true)
  check('粘贴的截图也变成了 chip', chips().length === 4, String(chips().length))
  check(
    '没有磁盘路径时改走 dataUrl 那条路',
    app.ingestCalls.at(-1)?.items[0]?.dataUrl?.startsWith('data:image/'),
    JSON.stringify(app.ingestCalls.at(-1)),
  )

  // 点 chip 上的 ×
  chips()[0].children.at(-1).click()
  await tick()
  check('点 × 少一个 chip', chips().length === 3, String(chips().length))

  // 点「附件」按钮走文件选择器
  app.picker.paths = ['C:/p/picked.py']
  await app.el('attach').click()
  await tick()
  check('选文件也能加进来', chips().length === 4, String(chips().length))
  check('选文件只报路径，名字交给主进程定', app.ingestCalls.at(-1)?.items[0]?.name === undefined, JSON.stringify(app.ingestCalls.at(-1)))

  // 只丢一张图、一个字不打就发 —— 旧代码在 `!text` 那里直接返回，这条发不出去
  const before = app.el('stream').children.length
  await app.el('composer').fire('submit')
  await tick()
  const sentPayload = app.sent.at(-1)
  check('空文本 + 有附件也发得出去', sentPayload !== undefined, JSON.stringify(sentPayload))
  check('发出去的 payload 里带着附件', Array.isArray(sentPayload?.attachments) && sentPayload.attachments.length === 4, JSON.stringify(sentPayload?.attachments))
  check('附件带上去了图片的 dataUrl', sentPayload.attachments.some((a) => a.kind === 'image' && a.dataUrl), JSON.stringify(sentPayload.attachments))
  check('气泡立刻多了一条', app.el('stream').children.length === before + 1, String(app.el('stream').children.length))
  const bubble = app.el('stream').children.at(-1).children[0]
  check('气泡里能看见那张图', bubble.children.some((c) => c.className === 'bubble-img'), JSON.stringify(bubble.children.map((c) => c.className)))
  check('发成功后附件清空了', chips().length === 0, String(chips().length))

  // 发送失败时**不能**清附件：清掉再报错，用户得重拖一遍
  app.picker.paths = ['C:/p/again.py']
  await app.el('attach').click()
  await tick()
  check('又挂上一个附件', chips().length === 1, String(chips().length))
  app.sendBehavior.fail = '上一条消息还在处理中'
  await app.el('composer').fire('submit')
  await tick()
  // 错误是当作一条 notice 条目推进消息流的（`state.js` 的 `case 'error'`），
  // 不是顶上那条通知栏
  check('失败时报了错', textOf(app.el('stream')).includes('还在处理中'), textOf(app.el('stream')))
  check('失败后附件还留在输入框上（不白拖）', chips().length === 1, String(chips().length))
  app.sendBehavior.fail = null

  // 丢掉不合规的附件要说一声 —— 「chip 明明在输入框上、发出去却没有」很难查
  app.sendBehavior.dropped = 1
  await app.el('composer').fire('submit')
  await tick()
  check('有附件没发出去时会给个通知', textOf(app.el('notices')).includes('不合规'), textOf(app.el('notices')))
  app.sendBehavior.dropped = 0

  // ------------------------------------------------------ 智能体
  //
  // 四条 `agent/*` 通道的桩同样是**显式实现**的（见 `renderer-dom.mjs`）。落到兜底的
  // `{ok:true}` 上，这一整块会「绿着骗人」—— 保存了、磁盘没变，测试也报成功。

  // ---- 新会话那一格
  const agentPicker = app.el('new-session-agent')
  const pickerOptions = () => agentPicker.children.map((o) => `${o.value}|${o.textContent}`)
  check(
    '「新会话」那一格列出了「不用智能体」+ 全部智能体',
    pickerOptions().join(' ') === '|（不用智能体） code-review|code-review（本项目默认） kimi-chat|kimi-chat',
    pickerOptions().join(' '),
  )
  check('默认选中本项目的那一个', agentPicker.value === 'code-review', agentPicker.value)

  // ---- 左栏
  app.el('nav-agents').click()
  await tick()
  check('点「智能体」切到智能体页', app.el('app').dataset.view === 'agents', app.el('app').dataset.view)
  check('智能体页在模型页前面', app.el('nav-agents').className.includes('is-current'), app.el('nav-agents').className)
  check('导航条上的智能体徽标是这一份项目的个数', app.el('badge-agents').textContent === '2', app.el('badge-agents').textContent)

  const agentRowsNow = () => findAll(app.el('settings-body'), (n) => n.className === 'agent-row')
  const pickOfRow = (box) => box.children[0]
  const draftCtl = (label) => ctlIn(app.el('settings-body'), label)
  const draftSelect = (label) => draftCtl(label)

  let rows = agentRowsNow()
  check('左栏每份智能体一行', rows.length === 2, String(rows.length))
  check('行的选中把手挂着自己的名字（点它才认得出点的是谁）', pickOfRow(rows[0]).dataset.name === 'code-review', pickOfRow(rows[0]).dataset.name)
  check('默认的那行标了「默认」', pickOfRow(rows[0]).children[1].textContent === '默认', pickOfRow(rows[0]).children[1].textContent)
  check('非默认的那行不标', pickOfRow(rows[1]).children[1].textContent === '', JSON.stringify(pickOfRow(rows[1]).children[1].textContent))
  check('描述画在行里', textOf(rows[0]).includes('按严重程度审查改动'), textOf(rows[0]))
  check('降级提示摆在脸上（不能让用户自己发现档案没了）', textOf(rows[1]).includes('档案「kimi」找不到'), textOf(rows[1]))
  check('非默认那行有「设为默认」', find(rows[1], (n) => n.className === 'agent-default') !== null)
  check(
    '已经默认的那行不画「设为默认」（画一个点了没反应的按钮不如不画）',
    find(rows[0], (n) => n.className === 'agent-default') === null,
  )
  check('还没选任何一份时右栏是一句指路的话，不是空表单', textOf(app.el('settings-body')).includes('点一个智能体来编辑'), textOf(app.el('settings-body')))

  // ---- 点一行：正文只能走 `agent/get`
  const getsBefore = app.calls.filter((c) => c === 'agent/get').length
  pickOfRow(rows[1]).click()
  await tick()
  check('点一行去读这一份', app.calls.filter((c) => c === 'agent/get').length === getsBefore + 1)
  check('右栏填进了这一份的正文', draftCtl('系统提示词').value === '你是个随和的助手。', JSON.stringify(draftCtl('系统提示词').value))
  check('描述也填了', draftCtl('描述').value === '闲聊用的', JSON.stringify(draftCtl('描述').value))
  check(
    '温度「没写这个键」读成空栏，不是 0（折成 0 会把档案的温度钉死）',
    draftCtl('温度').value === '',
    JSON.stringify(draftCtl('温度').value),
  )
  check('权限模式没写也读成空', draftSelect('权限模式').value === '', JSON.stringify(draftSelect('权限模式').value))
  check('范围跟着这一份（全局那份来自 ~/.clauda）', draftSelect('范围').value === 'global', draftSelect('范围').value)

  rows = agentRowsNow()
  pickOfRow(rows[0]).click()
  await tick()
  check('换一份编辑，右栏整套填过去', draftCtl('名字').value === 'code-review', JSON.stringify(draftCtl('名字').value))
  check('温度 0 是有效值，读成「0」而不是空', draftCtl('温度').value === '0', JSON.stringify(draftCtl('温度').value))
  check('逗号分隔的名单读成一行', draftCtl('工具白名单').value === 'read_file, grep', JSON.stringify(draftCtl('工具白名单').value))
  check('免问 / 禁用各读各的', draftCtl('免问规则').value === 'write_file' && draftCtl('禁用规则').value === 'Bash(rm:*)', `${draftCtl('免问规则').value} / ${draftCtl('禁用规则').value}`)
  check('技能白名单读回来了', draftCtl('技能白名单').value === 'demo', JSON.stringify(draftCtl('技能白名单').value))
  check(
    '常见问题按行拆开（比塞 | 好敲）',
    draftCtl('常见问题').value === '这次改动有什么风险？\n跑测试要装什么，怎么装？',
    JSON.stringify(draftCtl('常见问题').value),
  )
  check('档案那一栏是名字不是端点', draftSelect('厂商档案').value === 'custom', draftSelect('厂商档案').value)
  check(
    '右栏一个字都不带密钥',
    !textOf(app.el('settings-body')).includes('····') && !textOf(app.el('settings-body')).includes('127.0.0.1'),
    textOf(app.el('settings-body')),
  )

  // 打字不能被打断：一次**与表单无关**的重画（别的会话在跑）之后，输入框得是同一个节点、字还在。
  // 草稿里那些会变的字段一旦进指纹（`ad${loaded}` 旁边），这里当场就挂
  const nameCtl = draftCtl('名字')
  nameCtl.value = 'review-2'
  nameCtl.fire('input')
  app.emit('s1', { type: 'session-status', status: 'running' })
  await tick()
  const nameAfter = draftCtl('名字')
  check(
    '无关的重画不重建表单（正在打的字和焦点都还在）',
    nameAfter === nameCtl && nameAfter.value === 'review-2',
    String(nameAfter?.value),
  )

  // ---- 保存：`agent/add` 收的是数组，不是分隔符字符串
  draftCtl('工具白名单').value = 'read_file, grep, glob'
  draftCtl('工具白名单').fire('input')
  draftCtl('常见问题').value = '第一条？\n\n第二条？'
  draftCtl('常见问题').fire('input')
  draftCtl('温度').value = '0.7'
  draftCtl('温度').fire('input')

  await find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  const agentAdd = app.savedAgentAdds.at(-1)
  check('保存走了 `agent/add`', agentAdd !== undefined, JSON.stringify(agentAdd))
  check('工具白名单发的是数组', Array.isArray(agentAdd?.tools) && agentAdd.tools.join(',') === 'read_file,grep,glob', JSON.stringify(agentAdd?.tools))
  check('常见问题发的是数组，空行被丢掉', Array.isArray(agentAdd?.questions) && agentAdd.questions.join('|') === '第一条？|第二条？', JSON.stringify(agentAdd?.questions))
  check('温度发的是数字 0.7', agentAdd?.temperature === 0.7, JSON.stringify(agentAdd?.temperature))
  check('正文原样发过去', agentAdd?.body === '你是一名严格的代码审查员。', JSON.stringify(agentAdd?.body))
  check('改过的名字当成新的一份写', agentAdd?.name === 'review-2', JSON.stringify(agentAdd?.name))
  check('新建的那条通知说「新建」', textOf(app.el('notices')).includes('已新建智能体「review-2」'), textOf(app.el('notices')))
  rows = agentRowsNow()
  check('左栏当场多出一行（保存完不用手动刷）', rows.length === 3 && pickOfRow(rows[2]).dataset.name === 'review-2', rows.map((r) => pickOfRow(r).dataset.name).join(','))
  check('刚保存的那行高亮着', pickOfRow(rows[2]).className.includes('is-selected'), pickOfRow(rows[2]).className)

  // 再存一次同名 = 覆盖，通知该说「保存」而不是又「新建」
  await find(app.el('settings-body'), (n) => n.className === 'primary').click()
  await tick()
  check('同名第二次写报「保存」而不是「新建」', textOf(app.el('notices')).includes('已保存智能体「review-2」'), textOf(app.el('notices')))
  check('没有写下第二份重名文件', agentRowsNow().length === 3, String(agentRowsNow().length))

  // ---- 设为默认
  rows = agentRowsNow()
  check('刚新建的那份不是默认', pickOfRow(rows[2]).children[1].textContent === '', JSON.stringify(pickOfRow(rows[2]).children[1].textContent))
  find(rows[2], (n) => n.className === 'agent-default').click()
  await tick()
  check('设默认走了 `project/set-default-agent`', app.savedAgentDefaults.at(-1)?.name === 'review-2', JSON.stringify(app.savedAgentDefaults.at(-1)))
  check('默认搬到这一份上了', app.projectInfo.defaultAgent === 'review-2', app.projectInfo.defaultAgent)
  rows = agentRowsNow()
  check('徽标跟着搬（点完当场看得见）', pickOfRow(rows[2]).children[1].textContent === '默认', pickOfRow(rows[2]).children[1].textContent)
  check('原来那行的徽标摘掉了', pickOfRow(rows[0]).children[1].textContent === '', JSON.stringify(pickOfRow(rows[0]).children[1].textContent))
  check('新会话那一格跟着改（默认项换了）', pickerOptions()[3] === 'review-2|review-2（本项目默认）', pickerOptions().join(' '))

  // ---- 删除：两步确认
  const delsBefore = app.savedAgentRemovals.length
  find(app.el('settings-body'), (n) => n.className === 'danger').click()
  await tick()
  check('第一下只是问一句，不准删', app.savedAgentRemovals.length === delsBefore, String(app.savedAgentRemovals.length))
  const agentConfirm = find(app.el('settings-body'), (n) => n.className === 'vendor-confirm')
  check('确认那一对按钮上写着要删谁', agentConfirm?.children[0].textContent === '确认删除「review-2」', agentConfirm?.children[0].textContent)
  agentConfirm.children[0].click()
  await tick()
  check('第二下才真删（走 `agent/remove`）', app.savedAgentRemovals.at(-1)?.name === 'review-2', JSON.stringify(app.savedAgentRemovals.at(-1)))
  check('左栏那一行没了', agentRowsNow().length === 2, String(agentRowsNow().length))
  check('删完草稿作废，回到「还没选」', textOf(app.el('settings-body')).includes('点一个智能体来编辑'), textOf(app.el('settings-body')))

  // ---- 中栏顶栏那一格 + 空态可点问题
  agentPicker.value = 'kimi-chat'
  await app.el('new-session').click()
  await tick()
  check('顶栏写着**这一个会话**绑的智能体', app.el('chat-agent').textContent === '智能体 kimi-chat', app.el('chat-agent').textContent)
  check('这一格不是藏着的', app.el('chat-agent').hidden === false)
  check('这一份没有常见问题，空态就不显示', app.el('empty-questions').hidden === true)

  agentPicker.value = 'code-review'
  await app.el('new-session').click()
  await tick()
  check('换个智能体开会话，顶栏跟着换', app.el('chat-agent').textContent === '智能体 code-review', app.el('chat-agent').textContent)
  check('选定智能体的那一格说明是「（不用智能体）」也在', pickerOptions()[0] === '|（不用智能体）', pickerOptions()[0])
  check('这一份有常见问题，空态就列出来', app.el('empty-questions').hidden === false)
  check('空态标题点名了是谁在问', textOf(app.el('empty-questions')).includes('code-review 常问到'), textOf(app.el('empty-questions')))
  const qButtons = findAll(app.el('empty-questions'), (n) => n.className === 'empty-question')
  check('两条问题各是一个按钮', qButtons.length === 2, String(qButtons.length))
  check('问题原文就是按钮上的字', qButtons[0].textContent === '这次改动有什么风险？', qButtons[0].textContent)

  const sentBefore = app.sent.length
  const inputBefore = app.el('input').value
  qButtons[1].click()
  await tick()
  check('点一条问题就当作发出去了', app.sent.length === sentBefore + 1, `${sentBefore} -> ${app.sent.length}`)
  check('发出去的是那条问题的原文', app.sent.at(-1)?.text === '跑测试要装什么，怎么装？', JSON.stringify(app.sent.at(-1)?.text))
  check(
    '不经过输入框（用户没打的字不会在输入框里闪一下）',
    app.el('input').value === inputBefore,
    JSON.stringify(app.el('input').value),
  )
  check('发出去了以后空态就收了', app.el('empty-questions').hidden === true)
  check('消息流里多了这一条', app.el('stream').children.length === 1, String(app.el('stream').children.length))

  // ---- 名字给过、智能体却已经不在了：**警告一次，会话照开**
  // （下拉里本来不该出现没有的值，这里直接塞一个模拟下拉里的牌子过期）
  agentPicker.value = 'gone-agent'
  await app.el('new-session').click()
  await tick()
  check('智能体不在了也照样开会话，只是没绑', app.el('chat-agent').hidden === true, JSON.stringify(app.el('chat-agent').textContent))
  check(
    '通知栏说了一声「它已经不在了」',
    textOf(app.el('notices')).includes('智能体「gone-agent」已经不在了'),
    textOf(app.el('notices')),
  )
  // 去重：`session/state` 是高频的，每来一次快照弹一次会把通知栏刷满
  app.emit('s6', { type: 'session-state', session: { agentWarning: '智能体「gone-agent」已经不在了，这个会话按默认配置打开' } })
  const warned = textOf(app.el('notices')).split('已经不在了').length - 1
  check('同一条警告只弹一次', warned === 1, String(warned))

  uninstallDom()
}

// 「Electron 只活在 desktop/ 里」是这次改动最容易被无声破坏的架构约束：某天有人在
// src/runtime 里顺手 `import { app } from 'electron'`，本地能跑、测试全绿，只有真正
// 打包或换外壳时才炸。把约束写成断言，破坏它的那一刻就红。
// 会话落盘与记忆库都挂在 CLAUDA_HOME 下，单测**绝不能**写进用户真实的 `~/.clauda/`。
// 入口那一行已经把它指到临时目录，这一条防的是「谁把它改掉 / 删掉，或者某个块中途改了
// 没还原」—— 所以放在**所有块都跑完之后**看，而不是入口看一次就算了。
console.log('\n== 自检：全程跑在临时 home 上 ==')
{
  const home = process.env.CLAUDA_HOME ?? ''
  const real = path.join(os.homedir(), '.clauda')
  check(
    'CLAUDA_HOME 仍指着临时目录（而不是被谁改了、删了）',
    home !== '' && path.resolve(home).startsWith(path.resolve(os.tmpdir())),
    home || '(被删掉了)',
  )
  check('不是用户真实的 home', home === '' || path.resolve(home) !== path.resolve(real), home)
}

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

  // 左栏那一项和页标题**故意**不叫「MCP 服务器」：用户在那一页上装的是「能让 agent 干活的东西」，
  // 所以标签给的是「工具」；正文里则保留「MCP 服务器」—— 一个服务器会带出很多个工具，丢掉这个
  // 名字会让「服务器连不上」和「工具没接上」变成同一句话。这条断言钉的就是这个**不对称**：
  // 哪天有人顺手把两边「统一」了，这里会红，而窗口上看不出问题。
  const navMcp = html.slice(html.indexOf('id="nav-mcp"'), html.indexOf('</button>', html.indexOf('id="nav-mcp"')))
  check('左栏那一项写的是「工具」', navMcp.includes('>工具</span>'), navMcp)
  const mcpMeta = appJs.match(/mcp:\s*\{[^}]*\}/)?.[0] ?? ''
  check('工具页的标题是「工具」', mcpMeta.includes("title: '工具'"), mcpMeta.slice(0, 40))
  check('工具页正文仍写「MCP 服务器」', mcpMeta.includes('由 MCP 服务器提供'), mcpMeta.slice(0, 40))

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
