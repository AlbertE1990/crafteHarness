import type { AgentTool } from '../core'
import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest,
  ToolRisk,
  ToolSecurityMetadata,
} from '../tools'
import type { JsonObject, JsonSchema, JsonValue } from '../types/json'

/** Agent 未显式配置时使用的单次审批等待时间。 */
export const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000

/** Node.js setTimeout 可稳定表达的最大毫秒值，仅供 Agent 内部校验使用。 */
export const MAX_TOOL_APPROVAL_TIMEOUT_MS = 2_147_483_647

/** 风险评估器可读取的工具静态信息，不包含业务执行函数。 */
export interface ToolGuardToolInfo {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  /** 工具声明的最大风险和能力需求，不代表已经获得授权。 */
  readonly security: ToolSecurityMetadata
}

/** 使用者实现风险评估函数时收到的完整、供应商无关输入。 */
export interface ToolGuardRequest {
  readonly runId: string
  readonly sessionId: string
  readonly callId: string
  readonly tool: ToolGuardToolInfo
  /** 已通过工具 inputSchema 校验的实际调用参数。 */
  readonly input: unknown
  /** 异步评估调用外部服务时必须继续传递该取消信号。 */
  readonly signal: AbortSignal
}

/** 所有评估结果都可携带只进入轨迹的安全 JSON 元数据。 */
export interface ToolGuardDecisionMetadata {
  readonly metadata?: JsonObject
}

/** 风险评估函数允许返回的封闭结果。 */
export type ToolGuardDecision
  = | ({ readonly decision: 'allow' } & ToolGuardDecisionMetadata)
    | ({ readonly decision: 'deny', readonly reason: string } & ToolGuardDecisionMetadata)
    | ({
      readonly decision: 'ask'
      readonly reason: string
      readonly title?: string
      /** 已脱敏、可安全发送给 UI 的结构化补充信息。 */
      readonly details?: JsonObject
      /** 仅覆盖当前审批，优先级高于通用配置；-1 表示不自动过期，但仍响应 Run 取消。 */
      readonly approvalTimeoutMs?: number
    } & ToolGuardDecisionMetadata)

/** 使用者实现的风险评估函数；它只作决定，不负责等待前端。 */
export type ToolGuardEvaluator = (
  request: ToolGuardRequest,
) => ToolGuardDecision | Promise<ToolGuardDecision>

/** Agent 对外唯一的工具风险与审批配置入口。 */
export interface ToolGuardConfig {
  readonly evaluate: ToolGuardEvaluator
  /** ask 未单独指定时使用的通用审批时限；-1 表示不自动过期，但仍响应 Run 取消。 */
  readonly approvalTimeoutMs?: number
}

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
    readonly risk: ToolRisk
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
export interface DefinedToolGuardConfig {
  readonly evaluate: ToolGuardEvaluator
  readonly approvalTimeoutMs: number
}

/** 自动拒绝事件发送器，由 Agent 内部 ApprovalManager 实现。 */
export type ToolGuardDeniedListener = (
  request: ToolPolicyRequest,
  decision: Extract<ToolGuardDecision, { decision: 'deny' }>,
) => void | Promise<void>

/** 校验 Tool Guard 配置，并在未配置时提供最小权限默认评估器。 */
export function defineToolGuardConfig(
  input: ToolGuardConfig | undefined,
): DefinedToolGuardConfig {
  if (input !== undefined && (typeof input !== 'object' || input === null))
    throw new TypeError('Agent config.toolGuard 必须是对象')
  if (input !== undefined && typeof input.evaluate !== 'function')
    throw new TypeError('Agent config.toolGuard.evaluate 必须是函数')

  const approvalTimeoutMs = input?.approvalTimeoutMs
    ?? DEFAULT_TOOL_APPROVAL_TIMEOUT_MS
  validateApprovalTimeout(approvalTimeoutMs, 'Agent config.toolGuard.approvalTimeoutMs')

  return Object.freeze({
    evaluate: input?.evaluate ?? evaluateWithMinimumPrivilege,
    approvalTimeoutMs,
  })
}

/**
 * 把面向 Agent 使用者的 ToolGuard 适配成底层 ToolPolicy。
 *
 * Tool Harness 继续只依赖 ToolPolicy/ToolApprovalHandler；工具信息补全、决定校验和通用超时合并
 * 都收口在 Agent 门面内部。
 */
export function createToolGuardPolicy(
  config: DefinedToolGuardConfig,
  tools: readonly AgentTool[],
  onDenied: ToolGuardDeniedListener,
): ToolPolicy {
  const toolsByName = new Map(tools.map(tool => [tool.name, tool] as const))

  return Object.freeze({
    async evaluate(request: ToolPolicyRequest): Promise<ToolPolicyDecision> {
      const tool = toolsByName.get(request.toolName)
      if (!tool)
        throw new Error(`Tool Guard 找不到已注册工具 ${request.toolName}`)
      if (!request.runId || !request.sessionId)
        throw new Error('Agent Tool Guard 缺少 runId 或 sessionId')

      const rawDecision: unknown = await config.evaluate({
        runId: request.runId,
        sessionId: request.sessionId,
        callId: request.callId,
        tool: Object.freeze({
          name: tool.name,
          description: tool.model.description,
          inputSchema: tool.model.inputSchema,
          security: request.security,
        }),
        input: request.input,
        signal: request.signal,
      })
      const decision = normalizeToolGuardDecision(rawDecision, config.approvalTimeoutMs)

      if (decision.decision === 'deny')
        await onDenied(request, decision)
      return decision
    },
  })
}

/** 未配置自定义评估器时，只自动允许无外部能力的 safe 工具。 */
function evaluateWithMinimumPrivilege(request: ToolGuardRequest): ToolGuardDecision {
  const capabilities = request.tool.security.capabilities ?? []
  if (request.tool.security.risk === 'safe' && capabilities.length === 0)
    return { decision: 'allow' }

  return {
    decision: 'deny',
    reason: `工具 ${request.tool.name} 需要显式 Tool Guard 授权`,
  }
}

/** 校验使用者返回的普通 JavaScript 对象，并合并当前调用的最终审批时间。 */
function normalizeToolGuardDecision(
  value: unknown,
  defaultApprovalTimeoutMs: number,
): ToolPolicyDecision {
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
    const reason = readRequiredText(decision.reason, 'Tool Guard deny.reason')
    return Object.freeze({
      decision: 'deny' as const,
      reason,
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
  if (typeof approvalTimeoutMs !== 'number')
    throw new TypeError('Tool Guard ask.approvalTimeoutMs 必须是数字')
  validateApprovalTimeout(approvalTimeoutMs, 'Tool Guard ask.approvalTimeoutMs')

  return Object.freeze({
    decision: 'ask' as const,
    reason,
    ...(title ? { title } : {}),
    ...(details ? { details } : {}),
    approvalTimeoutMs,
    ...(metadata ? { metadata } : {}),
  })
}

/** 审批时限接受 -1（永久等待）或 Node.js setTimeout 可稳定表达的正整数。 */
function validateApprovalTimeout(value: number, field: string): void {
  if (value === -1)
    return
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TOOL_APPROVAL_TIMEOUT_MS) {
    throw new TypeError(
      `${field} 必须是 -1，或 1 到 ${MAX_TOOL_APPROVAL_TIMEOUT_MS} 的整数`,
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

/** 递归识别可无损 JSON 序列化的普通对象，并拒绝循环引用和 symbol key。 */
function isJsonObject(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return false
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol') || ancestors.has(value))
    return false

  ancestors.add(value)
  const valid = Object.values(value).every(child => isJsonValue(child, ancestors))
  ancestors.delete(value)
  return valid
}

/** 递归识别 JSON 值，并拒绝 undefined、非有限数字及非普通对象。 */
function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      return false
    ancestors.add(value)
    const valid = value.every(child => isJsonValue(child, ancestors))
    ancestors.delete(value)
    return valid
  }
  return isJsonObject(value, ancestors)
}
