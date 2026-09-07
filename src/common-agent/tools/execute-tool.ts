import type { z } from 'zod'
import type { ToolErrorInfo } from './errors'
import type { ToolEventBase, ToolEventListener, ToolExecutionEvent } from './events'
import type { ToolApprovalHandler, ToolPolicy, ToolPolicyDecision } from './policy'
import type { DefinedTool, ToolRunContext } from './types'
import { Buffer } from 'node:buffer'
import { normalizeToolError, validationIssuesToJson } from './errors'
import { safeToolPolicy } from './policy'

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

/** Tool Harness 单次调用所需的运行参数。 */
export interface ExecuteToolOptions {
  /** 由 Agent Loop 生成并在重试期间保持不变的调用 ID。 */
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly signal?: AbortSignal
  /** 未提供时只允许无外部能力的 safe 工具。 */
  readonly policy?: ToolPolicy
  /** policy 返回 ask 时调用；缺失处理器会按 unavailable 拒绝。 */
  readonly requestApproval?: ToolApprovalHandler
  /** 接收有序实时轨迹；监听器异常不会改变工具结果。 */
  readonly onEvent?: ToolEventListener
  /** 模型可见结果的 UTF-8 字节上限。 */
  readonly maxOutputBytes?: number
  /** 测试可注入的随机数生成器。 */
  readonly random?: () => number
  /** 测试可注入的墙上时钟。 */
  readonly now?: () => Date
}

/** 工具成功执行后的规范结果。 */
export interface ToolExecutionSuccess<T> {
  readonly ok: true
  readonly value: T
  readonly content: string
  readonly attempts: number
  readonly durationMs: number
}

/** 工具失败后的规范结果。 */
export interface ToolExecutionFailure {
  readonly ok: false
  readonly error: ToolErrorInfo
  readonly content: string
  readonly attempts: number
  readonly durationMs: number
}

/** Harness 对调用方暴露的封闭执行结果。 */
export type ToolExecutionResult<T> = ToolExecutionSuccess<T> | ToolExecutionFailure

/**
 * 执行一个完整工具调用。
 *
 * 顺序固定为输入校验、权限/审批、尝试与重试、输出校验、内容投影；每个阶段都会产生
 * 可观察事件。重试只发生在工具定义了策略且本次错误明确标记为 retryable 时。
 */
export async function executeTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: DefinedTool<TInputSchema, TOutputSchema>,
  rawInput: unknown,
  options: ExecuteToolOptions,
): Promise<ToolExecutionResult<z.output<TOutputSchema>>> {
  const startedAt = Date.now()
  const now = options.now ?? (() => new Date())
  const base = createEventBase(tool.name, options, now)

  await emit(options.onEvent, {
    ...base(),
    type: 'tool.call.started',
    input: rawInput,
  })

  const callerSignal = options.signal ?? new AbortController().signal
  if (callerSignal.aborted) {
    return await finishFailure(
      abortedError(),
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  const inputResult = safelyParse(tool.inputSchema, rawInput)
  if (!inputResult.success) {
    return await finishFailure(
      {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: `工具 ${tool.name} 的参数未通过校验`,
        retryable: false,
        details: validationIssuesToJson(inputResult.issues),
      },
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  const policyRequest = {
    callId: options.callId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    toolName: tool.name,
    input: inputResult.data,
    security: tool.security,
    signal: callerSignal,
  }

  let policyDecision: unknown
  try {
    policyDecision = await (options.policy ?? safeToolPolicy).evaluate(policyRequest)
  }
  catch (error) {
    return await finishFailure(
      {
        code: 'TOOL_POLICY_FAILED',
        message: error instanceof Error ? error.message : '工具权限策略执行失败',
        retryable: false,
      },
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  if (!isPolicyDecision(policyDecision)) {
    return await finishFailure(
      {
        code: 'TOOL_POLICY_FAILED',
        message: '工具权限策略返回了无效决定',
        retryable: false,
      },
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  await emit(options.onEvent, {
    ...base(),
    type: 'tool.policy.decided',
    result: policyDecision,
  })

  if (policyDecision.decision === 'deny') {
    return await finishFailure(
      permissionDeniedError(policyDecision.reason),
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  if (policyDecision.decision === 'ask') {
    await emit(options.onEvent, {
      ...base(),
      type: 'tool.approval.requested',
      reason: policyDecision.reason,
    })

    let outcome: 'allowed-once' | 'rejected' | 'unavailable' | 'aborted' = 'unavailable'
    if (callerSignal.aborted) {
      outcome = 'aborted'
    }
    else if (options.requestApproval) {
      try {
        outcome = await options.requestApproval({
          ...policyRequest,
          reason: policyDecision.reason,
        })
      }
      catch {
        // 审批通道异常不能降级成授权；fail-closed 为 unavailable。
        outcome = 'unavailable'
      }
    }

    await emit(options.onEvent, {
      ...base(),
      type: 'tool.approval.decided',
      outcome,
    })

    if (outcome !== 'allowed-once') {
      const error = outcome === 'aborted'
        ? abortedError()
        : permissionDeniedError(`工具审批结果：${outcome}`)
      return await finishFailure(error, 0, startedAt, base, options.onEvent)
    }
  }

  const maxAttempts = tool.retry?.maxAttempts ?? 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (callerSignal.aborted) {
      return await finishFailure(
        abortedError(),
        attempt - 1,
        startedAt,
        base,
        options.onEvent,
      )
    }

    await emit(options.onEvent, {
      ...base(),
      type: 'tool.attempt.started',
      attempt,
    })

    const attemptResult = await executeAttempt(
      tool,
      inputResult.data,
      attempt,
      callerSignal,
      options,
    )

    if (attemptResult.ok) {
      const durationMs = Date.now() - startedAt
      await emit(options.onEvent, {
        ...base(),
        type: 'tool.call.completed',
        attempts: attempt,
        durationMs,
        output: attemptResult.value,
      })
      return {
        ...attemptResult,
        attempts: attempt,
        durationMs,
      }
    }

    await emit(options.onEvent, {
      ...base(),
      type: 'tool.attempt.failed',
      attempt,
      error: attemptResult.error,
    })

    const shouldRetry = Boolean(
      tool.retry
      && attemptResult.error.retryable
      && attempt < maxAttempts
      && !callerSignal.aborted,
    )
    if (!shouldRetry) {
      return await finishFailure(
        attemptResult.error,
        attempt,
        startedAt,
        base,
        options.onEvent,
      )
    }

    const delayMs = getRetryDelay(tool.retry!, attempt, options.random ?? Math.random)
    await emit(options.onEvent, {
      ...base(),
      type: 'tool.retry.scheduled',
      attempt,
      delayMs,
    })

    const waited = await waitForRetry(delayMs, callerSignal)
    if (!waited) {
      return await finishFailure(
        abortedError(),
        attempt,
        startedAt,
        base,
        options.onEvent,
      )
    }
  }

  // maxAttempts 已在 defineTool 中校验为正整数，因此循环必然提前返回。
  return await finishFailure(
    {
      code: 'TOOL_EXECUTION_FAILED',
      message: `工具 ${tool.name} 执行失败`,
      retryable: false,
    },
    maxAttempts,
    startedAt,
    base,
    options.onEvent,
  )
}

/** 一次尝试的内部成功结果，调用级统计由外层统一附加。 */
type AttemptResult<T>
  = | { readonly ok: true, readonly value: T, readonly content: string }
    | { readonly ok: false, readonly error: ToolErrorInfo }

/** 执行一次带协作式超时、输出校验和模型内容大小限制的工具尝试。 */
async function executeAttempt<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: DefinedTool<TInputSchema, TOutputSchema>,
  input: z.output<TInputSchema>,
  attempt: number,
  callerSignal: AbortSignal,
  options: ExecuteToolOptions,
): Promise<AttemptResult<z.output<TOutputSchema>>> {
  const timeoutController = new AbortController()
  const timeout = tool.timeoutMs === undefined
    ? undefined
    : setTimeout(() => timeoutController.abort(), tool.timeoutMs)
  const signal = tool.timeoutMs === undefined
    ? callerSignal
    : AbortSignal.any([callerSignal, timeoutController.signal])

  const context: ToolRunContext = {
    callId: options.callId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    attempt,
    signal,
  }

  try {
    const rawOutput = await tool.execute(input, context)
    if (callerSignal.aborted)
      return { ok: false, error: abortedError() }
    if (timeoutController.signal.aborted)
      return { ok: false, error: timeoutError(tool.name, tool.timeoutMs!) }

    const outputResult = safelyParse(tool.outputSchema, rawOutput)
    if (!outputResult.success) {
      return {
        ok: false,
        error: {
          code: 'INVALID_TOOL_OUTPUT',
          message: `工具 ${tool.name} 返回值未通过 outputSchema 校验`,
          retryable: false,
          details: validationIssuesToJson(outputResult.issues),
        },
      }
    }

    let content: string
    try {
      content = tool.renderOutput
        ? tool.renderOutput(outputResult.data)
        : renderOutput(outputResult.data)
    }
    catch (error) {
      return {
        ok: false,
        error: {
          code: 'TOOL_OUTPUT_RENDER_FAILED',
          message: error instanceof Error ? error.message : '工具结果无法转换为模型内容',
          retryable: false,
        },
      }
    }

    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    if (Buffer.byteLength(content, 'utf8') > maxOutputBytes) {
      return {
        ok: false,
        error: {
          code: 'TOOL_OUTPUT_TOO_LARGE',
          message: `工具 ${tool.name} 的模型可见结果超过 ${maxOutputBytes} 字节`,
          retryable: false,
        },
      }
    }

    return { ok: true, value: outputResult.data, content }
  }
  catch (error) {
    if (callerSignal.aborted)
      return { ok: false, error: abortedError() }
    if (timeoutController.signal.aborted)
      return { ok: false, error: timeoutError(tool.name, tool.timeoutMs!) }
    return { ok: false, error: normalizeToolError(error) }
  }
  finally {
    if (timeout !== undefined)
      clearTimeout(timeout)
  }
}

/** 同步解析 Zod Schema，并把异步 refinement 等异常也归入校验失败。 */
function safelyParse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
):
  | { readonly success: true, readonly data: z.output<TSchema> }
  | {
    readonly success: false
    readonly issues: readonly { code?: string, message: string, path: readonly PropertyKey[] }[]
  } {
  try {
    const result = schema.safeParse(value)
    return result.success
      ? { success: true, data: result.data }
      : { success: false, issues: result.error.issues }
  }
  catch (error) {
    return {
      success: false,
      issues: [{
        code: 'schema_parse_failed',
        message: error instanceof Error ? error.message : 'Schema 解析失败',
        path: [],
      }],
    }
  }
}

/** 默认保留字符串，其余成功值使用 JSON 序列化。 */
function renderOutput(value: unknown): string {
  if (typeof value === 'string')
    return value

  const content = JSON.stringify(value)
  if (content === undefined)
    throw new TypeError('工具成功值不能序列化为 JSON')
  return content
}

/** 根据固定或指数策略计算带上限的随机退避时间。 */
function getRetryDelay(
  retry: NonNullable<DefinedTool<z.ZodType, z.ZodType>['retry']>,
  failedAttempt: number,
  random: () => number,
): number {
  const multiplier = retry.backoff === 'fixed' ? 1 : 2 ** (failedAttempt - 1)
  const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * multiplier)
  const jitter = base * (retry.jitterRatio ?? 0.2) * Math.max(0, Math.min(1, random()))
  return Math.round(Math.min(retry.maxDelayMs, base + jitter))
}

/** 等待重试窗口，并允许调用方取消剩余等待。 */
async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted)
    return false
  if (delayMs === 0)
    return true

  return await new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 生成每个事件共享的身份字段，并让测试能够固定时间。 */
function createEventBase(
  toolName: string,
  options: ExecuteToolOptions,
  now: () => Date,
): () => ToolEventBase {
  return () => ({
    callId: options.callId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    toolName,
    timestamp: now().toISOString(),
  })
}

/** 观察器属于诊断边界，其失败不能改变业务工具调用。 */
async function emit(
  listener: ToolEventListener | undefined,
  event: ToolExecutionEvent,
): Promise<void> {
  if (!listener)
    return
  try {
    await listener(event)
  }
  catch {
    // 轨迹导出失败不能把已经成功的业务操作改写成工具失败。
  }
}

/** 构造并发送最终失败事件。 */
async function finishFailure(
  error: ToolErrorInfo,
  attempts: number,
  startedAt: number,
  base: () => ToolEventBase,
  listener?: ToolEventListener,
): Promise<ToolExecutionFailure> {
  const durationMs = Date.now() - startedAt
  await emit(listener, {
    ...base(),
    type: 'tool.call.failed',
    attempts,
    durationMs,
    error,
  })
  return {
    ok: false,
    error,
    content: `Error: ${error.message}`,
    attempts,
    durationMs,
  }
}

/** 取消始终不可重试。 */
function abortedError(): ToolErrorInfo {
  return {
    code: 'ABORTED',
    message: '工具调用已取消',
    retryable: false,
  }
}

/** 超时是否实际重试仍由工具的幂等重试策略决定。 */
function timeoutError(toolName: string, timeoutMs: number): ToolErrorInfo {
  return {
    code: 'TOOL_TIMEOUT',
    message: `工具 ${toolName} 在 ${timeoutMs}ms 内未完成`,
    retryable: true,
  }
}

/** 权限拒绝使用稳定错误码，避免向模型泄漏策略实现细节。 */
function permissionDeniedError(reason: string): ToolErrorInfo {
  return {
    code: 'TOOL_PERMISSION_DENIED',
    message: reason,
    retryable: false,
  }
}

/** 即使策略来自普通 JavaScript，也必须验证其结果并在异常形状下拒绝执行。 */
function isPolicyDecision(value: unknown): value is ToolPolicyDecision {
  if (typeof value !== 'object' || value === null)
    return false

  const decision = (value as { decision?: unknown }).decision
  if (decision === 'allow')
    return true
  if (decision !== 'deny' && decision !== 'ask')
    return false
  return typeof (value as { reason?: unknown }).reason === 'string'
}
