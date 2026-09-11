/** CraftAgent 面向应用开发者的统一入口。 */
export * from './agent'
export * from './config'
/** Agent 配置接收的任意 `defineTool()` 结果类型；归一化函数仍是内部实现。 */
export type { AgentToolInput } from './normalize-tools'
/** ToolGuard 只公开业务配置和交互协议，不暴露 Agent 内部 Policy 适配器。 */
export { DEFAULT_TOOL_APPROVAL_TIMEOUT_MS } from './tool-guard'

export type {
  ResolveToolApprovalRequest,
  ResolveToolApprovalResult,
  ToolApprovalDecision,
  ToolApprovalResolvedOutcome,
  ToolGuardDecision,
  ToolGuardDecisionMetadata,
  ToolGuardEvaluator,
  ToolGuardOutputEvent,
  ToolGuardOutputListener,
  ToolGuardRequest,
  ToolGuardToolInfo,
} from './tool-guard'
export * from './types'
