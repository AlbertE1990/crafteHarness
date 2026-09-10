import type {
  ToolApprovalHandler,
  ToolApprovalOutcome,
  ToolApprovalRequest,
  ToolPolicyRequest,
} from '../tools'
import type {
  ResolveToolApprovalRequest,
  ResolveToolApprovalResult,
  ToolApprovalResolvedOutcome,
  ToolGuardDecision,
  ToolGuardOutputListener,
} from './tool-guard'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  MAX_TOOL_APPROVAL_TIMEOUT_MS,
} from './tool-guard'

/** ApprovalManager 的时钟和 ID 依赖可注入，便于宿主测试确定时间与关联字段。 */
export interface ToolApprovalManagerOptions {
  readonly defaultTimeoutMs?: number
  readonly createApprovalId?: () => string
  readonly now?: () => Date
}

/** 等待项保存所属 Run 和一次性完成函数，用于 Run 清理与用户决定。 */
interface PendingApproval {
  readonly runId: string
  readonly decide: (
    outcome: ToolApprovalOutcome,
    publicOutcome: ToolApprovalResolvedOutcome,
  ) => void
}

/**
 * Agent 内部的工具审批协调器。
 *
 * 它把 ToolApprovalHandler 的 pending Promise 与 Agent.resolveToolApproval() 关联起来，不依赖
 * HTTP、Fastify 或前端。所有等待项只存在于当前 Agent 实例内，并遵循首个终态生效。
 */
export class ToolApprovalManager {
  /** runId 定位当前 agent.run() 的应用事件监听器。 */
  private readonly listeners = new Map<string, ToolGuardOutputListener>()
  /** approvalId 定位等待中的 Tool Harness Promise。 */
  private readonly pending = new Map<string, PendingApproval>()
  private readonly defaultTimeoutMs: number
  private readonly createApprovalId: () => string
  private readonly now: () => Date

  constructor(options: ToolApprovalManagerOptions = {}) {
    const defaultTimeoutMs = options.defaultTimeoutMs
      ?? DEFAULT_TOOL_APPROVAL_TIMEOUT_MS
    validateTimeout(defaultTimeoutMs)
    this.defaultTimeoutMs = defaultTimeoutMs
    this.createApprovalId = options.createApprovalId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  /**
   * 注册一次 Agent Run 的审批事件出口。
   *
   * 返回的清理函数会令该 Run 尚未完成的审批按 unavailable 收口，防止 Run 结束后遗留 Promise。
   */
  observeRun(runId: string, listener: ToolGuardOutputListener): () => void {
    validateIdentifier(runId, 'runId')
    if (typeof listener !== 'function')
      throw new TypeError('ToolGuardOutputListener 必须是函数')
    if (this.listeners.has(runId))
      throw new Error(`Run ${runId} 已注册工具审批监听器`)

    this.listeners.set(runId, listener)
    return () => {
      if (this.listeners.get(runId) !== listener)
        return
      this.listeners.delete(runId)
      for (const pending of this.pending.values()) {
        if (pending.runId === runId)
          pending.decide('unavailable', 'aborted')
      }
    }
  }

  /** Tool Guard 自动 deny 时发送应用事件；该路径不会创建 approvalId。 */
  async notifyDenied(
    request: ToolPolicyRequest,
    decision: Extract<ToolGuardDecision, { decision: 'deny' }>,
  ): Promise<void> {
    if (!request.runId || !request.sessionId)
      return
    const listener = this.listeners.get(request.runId)
    if (!listener)
      return

    await safelyNotify(listener, {
      type: 'tool.guard.denied',
      sessionId: request.sessionId,
      runId: request.runId,
      callId: request.callId,
      toolName: request.toolName,
      reason: decision.reason,
    })
  }

  /**
   * Tool Harness 在 ask 后调用的内部处理器。
   *
   * Promise 会等待用户决定、当前调用超时、Run 取消或事件出口不可用；除 allowed-once 外全部
   * fail-closed，业务工具不会执行。
   */
  readonly requestApproval: ToolApprovalHandler = async (
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalOutcome> => {
    if (!request.runId || !request.sessionId)
      return 'unavailable'
    const runId = request.runId
    const sessionId = request.sessionId
    const listener = this.listeners.get(runId)
    if (!listener)
      return 'unavailable'

    const approvalTimeoutMs = request.approvalTimeoutMs
      ?? this.defaultTimeoutMs
    validateTimeout(approvalTimeoutMs)
    const approvalId = this.allocateApprovalId()
    const requestedAtDate = this.now()
    const requestedAt = requestedAtDate.toISOString()
    const expiresAt = new Date(requestedAtDate.getTime() + approvalTimeoutMs).toISOString()

    return await new Promise<ToolApprovalOutcome>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      /** 首个终态负责释放全部临时资源、通知应用层并恢复 Harness。 */
      const decide = (
        outcome: ToolApprovalOutcome,
        publicOutcome: ToolApprovalResolvedOutcome,
      ): void => {
        if (settled)
          return
        settled = true
        if (timeout)
          clearTimeout(timeout)
        if (onAbort)
          request.signal.removeEventListener('abort', onAbort)
        this.pending.delete(approvalId)

        const resolvedAt = this.now().toISOString()
        void safelyNotify(listener, {
          type: 'tool.approval.resolved',
          sessionId,
          runId,
          approvalId,
          callId: request.callId,
          toolName: request.toolName,
          outcome: publicOutcome,
          resolvedAt,
        }).finally(() => resolve(outcome))
      }

      onAbort = () => decide('aborted', 'aborted')
      timeout = setTimeout(
        () => decide('unavailable', 'expired'),
        approvalTimeoutMs,
      )
      // 先登记再发 requested，避免极快的 UI 决定在 pending 建立前到达。
      this.pending.set(approvalId, { runId, decide })
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) {
        decide('aborted', 'aborted')
        return
      }

      void notify(listener, {
        type: 'tool.approval.requested',
        sessionId,
        runId,
        approvalId,
        callId: request.callId,
        toolName: request.toolName,
        reason: request.reason,
        ...(request.title ? { title: request.title } : {}),
        ...(request.details ? { details: request.details } : {}),
        input: request.input,
        risk: request.security.risk,
        approvalTimeoutMs,
        requestedAt,
        expiresAt,
      }).catch(() => decide('unavailable', 'aborted'))
    })
  }

  /** 提交一次用户决定；已完成、过期、未知或重复的 approvalId 不会再次生效。 */
  resolve(request: ResolveToolApprovalRequest): ResolveToolApprovalResult {
    if (typeof request !== 'object' || request === null)
      throw new TypeError('工具审批决定必须是对象')
    validateIdentifier(request.approvalId, 'approvalId')
    if (request.decision !== 'allow' && request.decision !== 'deny')
      throw new TypeError('工具审批决定必须是 allow 或 deny')

    const pending = this.pending.get(request.approvalId)
    if (!pending)
      return { accepted: false, reason: 'not-found-or-settled' }

    pending.decide(
      request.decision === 'allow' ? 'allowed-once' : 'rejected',
      request.decision === 'allow' ? 'allowed' : 'denied',
    )
    return { accepted: true }
  }

  /** 只读检查用于确定性测试；不作为 Agent 的公共审批查询接口。 */
  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId)
  }

  /** 尝试生成当前 Agent 实例内唯一的审批 ID。 */
  private allocateApprovalId(): string {
    for (let attempt = 0; attempt < 3; attempt++) {
      const approvalId = this.createApprovalId().trim()
      if (approvalId && !this.pending.has(approvalId))
        return approvalId
    }
    throw new Error('无法生成唯一的工具审批 ID')
  }
}

/** requested 发送失败必须反馈调用者，让 Manager fail-closed。 */
async function notify(
  listener: ToolGuardOutputListener,
  event: Parameters<ToolGuardOutputListener>[0],
): Promise<void> {
  await listener(event)
}

/** resolved/deny 属于通知旁路，监听器异常不能阻止 Harness 清理和继续。 */
async function safelyNotify(
  listener: ToolGuardOutputListener,
  event: Parameters<ToolGuardOutputListener>[0],
): Promise<void> {
  try {
    await listener(event)
  }
  catch {
    // Agent 的输出观察器不会改变业务控制流；断连由同一个 Run 的 AbortSignal 负责。
  }
}

/** 校验关联 ID，业务值排在诊断字段名之前。 */
function validateIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${field} 必须是非空字符串`)
}

/** setTimeout 只接受有限正整数审批时限。 */
function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TOOL_APPROVAL_TIMEOUT_MS)
    throw new TypeError(`approvalTimeoutMs 必须是 1 到 ${MAX_TOOL_APPROVAL_TIMEOUT_MS} 的整数`)
}
