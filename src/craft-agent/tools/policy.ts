import type { JsonObject } from '../types/json'
import type { ToolSecurityMetadata } from './types'

/** Policy 决定可携带的安全 JSON 元数据，会进入轨迹但不改变控制流。 */
export interface ToolPolicyDecisionMetadata {
  readonly metadata?: JsonObject
}

/**
 * 权限策略在工具执行前可以作出的封闭决定。
 *
 * - allow：无需人工交互，当前调用可以进入执行阶段。
 * - deny：当前调用立即失败，reason 会成为模型可见的工具失败原因。
 * - ask：暂停当前调用并交给 ToolApprovalHandler；它本身不代表已经获准。
 */
export type ToolPolicyDecision
  = | ({ readonly decision: 'allow' } & ToolPolicyDecisionMetadata)
    | ({ readonly decision: 'deny', readonly reason: string } & ToolPolicyDecisionMetadata)
    | ({
      readonly decision: 'ask'
      readonly reason: string
      /** 交互层可选的用户可见标题。 */
      readonly title?: string
      /** 已确认可安全发送给交互层的结构化详情。 */
      readonly details?: JsonObject
      /** 当前调用的审批时限，优先于 Agent 通用配置；-1 表示不自动过期。 */
      readonly approvalTimeoutMs?: number
    } & ToolPolicyDecisionMetadata)

/** 权限策略评估一次已经完成参数校验的工具调用。 */
export interface ToolPolicyRequest {
  /** 模型生成的单次工具调用 ID；审批和最终 tool message 都通过它关联。 */
  readonly callId: string
  /** 当前 agent.run() 的 ID；交互层可用它把审批路由到正确的聊天连接。 */
  readonly runId?: string
  /** 多轮对话 ID；只用于上下文和业务策略，不能代替一次性审批 ID。 */
  readonly sessionId?: string
  readonly toolName: string
  /** 已经通过 inputSchema 校验的数据，但仍以 unknown 暴露给通用策略。 */
  readonly input: unknown
  /** 工具作者声明的最大风险与能力需求，不是已经获得的授权。 */
  readonly security: ToolSecurityMetadata
  /** Run 取消、超时或客户端断开时会中止等待中的审批。 */
  readonly signal: AbortSignal
}

/** 部署侧工具权限策略；策略与工具业务实现保持分离。 */
export interface ToolPolicy {
  evaluate: (request: ToolPolicyRequest) => ToolPolicyDecision | Promise<ToolPolicyDecision>
}

/**
 * 用户审批可能产生的封闭结果；只有 allowed-once 可以继续执行。
 * unavailable 用于通道缺失、超时或交互失败，aborted 用于整个调用已取消。
 */
export type ToolApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable' | 'aborted'

/** Runtime 交给前端、CLI 或其他交互层的单次审批请求。 */
export interface ToolApprovalRequest extends ToolPolicyRequest {
  readonly reason: string
  readonly title?: string
  readonly details?: JsonObject
  /** Tool Guard 计算出的最终时限；Agent 门面调用时始终存在，-1 表示永久等待。 */
  readonly approvalTimeoutMs?: number
}

/**
 * 执行一次用户审批并返回不可复用的单次结果。
 *
 * 实现可以等待前端、CLI 或外部审批系统；它只返回决定，不能绕过 Harness 直接执行工具。
 */
export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
) => ToolApprovalOutcome | Promise<ToolApprovalOutcome>

/**
 * 无显式策略时使用的最小权限策略。
 *
 * 仅无外部能力的 safe 工具默认可运行，其余调用全部拒绝，避免新工具被意外授权。
 * 该策略假定注册进程中的工具代码来自可信开发者；它不能约束恶意的同进程 Node.js 代码。
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
