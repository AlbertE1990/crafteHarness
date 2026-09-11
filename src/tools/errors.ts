import type { JsonObject, JsonValue } from '../types/json'

/** 可安全进入日志与轨迹的工具错误信息。 */
export interface ToolErrorInfo {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: JsonObject
}

/** 创建 ToolError 时使用的结构化参数。 */
export interface ToolErrorOptions {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: JsonObject
  readonly cause?: unknown
}

/**
 * 工具实现主动抛出的规范错误。
 *
 * `retryable` 只表达本次故障是否临时；Harness 仍会检查工具重试策略与幂等性。
 */
export class ToolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: JsonObject

  constructor(options: ToolErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'ToolError'
    this.code = options.code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

/** 将任意异常转换为稳定、可序列化的工具错误。 */
export function normalizeToolError(error: unknown): ToolErrorInfo {
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    }
  }

  return {
    code: 'TOOL_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : safelyStringify(error),
    retryable: false,
  }
}

/** 在未知值无法正常转成字符串时仍返回安全的诊断文本。 */
function safelyStringify(value: unknown): string {
  try {
    return String(value)
  }
  catch {
    return '[无法读取的工具异常]'
  }
}

/** 把校验器 issue 转成不包含原始敏感输入的 JSON 详情。 */
export function validationIssuesToJson(
  issues: readonly { code?: string, message: string, path: readonly PropertyKey[] }[],
): JsonObject {
  return {
    issues: issues.map(issue => ({
      code: issue.code ?? 'validation_error',
      message: issue.message,
      path: issue.path.map(String),
    })) as JsonValue,
  }
}
