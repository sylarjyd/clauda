import { listMemories } from '../agent/memory-store.js'
import { loadConfig, type CliOverrides } from '../config.js'
import { McpManager } from '../mcp/manager.js'
import { SkillRegistry } from '../skills/registry.js'
import { createToolAssembly } from './tools-assembly.js'
import type { SessionProject } from './session-manager.js'

export interface ProjectRuntimeOptions {
  cwd: string
  version: string
  /** 命令行 / 启动参数层，优先级最高 */
  overrides?: CliOverrides
  /** MCP 的连接失败等警告要有个去处 */
  onWarn?(msg: string): void
}

/**
 * 建一个项目的运行时：配置、技能、MCP、工具装配。
 *
 * **这里不建 provider。** 早先建了一个共享实例发给所有会话，改接口地址就会直接钻到
 * 活会话里；现在 provider 归会话自己，在 `SessionManager.openSession` 里按会话克隆的
 * 配置建。这条运行时只留模板配置与「跟进程绑定」的东西（技能、MCP 子进程、工具装配）。
 *
 * **`loadConfig` 必须包在 env 快照里。** 它内部的 dotenv 是改全局 `process.env` 的，
 * 而且不覆盖已存在的键 —— 桌面端同时开着 A、B 两个项目时，先加载的那个会把键留在
 * 环境里，后加载的那个 `.env` 静默失效、继承前一个项目的配置。表现是「切到另一个
 * 项目后模型/接口地址莫名不对」，排查时根本想不到是 env 串了。
 *
 * 注意副作用：项目 `.env` 里设的 `CLAUDA_HOME` 不会保留到加载之后（它正是被还原的键之一），
 * 所以 `CLAUDA_HOME` 请走真实环境变量。
 */
export async function createProjectRuntime(opts: ProjectRuntimeOptions): Promise<SessionProject> {
  const envBefore = { ...process.env }
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(opts.cwd, opts.overrides ?? {})
  } finally {
    restoreEnv(envBefore)
  }

  const skills = SkillRegistry.discover(opts.cwd)
  const mcp = new McpManager(config.mcpServers ?? {}, {
    version: opts.version,
    view: { warn: opts.onWarn ?? (() => {}) },
  })
  await mcp.start()

  const assembly = createToolAssembly(skills, mcp)

  return {
    cwd: opts.cwd,
    config,
    skills,
    memoryIndex: () => listMemories(),
    assembleTools: assembly.assemble,
    mcp: {
      // 原样把 Promise 交出去，不要在这里 `void` 掉：SessionManager 要 await 它，
      // 连接失败得能冒泡到界面 —— 吞掉的后果是「点了开关，报成功，其实没接上」
      setEnabled: (name, enabled) => mcp.setEnabled(name, enabled),
      status: () => mcp.status(),
      tokenHint: () => mcp.tokenHint(),
      tools: () => mcp.tools(),
    },
    // MCP 子进程不关掉的话，关窗口之后进程会一直活着 —— 表现是「卡住」不是报错
    dispose: () => mcp.closeAll(),
  }
}

/**
 * 只还原这次多出来和被改写的键，不能整个替换 `process.env` ——
 * 期间别的模块设的键会被一起抹掉。
 */
function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in before)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(before)) {
    if (process.env[key] !== value) process.env[key] = value
  }
}
