import type { ToolSecurityMetadata } from './types'

/** 权限策略在工具执行前可以作出的封闭决定。 */
export type ToolPolicyDecision
  = | { readonly decision: 'allow' }
    | { readonly decision: 'deny', readonly reason: string }
    | { readonly decision: 'ask', readonly reason: string }

/** 权限策略评估一次已经完成参数校验的工具调用。 */
export interface ToolPolicyRequest {
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly toolName: string
  readonly input: unknown
  readonly security: ToolSecurityMetadata
  readonly signal: AbortSignal
}

/** 部署侧工具权限策略；策略与工具业务实现保持分离。 */
export interface ToolPolicy {
  evaluate: (request: ToolPolicyRequest) => ToolPolicyDecision | Promise<ToolPolicyDecision>
}

/** 用户审批可能产生的封闭结果；只有 allowed-once 可以继续执行。 */
export type ToolApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable' | 'aborted'

/** Runtime 交给前端、CLI 或其他交互层的单次审批请求。 */
export interface ToolApprovalRequest extends ToolPolicyRequest {
  readonly reason: string
}

/** 执行一次用户审批并返回不可复用的单次结果。 */
export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
) => ToolApprovalOutcome | Promise<ToolApprovalOutcome>

/**
 * 无显式策略时使用的最小权限策略。
 *
 * 仅无外部能力的 safe 工具默认可运行，其余调用全部拒绝，避免新工具被意外授权。
 */
export const safeToolPolicy: ToolPolicy = Object.freeze({
  evaluate: (request: ToolPolicyRequest): ToolPolicyDecision => {
    const capabilities = request.security.capabilities ?? []
    if (request.security.risk === 'safe' && capabilities.length === 0)
      return { decision: 'allow' }

    return {
      decision: 'deny',
      reason: `工具 ${request.toolName} 需要 Runtime 显式授权`,
    }
  },
})
