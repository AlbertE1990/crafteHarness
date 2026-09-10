import type {
  ToolApprovalHandler,
  ToolApprovalOutcome,
  ToolApprovalRequest,
  ToolRisk,
} from '../craft-agent'
import { randomUUID } from 'node:crypto'

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/** Server 通过 SSE 发给当前聊天请求的审批生命周期事件。 */
export type ToolApprovalStreamEvent
  = | {
    readonly type: 'tool.approval.requested'
    readonly approvalId: string
    readonly callId: string
    readonly toolName: string
    readonly reason: string
    readonly input: unknown
    readonly risk: ToolRisk
  }
  | {
    readonly type: 'tool.approval.decided'
    readonly approvalId: string
    readonly callId: string
    readonly toolName: string
    readonly outcome: ToolApprovalOutcome
  }

/** 前端可提交的封闭审批决定。 */
export type UserToolApprovalDecision = 'approve' | 'reject'

/** Broker 构造参数；时钟和 ID 可注入以支持确定性测试。 */
export interface ToolApprovalBrokerOptions {
  readonly timeoutMs?: number
  readonly createApprovalId?: () => string
}

/** 单个 Run 的审批事件写入器，通常映射到同一条 SSE 响应。 */
export type ToolApprovalEventListener = (
  event: ToolApprovalStreamEvent,
) => void | Promise<void>

/** 内部等待项只暴露一次性完成函数，避免重复决定。 */
interface PendingApproval {
  readonly decide: (outcome: ToolApprovalOutcome) => void
}

/**
 * 在阻塞中的 ToolApprovalHandler 与独立 HTTP 确认请求之间建立一次性关联。
 *
 * Broker 是 Server Runtime 的临时协调状态，不是 CraftAgent Core 或 Session 事实源。进程重启、超时、
 * SSE 断开都会 fail-closed，永远不会把缺少决定解释为同意。
 */
export class ToolApprovalBroker {
  private readonly listeners = new Map<string, ToolApprovalEventListener>()
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timeoutMs: number
  private readonly createApprovalId: () => string

  constructor(options: ToolApprovalBrokerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new TypeError('ToolApprovalBroker timeoutMs 必须是正安全整数')
    this.timeoutMs = timeoutMs
    this.createApprovalId = options.createApprovalId ?? randomUUID
  }

  /**
   * 注册当前 Run 的 SSE 观察器，并返回只删除本次注册的清理函数。
   * Agent.run() 必须显式传入同一个 runId，审批请求才能路由回正确页面。
   */
  observeRun(runId: string, listener: ToolApprovalEventListener): () => void {
    validateIdentifier(runId, 'runId')
    if (typeof listener !== 'function')
      throw new TypeError('ToolApprovalEventListener 必须是函数')
    if (this.listeners.has(runId))
      throw new Error(`Run ${runId} 已注册审批事件观察器`)

    this.listeners.set(runId, listener)
    return () => {
      if (this.listeners.get(runId) === listener)
        this.listeners.delete(runId)
    }
  }

  /**
   * CraftAgent 在 policy 返回 ask 后调用的处理器。
   *
   * Promise 会保持 pending，直到用户决定、调用取消、超时或 SSE 写入失败。
   */
  readonly requestApproval: ToolApprovalHandler = async (
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalOutcome> => {
    if (!request.runId)
      return 'unavailable'
    const listener = this.listeners.get(request.runId)
    if (!listener)
      return 'unavailable'

    const approvalId = this.allocateApprovalId()
    return await new Promise<ToolApprovalOutcome>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      /** 只允许首个终态生效，并在 Harness 恢复前先写出 decided 事件。 */
      const decide = (outcome: ToolApprovalOutcome): void => {
        if (settled)
          return
        settled = true
        if (timeout)
          clearTimeout(timeout)
        if (onAbort)
          request.signal.removeEventListener('abort', onAbort)
        this.pending.delete(approvalId)

        void safelyNotify(listener, {
          type: 'tool.approval.decided',
          approvalId,
          callId: request.callId,
          toolName: request.toolName,
          outcome,
        }).finally(() => resolve(outcome))
      }

      onAbort = () => decide('aborted')
      timeout = setTimeout(() => decide('unavailable'), this.timeoutMs)
      this.pending.set(approvalId, { decide })
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) {
        decide('aborted')
        return
      }

      void notify(listener, {
        type: 'tool.approval.requested',
        approvalId,
        callId: request.callId,
        toolName: request.toolName,
        reason: request.reason,
        input: request.input,
        risk: request.security.risk,
      }).catch(() => decide('unavailable'))
    })
  }

  /** 提交一次用户决定；未知或已结束的 approvalId 返回 false。 */
  decide(approvalId: string, decision: UserToolApprovalDecision): boolean {
    validateIdentifier(approvalId, 'approvalId')
    if (decision !== 'approve' && decision !== 'reject')
      throw new TypeError('审批决定必须是 approve 或 reject')

    const pending = this.pending.get(approvalId)
    if (!pending)
      return false
    pending.decide(decision === 'approve' ? 'allowed-once' : 'rejected')
    return true
  }

  /** 只读检查某次审批是否仍在等待，便于 HTTP 层和测试判断一次性状态。 */
  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId)
  }

  /** 生成当前进程内唯一且非空的审批 ID。 */
  private allocateApprovalId(): string {
    for (let attempt = 0; attempt < 3; attempt++) {
      const approvalId = this.createApprovalId().trim()
      if (approvalId && !this.pending.has(approvalId))
        return approvalId
    }
    throw new Error('无法生成唯一的工具审批 ID')
  }
}

/** 事件正常发送；错误交给调用者转成 unavailable。 */
async function notify(
  listener: ToolApprovalEventListener,
  event: ToolApprovalStreamEvent,
): Promise<void> {
  await listener(event)
}

/** 决定事件属于清理旁路，写出失败也必须释放等待中的 Harness。 */
async function safelyNotify(
  listener: ToolApprovalEventListener,
  event: ToolApprovalStreamEvent,
): Promise<void> {
  try {
    await listener(event)
  }
  catch {
    // SSE 已不可写时仍要 resolve 审批 Promise，Agent 的取消信号会负责终止 Run。
  }
}

/** 验证 Runtime 关联 ID，业务值排在诊断字段名之前。 */
function validateIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${field} 必须是非空字符串`)
}
