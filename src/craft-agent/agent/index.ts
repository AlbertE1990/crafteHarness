/** CraftAgent 面向应用开发者的统一入口。 */
export * from './agent'
export * from './config'
/** ToolGuard 只公开业务配置和交互协议，不暴露 Agent 内部 Policy 适配器。 */
export { DEFAULT_TOOL_APPROVAL_TIMEOUT_MS } from './tool-guard'

export type {
  DefinedToolGuardConfig,
  ResolveToolApprovalRequest,
  ResolveToolApprovalResult,
  ToolApprovalDecision,
  ToolApprovalResolvedOutcome,
  ToolGuardConfig,
  ToolGuardDecision,
  ToolGuardDecisionMetadata,
  ToolGuardEvaluator,
  ToolGuardOutputEvent,
  ToolGuardOutputListener,
  ToolGuardRequest,
  ToolGuardToolInfo,
} from './tool-guard'
export * from './types'
