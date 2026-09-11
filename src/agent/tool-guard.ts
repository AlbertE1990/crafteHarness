import type { HarnessLocale } from '../locale'
import type {
  ToolGuardEvaluator,
} from '../tools'
import type { JsonObject } from '../types/json'
import { DEFAULT_LOCALE, diagnostic } from '../locale'
import { validateApprovalTimeout } from '../tools/guard-validation'

/** 公共 Guard 决定与请求协议定义在 tools 层，此处统一从 Agent 入口转出。 */
export type {
  ToolGuardDecision,
  ToolGuardDecisionMetadata,
  ToolGuardEvaluator,
  ToolGuardRequest,
  ToolGuardToolInfo,
} from '../tools'

/** Agent 未显式配置时使用的单次审批等待时间。 */
export const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000

/** Node.js setTimeout 可稳定表达的最大毫秒值，仅供 Agent 内部校验使用。 */
export const MAX_TOOL_APPROVAL_TIMEOUT_MS = 2_147_483_647

/** 应用层提交给 Agent 的一次性用户决定。 */
export type ToolApprovalDecision = 'allow' | 'deny'

/** Agent.resolveToolApproval() 的输入。 */
export interface ResolveToolApprovalRequest {
  readonly approvalId: string
  readonly decision: ToolApprovalDecision
}

/** Agent 是否接受了本次一次性决定。 */
export type ResolveToolApprovalResult
  = | { readonly accepted: true }
    | { readonly accepted: false, readonly reason: 'not-found-or-settled' }

/** 页面或 CLI 可观察的审批终态。 */
export type ToolApprovalResolvedOutcome = 'allowed' | 'denied' | 'expired' | 'aborted'

/** Agent 门面直接暴露的 Tool Guard 与审批事件。 */
export type ToolGuardOutputEvent
  = | {
    readonly type: 'tool.approval.requested'
    readonly sessionId: string
    readonly runId: string
    readonly approvalId: string
    readonly callId: string
    readonly toolName: string
    readonly reason: string
    readonly title?: string
    readonly details?: JsonObject
    readonly input: unknown
    /** 工具定义携带的 JSON 安全业务标签，CraftAgent 不解释字段。 */
    readonly toolMetadata: JsonObject
    /** -1 表示本次审批没有自动过期时间。 */
    readonly approvalTimeoutMs: number
    readonly requestedAt: string
    /** 永久等待时为 null，否则是服务端计算出的绝对 ISO 时间。 */
    readonly expiresAt: string | null
  }
  | {
    readonly type: 'tool.approval.resolved'
    readonly sessionId: string
    readonly runId: string
    readonly approvalId: string
    readonly callId: string
    readonly toolName: string
    readonly outcome: ToolApprovalResolvedOutcome
    readonly resolvedAt: string
  }
  | {
    readonly type: 'tool.guard.denied'
    readonly sessionId: string
    readonly runId: string
    readonly callId: string
    readonly toolName: string
    readonly reason: string
  }

/** 单个 Run 的 Tool Guard 应用事件监听器。 */
export type ToolGuardOutputListener = (
  event: ToolGuardOutputEvent,
) => void | Promise<void>

/** Agent 内部使用的已校验 Tool Guard 配置。 */
export interface DefinedToolGuardConfig<TContext = undefined> {
  readonly guard?: ToolGuardEvaluator<TContext>
  readonly approvalTimeoutMs: number
}

/** 校验 Tool Guard 配置；未配置 guard 时该层不会参与决策。 */
export function defineToolGuardConfig<TContext = undefined>(
  guard: ToolGuardEvaluator<TContext> | undefined,
  approvalTimeoutInput: number | undefined,
  locale: HarnessLocale = DEFAULT_LOCALE,
): DefinedToolGuardConfig<TContext> {
  if (guard !== undefined && typeof guard !== 'function')
    throw new TypeError(diagnostic(locale, 'Agent config.tools.guard 必须是函数', 'Agent config.tools.guard must be a function'))

  const approvalTimeoutMs = approvalTimeoutInput
    ?? DEFAULT_TOOL_APPROVAL_TIMEOUT_MS
  validateApprovalTimeout(approvalTimeoutMs, 'Agent config.tools.approvalTimeoutMs', locale)

  return Object.freeze({
    ...(guard ? { guard } : {}),
    approvalTimeoutMs,
  })
}
