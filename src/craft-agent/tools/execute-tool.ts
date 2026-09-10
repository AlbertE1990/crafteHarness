import type { z } from 'zod'
import type { JsonObject } from '../types/json'
import type { ToolErrorInfo } from './errors'
import type { ToolEventBase, ToolEventListener, ToolExecutionEvent } from './events'
import type {
  ToolApprovalHandler,
  ToolGuardDecision,
  ToolGuardEvaluator,
  ToolGuardRequest,
} from './guard'
import type { DefinedTool, ToolRetryPolicy, ToolRunContext } from './types'
import { Buffer } from 'node:buffer'
import { normalizeToolError, validationIssuesToJson } from './errors'
import { normalizeToolGuardDecision } from './guard-validation'

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

/** Tool Harness 单次调用所需的运行参数。 */
export interface ExecuteToolOptions<TContext = undefined> {
  /** 由 Agent Loop 生成并在重试期间保持不变的调用 ID。 */
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  /** 当前 Run 的业务上下文；只传给 Guard 和工具 execute()。 */
  readonly context?: TContext
  readonly signal?: AbortSignal
  /** 部署级 Guard；未提供时该层直接 allow。 */
  readonly globalToolGuard?: ToolGuardEvaluator<TContext>
  /** Agent 工具注册表覆盖内置 Guard 时使用；普通 executeTool() 调用方不应配置。 */
  readonly toolGuardOverride?: ToolGuardEvaluator<TContext> | null
  /** Guard 返回 ask 时调用；缺失处理器会按 unavailable 拒绝。 */
  readonly requestApproval?: ToolApprovalHandler<TContext>
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
  TContext = undefined,
  TMetadata extends JsonObject = JsonObject,
>(
  tool: DefinedTool<TInputSchema, TOutputSchema, TContext, TMetadata>,
  rawInput: unknown,
  options: ExecuteToolOptions<TContext>,
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

  // 两层 Guard 都只能看到 Schema 已校验的数据，避免拿畸形模型参数参与权限判断。
  const guardRequest: ToolGuardRequest<TContext, z.output<TInputSchema>, TMetadata> = {
    callId: options.callId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    tool: Object.freeze({
      name: tool.name,
      description: tool.model.description,
      inputSchema: tool.model.inputSchema,
      metadata: tool.metadata,
    }),
    input: inputResult.data,
    context: options.context as TContext,
    signal: callerSignal,
  }

  let guardDecision: ToolGuardDecision
  try {
    guardDecision = await evaluateToolGuards(
      guardRequest,
      options.toolGuardOverride === undefined
        ? tool.toolGuard
        : options.toolGuardOverride ?? undefined,
      options.globalToolGuard,
    )
  }
  catch (error) {
    return await finishFailure(
      {
        code: 'TOOL_GUARD_FAILED',
        message: error instanceof Error ? error.message : '工具 Guard 执行失败',
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
    type: 'tool.guard.decided',
    result: guardDecision,
  })

  if (guardDecision.decision === 'deny') {
    // deny 发生在 attempt 循环之前，所以业务 execute 不会运行，attempts 固定为 0。
    return await finishFailure(
      permissionDeniedError(guardDecision.reason),
      0,
      startedAt,
      base,
      options.onEvent,
    )
  }

  if (guardDecision.decision === 'ask') {
    // 先发核心轨迹，再调用交互处理器；该轨迹不携带 Server 自己生成的 approvalId。
    await emit(options.onEvent, {
      ...base(),
      type: 'tool.approval.requested',
      reason: guardDecision.reason,
    })

    let outcome: 'allowed-once' | 'rejected' | 'unavailable' | 'aborted' = 'unavailable'
    if (callerSignal.aborted) {
      outcome = 'aborted'
    }
    else if (options.requestApproval) {
      try {
        // await 只暂停当前工具 Promise，不会阻塞 Node.js 事件循环或其他 HTTP 请求。
        outcome = await options.requestApproval({
          ...guardRequest,
          reason: guardDecision.reason,
          ...(guardDecision.title ? { title: guardDecision.title } : {}),
          ...(guardDecision.details ? { details: guardDecision.details } : {}),
          ...(guardDecision.approvalTimeoutMs !== undefined
            ? { approvalTimeoutMs: guardDecision.approvalTimeoutMs }
            : {}),
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
      // rejected/unavailable 是标准权限失败；aborted 保留独立取消错误语义。
      const error = outcome === 'aborted'
        ? abortedError()
        : permissionDeniedError(`工具审批结果：${outcome}`)
      return await finishFailure(error, 0, startedAt, base, options.onEvent)
    }
  }

  // 只有 allow 或 ask -> allowed-once 能到达执行尝试；审批不会因自动重试而重复询问。
  const maxAttempts = tool.execution?.retry?.maxAttempts ?? 1
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
      tool.execution?.retry
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

    const delayMs = getRetryDelay(tool.execution!.retry!, attempt, options.random ?? Math.random)
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

/** 标记决定来自哪一层，便于在两层同时 ask/deny 时生成可解释的合并结果。 */
interface SourcedGuardDecision {
  readonly source: 'tool' | 'global'
  readonly value: ToolGuardDecision
}

/**
 * 固定执行工具级和全局 Guard，再按 deny > ask > allow 合并。
 *
 * 缺少某一层等价于该层 allow；两层都缺少时直接 allow。顺序固定为工具级、全局级，
 * 便于轨迹复现，也避免并发评估造成不可预测的外部调用顺序。
 */
async function evaluateToolGuards<
  TContext,
  TInput,
  TMetadata extends JsonObject,
>(
  request: ToolGuardRequest<TContext, TInput, TMetadata>,
  toolGuard: ToolGuardEvaluator<TContext, TInput, TMetadata> | undefined,
  globalGuard: ToolGuardEvaluator<TContext> | undefined,
): Promise<ToolGuardDecision> {
  const decisions: SourcedGuardDecision[] = []
  if (toolGuard) {
    decisions.push({
      source: 'tool',
      value: normalizeToolGuardDecision(await toolGuard(request)),
    })
  }
  if (globalGuard) {
    decisions.push({
      source: 'global',
      value: normalizeToolGuardDecision(await globalGuard(request)),
    })
  }
  return mergeGuardDecisions(decisions)
}

/** 按固定优先级收口两层结果；两层相同终态时保留来源化原因和详情。 */
function mergeGuardDecisions(
  decisions: readonly SourcedGuardDecision[],
): ToolGuardDecision {
  const denied = decisions.filter(
    (item): item is SourcedGuardDecision & { value: Extract<ToolGuardDecision, { decision: 'deny' }> } => (
      item.value.decision === 'deny'
    ),
  )
  if (denied.length > 0) {
    return Object.freeze({
      decision: 'deny' as const,
      reason: joinGuardReasons(denied),
      ...mergeGuardMetadata(denied),
    })
  }

  const asked = decisions.filter(
    (item): item is SourcedGuardDecision & { value: Extract<ToolGuardDecision, { decision: 'ask' }> } => (
      item.value.decision === 'ask'
    ),
  )
  if (asked.length > 0) {
    const globalAsk = asked.find(item => item.source === 'global')?.value
    const toolAsk = asked.find(item => item.source === 'tool')?.value
    const approvalTimeoutMs = strictestApprovalTimeout(
      asked.map(item => item.value.approvalTimeoutMs),
    )
    return Object.freeze({
      decision: 'ask' as const,
      reason: joinGuardReasons(asked),
      ...(globalAsk?.title ?? toolAsk?.title
        ? { title: globalAsk?.title ?? toolAsk?.title }
        : {}),
      ...mergeGuardDetails(asked),
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      ...mergeGuardMetadata(asked),
    })
  }

  const allowed = decisions.filter(
    (item): item is SourcedGuardDecision & { value: Extract<ToolGuardDecision, { decision: 'allow' }> } => (
      item.value.decision === 'allow'
    ),
  )
  return Object.freeze({
    decision: 'allow' as const,
    ...mergeGuardMetadata(allowed),
  })
}

/** 多层相同终态时标注来源，避免两个原因拼接后无法定位责任层。 */
function joinGuardReasons(
  decisions: readonly (SourcedGuardDecision & {
    value: Extract<ToolGuardDecision, { decision: 'deny' | 'ask' }>
  })[],
): string {
  if (decisions.length === 1)
    return decisions[0].value.reason
  return decisions
    .map(item => `${item.source === 'tool' ? '工具级' : '全局'} Guard：${item.value.reason}`)
    .join('；')
}

/** 两层 details 都存在时使用命名空间，只有一层时保持使用者原始结构。 */
function mergeGuardDetails(
  decisions: readonly (SourcedGuardDecision & {
    value: Extract<ToolGuardDecision, { decision: 'ask' }>
  })[],
): { readonly details?: JsonObject } {
  const withDetails = decisions.filter(item => item.value.details !== undefined)
  if (withDetails.length === 0)
    return {}
  if (withDetails.length === 1)
    return { details: withDetails[0].value.details }
  return {
    details: Object.fromEntries(
      withDetails.map(item => [item.source, item.value.details]),
    ) as JsonObject,
  }
}

/** 决策 metadata 采用与 details 相同的来源化合并规则。 */
function mergeGuardMetadata(
  decisions: readonly SourcedGuardDecision[],
): { readonly metadata?: JsonObject } {
  const withMetadata = decisions.filter(item => item.value.metadata !== undefined)
  if (withMetadata.length === 0)
    return {}
  if (withMetadata.length === 1)
    return { metadata: withMetadata[0].value.metadata }
  return {
    metadata: Object.fromEntries(
      withMetadata.map(item => [item.source, item.value.metadata]),
    ) as JsonObject,
  }
}

/** 多个 ask 同时存在时使用最严格的有限时限；-1 仅在没有有限时限时生效。 */
function strictestApprovalTimeout(
  values: readonly (number | undefined)[],
): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && value !== -1)
  if (finite.length > 0)
    return Math.min(...finite)
  return values.includes(-1) ? -1 : undefined
}

/** 一次尝试的内部成功结果，调用级统计由外层统一附加。 */
type AttemptResult<T>
  = | { readonly ok: true, readonly value: T, readonly content: string }
    | { readonly ok: false, readonly error: ToolErrorInfo }

/** 执行一次带协作式超时、输出校验和模型内容大小限制的工具尝试。 */
async function executeAttempt<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext,
  TMetadata extends JsonObject,
>(
  tool: DefinedTool<TInputSchema, TOutputSchema, TContext, TMetadata>,
  input: z.output<TInputSchema>,
  attempt: number,
  callerSignal: AbortSignal,
  options: ExecuteToolOptions<TContext>,
): Promise<AttemptResult<z.output<TOutputSchema>>> {
  const timeoutController = new AbortController()
  const timeoutMs = tool.execution?.timeoutMs
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = timeoutMs === undefined
    ? callerSignal
    : AbortSignal.any([callerSignal, timeoutController.signal])

  const context: ToolRunContext<TContext> = {
    callId: options.callId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    attempt,
    context: options.context as TContext,
    signal,
  }

  try {
    const rawOutput = await tool.execute(input, context)
    if (callerSignal.aborted)
      return { ok: false, error: abortedError() }
    if (timeoutController.signal.aborted)
      return { ok: false, error: timeoutError(tool.name, timeoutMs!) }

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
      return { ok: false, error: timeoutError(tool.name, timeoutMs!) }
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
  retry: ToolRetryPolicy,
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
function createEventBase<TContext>(
  toolName: string,
  options: ExecuteToolOptions<TContext>,
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

/** 超时是否实际重试仍由工具作者显式配置的重试策略决定。 */
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
