import type { ToolSpec } from '../types.js'
import { bashTool } from './bash.js'
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from './fs.js'
import { todoWriteTool } from './todo.js'
import type { Tool } from './types.js'

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  todoWriteTool,
]

export function toolSpecs(tools: Tool[] = ALL_TOOLS): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    permission: t.permission,
  }))
}

export function findTool(name: string, tools: Tool[] = ALL_TOOLS): Tool | undefined {
  return tools.find((t) => t.name === name)
}
