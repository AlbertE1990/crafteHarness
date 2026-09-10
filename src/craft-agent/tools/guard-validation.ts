import type { JsonObject } from '../types/json'
import type { ToolGuardDecision } from './guard'
import { isJsonObject } from '../types/json'

/** Node.js setTimeout 可稳定表达的最大毫秒值。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * 校验普通 JavaScript Guard 的真实返回值，并可补入 Agent 通用审批时限。
 *
 * @internal
 */
export function normalizeToolGuardDecision(
  value: unknown,
  defaultApprovalTimeoutMs?: number,
): ToolGuardDecision {
  if (typeof value !== 'object' || value === null)
    throw new TypeError('Tool Guard evaluate() 必须返回对象')

  const decision = value as Record<string, unknown>
  validateOptionalJsonObject(decision.metadata, 'Tool Guard decision.metadata')
  const metadata = decision.metadata as JsonObject | undefined

  if (decision.decision === 'allow') {
    return Object.freeze({
      decision: 'allow' as const,
      ...(metadata ? { metadata } : {}),
    })
  }

  if (decision.decision === 'deny') {
    return Object.freeze({
      decision: 'deny' as const,
      reason: readRequiredText(decision.reason, 'Tool Guard deny.reason'),
      ...(metadata ? { metadata } : {}),
    })
  }

  if (decision.decision !== 'ask')
    throw new TypeError('Tool Guard decision 必须是 allow、deny 或 ask')

  const reason = readRequiredText(decision.reason, 'Tool Guard ask.reason')
  const title = readOptionalText(decision.title, 'Tool Guard ask.title')
  validateOptionalJsonObject(decision.details, 'Tool Guard ask.details')
  const details = decision.details as JsonObject | undefined
  const approvalTimeoutMs = decision.approvalTimeoutMs === undefined
    ? defaultApprovalTimeoutMs
    : decision.approvalTimeoutMs
  if (approvalTimeoutMs !== undefined) {
    if (typeof approvalTimeoutMs !== 'number')
      throw new TypeError('Tool Guard ask.approvalTimeoutMs 必须是数字')
    validateApprovalTimeout(approvalTimeoutMs, 'Tool Guard ask.approvalTimeoutMs')
  }

  return Object.freeze({
    decision: 'ask' as const,
    reason,
    ...(title ? { title } : {}),
    ...(details ? { details } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    ...(metadata ? { metadata } : {}),
  })
}

/** 审批时限接受 -1（永久等待）或 Node.js setTimeout 可稳定表达的正整数。 */
export function validateApprovalTimeout(value: number, field: string): void {
  if (value === -1)
    return
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `${field} 必须是 -1，或 1 到 ${MAX_TIMER_DELAY_MS} 的整数`,
    )
  }
}

/** 读取必填非空文本，避免 UI 收到无法解释的 ask/deny。 */
function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}

/** 读取可选非空文本。 */
function readOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined)
    return undefined
  return readRequiredText(value, field)
}

/** metadata/details 必须是普通 JSON 对象，不能把函数、Error 或循环引用发给轨迹和 UI。 */
function validateOptionalJsonObject(value: unknown, field: string): void {
  if (value === undefined)
    return
  if (!isJsonObject(value))
    throw new TypeError(`${field} 必须是可序列化 JSON 对象`)
}
