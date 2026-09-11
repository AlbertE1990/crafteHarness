import type { AgentTool } from '../../core'
import type { HarnessLocale } from '../../locale'
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
  options: { readonly workspaceRoot?: string, readonly locale?: HarnessLocale } = {},
): readonly AgentTool<TContext>[] {
  return Object.freeze([
    createAgentTool(createCurrentTimeTool({ locale: options.locale })) as unknown as AgentTool<TContext>,
    createAgentTool(createCalculatorTool({ locale: options.locale })) as unknown as AgentTool<TContext>,
    ...(options.workspaceRoot
      ? createWorkspaceTools({ workspaceRoot: options.workspaceRoot, locale: options.locale }).map(
          tool => createAgentTool(tool as never) as unknown as AgentTool<TContext>,
        )
      : []),
  ])
}
