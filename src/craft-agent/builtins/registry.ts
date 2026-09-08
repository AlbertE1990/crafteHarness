import type { AgentTool } from '../core'
import { createAgentTool } from '../core'
import { createCalculatorTool } from './calculator'
import { createCurrentTimeTool } from './current-time'

/** Agent 默认装载的稳定内置工具名称。 */
export const builtinToolNames = Object.freeze([
  'get_current_time',
  'calculator',
] as const)

/** 可用于禁用或覆盖的内置工具名称。 */
export type BuiltinToolName = typeof builtinToolNames[number]

/** 每次创建 Agent 配置时生成独立的内置工具注册项。 */
export function createBuiltinTools(): readonly AgentTool[] {
  return Object.freeze([
    createAgentTool(createCurrentTimeTool()),
    createAgentTool(createCalculatorTool()),
  ])
}
