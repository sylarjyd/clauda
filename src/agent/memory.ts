import fs from 'node:fs'
import path from 'node:path'
import { claudaHome } from '../config.js'

export const MEMORY_FILENAME = 'CLAUDA.md'

/**
 * 记忆文件发现顺序（后者内容更重要，放在后面拼进提示词）：
 *   1. 从 cwd 向上到根目录遇到的 CLAUDA.md / .clauda/CLAUDA.md
 *   2. ~/.clauda/CLAUDA.md（全局偏好）
 */
export function discoverMemoryFiles(cwd: string): string[] {
  const found: string[] = []

  let dir = path.resolve(cwd)
  const chain: string[] = []
  for (;;) {
    chain.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 从最外层往里收集，越靠近 cwd 的越靠后
  for (const d of chain.reverse()) {
    for (const candidate of [path.join(d, MEMORY_FILENAME), path.join(d, '.clauda', MEMORY_FILENAME)]) {
      if (fs.existsSync(candidate)) found.push(candidate)
    }
  }

  const global = path.join(claudaHome(), MEMORY_FILENAME)
  if (fs.existsSync(global)) found.push(global)
  return [...new Set(found)]
}

export function loadMemory(cwd: string): { files: string[]; text: string } {
  const files = discoverMemoryFiles(cwd)
  const chunks: string[] = []
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8').trim()
      if (content) chunks.push(`### 来自 ${f}\n\n${content}`)
    } catch {
      // 读不了就跳过，不值得为此中断会话
    }
  }
  return { files, text: chunks.join('\n\n') }
}

export function findProjectMemory(cwd: string): string | null {
  for (const d of [cwd, path.join(cwd, '.clauda')]) {
    const f = path.join(d, MEMORY_FILENAME)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** `/init` 的模板：留白比填满更有用，让模型后续自己补充 */
export function memoryTemplate(dirName: string): string {
  return `# ${dirName}

## 项目概览
（这个项目是做什么的，一句话）

## 技术栈
-

## 目录结构
-

## 常用命令
- 安装依赖：
- 启动开发：
- 运行测试：
- 构建：

## 编码约定
- 命名：
- 错误处理：
- 提交信息：
`
}
