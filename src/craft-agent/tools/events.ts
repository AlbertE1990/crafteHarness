import type { ToolErrorInfo } from './errors'
import type { ToolApprovalOutcome, ToolPolicyDecision } from './policy'

/** 工具事件共有的关联字段。 */
export interface ToolEventBase {
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly toolName: string
  readonly timestamp: string
}

/** Tool Harness 输出的实时轨迹事件。 */
export type ToolExecutionEvent = ToolEventBase & (
  | { readonly type: 'tool.call.started', readonly input: unknown }
  | { readonly type: 'tool.policy.decided', readonly result: ToolPolicyDecision }
  | { readonly type: 'tool.approval.requested', readonly reason: string }
  | { readonly type: 'tool.approval.decided', readonly outcome: ToolApprovalOutcome }
  | { readonly type: 'tool.attempt.started', readonly attempt: number }
  | {
    readonly type: 'tool.attempt.failed'
    readonly attempt: number
    readonly error: ToolErrorInfo
  }
  | {
    readonly type: 'tool.retry.scheduled'
    readonly attempt: number
    readonly delayMs: number
  }
  | {
    readonly type: 'tool.call.completed'
    readonly attempts: number
    readonly durationMs: number
    readonly output: unknown
  }
  | {
    readonly type: 'tool.call.failed'
    readonly attempts: number
    readonly durationMs: number
    readonly error: ToolErrorInfo
  }
)

/** 观察实时工具轨迹的回调；观察器异常不会影响工具执行结果。 */
export type ToolEventListener = (
  event: ToolExecutionEvent,
) => void | Promise<void>
