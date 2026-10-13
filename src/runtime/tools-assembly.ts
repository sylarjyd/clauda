import type { SkillRegistry } from '../skills/registry.js'
import { ALL_TOOLS } from '../tools/index.js'
import { makeMemoryTools } from '../tools/memory.js'
import { makeSkillTool } from '../tools/skill.js'
import type { Tool } from '../tools/types.js'

/** 只要求 `tools()`，好让装配逻辑不依赖真的 `McpManager`（它会起子进程） */
export interface McpToolSource {
  tools(): Tool[]
}

export interface ToolAssembly {
  /** 内置工具（有技能时多一个 skill 工具）。零技能时就是 `ALL_TOOLS` 本身，不是副本 */
  baseTools: Tool[]
  memoryTools: Tool[]
  /** 每次现算 */
  assemble(): Tool[]
}

/**
 * 工具装配配方。CLI（`index.ts`）和桌面端共用一份，各写各的迟早会漂。
 *
 * 三条语义是从 `index.ts` 原样搬过来的，改的时候别丢：
 * - 技能工具**有条件**注入：一个技能都没有时不挂，省下它 schema 每轮都要付的 token
 * - 记忆工具**无条件**注入：没有记忆时恰恰最需要 `memory_write`，藏起来就永远写不进第一条
 * - `assemble()` **每次现算** `mcp.tools()`：`/mcp off` 之后靠它把新工具集算出来，
 *   快照成数组的话运行期就改不动了
 */
export function createToolAssembly(skills: SkillRegistry, mcp: McpToolSource): ToolAssembly {
  const baseTools = skills.list().length > 0 ? [...ALL_TOOLS, makeSkillTool(skills)] : ALL_TOOLS
  const memoryTools = makeMemoryTools()
  return {
    baseTools,
    memoryTools,
    assemble: () => [...baseTools, ...memoryTools, ...mcp.tools()],
  }
}
