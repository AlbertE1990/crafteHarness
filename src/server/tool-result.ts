import { inspect } from 'node:util'

export interface ToolRunContext {
  signal?: AbortSignal
}

export interface ToolErrorInfo {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ToolRetryPolicy {
  /** 包含首次执行在内的最大尝试次数。 */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export type ToolFunction = (
  args: unknown,
  context: ToolRunContext,
) => unknown | Promise<unknown>

/** 工具是否可重试由定义者声明；没有 retry 即表示 Harness 不得自动重试。 */
export interface ToolDefinition {
  execute: ToolFunction
  retry?: ToolRetryPolicy
}

export interface ToolExecutionSuccess {
  isError: false
  /** 工具返回的原始业务值，仅供 Harness 内部观察。 */
  value: unknown
  /** 写入模型上下文的容错字符串投影。 */
  content: string
  attempts: number
}

export interface ToolExecutionFailure {
  isError: true
  error: ToolErrorInfo
  content: string
  attempts: number
}

/** Harness 内部统一结果；业务工具本身不需要构造这个结构。 */
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

/**
 * 工具用异常表达失败和是否为临时故障；最终是否重试仍由 Harness 的工具策略决定。
 */
export class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ToolCallError'
  }
}

export function normalizeToolError(error: unknown): ToolErrorInfo {
  if (error instanceof ToolCallError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    }
  }

  return {
    code: 'TOOL_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

/**
 * 优先保留字符串，其次尝试 JSON，再使用 Node 的安全对象检查文本。
 * 即使工具未返回约定结构，也尽量把结果交给模型，而不是把成功调用误判成失败。
 */
export function renderToolValue(value: unknown): string {
  if (typeof value === 'string')
    return value

  try {
    const json = JSON.stringify(value)
    if (json !== undefined)
      return json
  }
  catch {
    // 循环引用、BigInt 等值不能 JSON 序列化时继续尝试可读文本投影。
  }

  try {
    return inspect(value, { depth: 6, breakLength: 120 })
  }
  catch {
    try {
      return String(value)
    }
    catch {
      return '[工具执行成功，但返回值无法序列化]'
    }
  }
}

/** 构造 Harness 内部失败结果；该结构不会要求业务工具主动返回。 */
export function createToolExecutionFailure(
  error: ToolErrorInfo,
  attempts: number,
): ToolExecutionFailure {
  return {
    isError: true,
    error,
    // 与 DeepSeek Harness 一致：模型只看简洁错误文本，错误码保留给内部诊断。
    content: `Error: ${error.message}`,
    attempts,
  }
}

/**
 * 等待下一次重试。等待期间若请求被取消，则立即返回 false。
 */
async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted)
    return false

  return await new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Harness 的统一执行入口：接收工具原始返回值，负责字符串投影、失败封装和重试。
 * 自动重试必须同时满足：工具定义了 retry 策略，且本次异常标记为 retryable。
 */
export async function executeToolDefinition(
  definition: ToolDefinition,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const policy = definition.retry
  const maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? 1))

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      return createToolExecutionFailure({
        code: 'ABORTED',
        message: '工具调用已取消',
        retryable: false,
      }, attempt - 1)
    }

    try {
      const value = await definition.execute(args, { signal })
      return {
        isError: false,
        value,
        content: renderToolValue(value),
        attempts: attempt,
      }
    }
    catch (error) {
      const normalized = normalizeToolError(error)
      const shouldRetry = Boolean(
        policy
        && normalized.retryable
        && attempt < maxAttempts
        && !signal?.aborted,
      )

      if (!shouldRetry)
        return createToolExecutionFailure(normalized, attempt)

      // 指数退避附加少量随机抖动，避免多个请求在服务恢复时同时重放。
      const exponentialDelay = Math.min(
        policy!.maxDelayMs,
        policy!.baseDelayMs * 2 ** (attempt - 1),
      )
      const jitter = exponentialDelay > 0 ? Math.random() * exponentialDelay * 0.2 : 0
      const shouldContinue = await waitForRetry(exponentialDelay + jitter, signal)
      if (!shouldContinue) {
        return createToolExecutionFailure({
          code: 'ABORTED',
          message: '工具调用已取消',
          retryable: false,
        }, attempt)
      }
    }
  }

  // 循环按 maxAttempts 必然提前返回，这里仅用于类型穷尽。
  return createToolExecutionFailure({
    code: 'TOOL_EXECUTION_FAILED',
    message: '工具执行失败',
    retryable: false,
  }, maxAttempts)
}
