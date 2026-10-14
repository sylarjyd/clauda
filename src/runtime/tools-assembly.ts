import { agentAllowsTool, scopedSkills } from '../agents/apply.js'
import type { HasSkills, HasTools } from '../agents/types.js'
import type { SkillSource } from '../skills/types.js'
import { ALL_TOOLS } from '../tools/index.js'
import { makeMemoryTools } from '../tools/memory.js'
import { makeSkillTool } from '../tools/skill.js'
import type { Tool } from '../tools/types.js'

/** 只要求 `tools()`，好让装配逻辑不依赖真的 `McpManager`（它会起子进程） */
export interface McpToolSource {
  tools(): Tool[]
}

export interface ToolAssembly {
  /** 就是 `ALL_TOOLS`，不含条件注入的那些。要完整的一份用 `assemble()` */
  baseTools: Tool[]
  memoryTools: Tool[]
  /** 每次现算。给了智能体就再按它的白名单过一遍 */
  assemble(agent?: HasTools & HasSkills): Tool[]
}

/**
 * 工具装配配方。CLI（`index.ts`）和桌面端共用一份，各写各的迟早会漂。
 *
 * `extraTools` 是「技能 / MCP 的增删工具」，由调用方建好传进来 —— 它们各自要拿到技能注册表
 * 或 `McpManager`，而这两样只有持有项目运行时的那一层才有。装配层只需要把它们摆进正确的位置。
 *
 * 四条语义，改的时候别丢：
 * - 技能工具**有条件**注入：一个技能都没有时不挂，省下它 schema 每轮都要付的 token
 * - 记忆工具和 `extraTools` **无条件**注入：没有记忆 / 没有技能时恰恰最需要
 *   `memory_write` / `skill_write`，藏起来就永远写不进第一条
 * - `assemble()` **每次现算** `mcp.tools()`：`/mcp off` 之后靠它把新工具集算出来，
 *   快照成数组的话运行期就改不动了
 * - **技能那个条件同样在 `assemble()` 里现算**（原先在函数体外判一次）：现在技能可以在
 *   对话里新建，建完那一刻 `skill` 工具就该出现。判在函数体外的话，「用对话加的第一个技能」
 *   当场用不了 —— 等到某次重新装配才生效
 *
 * **智能体的白名单在最后过一遍，而且是每次现算的。** 这里有两个容易漏的地方：
 *
 * - **必须按会话过滤，不能按项目**：同一个项目下两个会话可以绑不同的智能体。所以 `assemble`
 *   收一个可选的智能体参数、由调用方（`SessionManager`）逐个会话来传，而不是在装配层记住
 *   某一份。比「按智能体名缓存一份装配」省掉一张要失效的缓存表 —— `assemble` 只在建会话 /
 *   广播 / 开轮时跑（不是每 token），对象字面量的开销可以忽略。
 * - **白名单连 `extraTools` 和 `memoryTools` 一起管**：`tools: read_file, grep` 的智能体不光
 *   不能写文件，也不能写技能、写记忆、挂 MCP。「写了 = 只要这些」只有这样读才自洽，代价是
 *   有点反直觉 —— 所以写进了 `CLAUDA.md`。
 */
export function createToolAssembly(
  skills: SkillSource,
  mcp: McpToolSource,
  extraTools: Tool[] = [],
): ToolAssembly {
  const memoryTools = makeMemoryTools()
  return {
    baseTools: ALL_TOOLS,
    memoryTools,
    assemble: (agent) => {
      // 技能视图是**委托**给 `skills` 的：真注册表 refresh 之后它自动跟着变，不用单独刷。
      // 所以 `skill` 工具也得每次现建 —— 它要拿的是这个视图，不是项目那份注册表
      const view = scopedSkills(skills, agent)
      const all = [
        ...ALL_TOOLS,
        ...(view.list().length > 0 ? [makeSkillTool(view)] : []),
        ...memoryTools,
        ...extraTools,
        ...mcp.tools(),
      ]
      // 没有智能体时原样返回同一个数组：
      // `agentAllowsTool` 已经能处理 undefined，但白名单为空时白跑一遍 filter 只是浪费
      return agent?.tools?.length ? all.filter((t) => agentAllowsTool(agent, t.name)) : all
    },
  }
}
