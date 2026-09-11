import type { AgentTool } from '../../core'
import { createAgentTool } from '../../core'
import { createCalculatorTool } from './calculator'
import { createCurrentTimeTool } from './current-time'
import { createWorkspaceTools } from './workspace-tools'

/** Agent 可装载并允许禁用或覆盖的稳定内置工具名称。 */
export const builtinToolNames = Object.freeze([
  'get_current_time',
  'calculator',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'terminal',
] as const)

/** 可用于禁用或覆盖的内置工具名称。 */
export type BuiltinToolName = typeof builtinToolNames[number]

/** 每次创建 Agent 配置时生成独立的内置工具注册项。 */
export function createBuiltinTools<TContext = undefined>(
  options: { readonly workspaceRoot?: string } = {},
): readonly AgentTool<TContext>[] {
  return Object.freeze([
    createAgentTool(createCurrentTimeTool()) as unknown as AgentTool<TContext>,
    createAgentTool(createCalculatorTool()) as unknown as AgentTool<TContext>,
    ...(options.workspaceRoot
      ? createWorkspaceTools({ workspaceRoot: options.workspaceRoot }).map(
          tool => createAgentTool(tool as never) as unknown as AgentTool<TContext>,
        )
      : []),
  ])
}
