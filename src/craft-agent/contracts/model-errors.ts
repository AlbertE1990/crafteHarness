/** 模型调用跨供应商保持稳定的错误分类。 */
export type ModelErrorCode
  = | 'MODEL_ABORTED'
    | 'MODEL_TIMEOUT'
    | 'MODEL_AUTHENTICATION_FAILED'
    | 'MODEL_PERMISSION_DENIED'
    | 'MODEL_RATE_LIMITED'
    | 'MODEL_CONTEXT_LENGTH_EXCEEDED'
    | 'MODEL_INVALID_REQUEST'
    | 'MODEL_UNAVAILABLE'
    | 'MODEL_PROTOCOL_ERROR'
    | 'MODEL_CALL_FAILED'

/** 创建规范模型错误时使用的参数。 */
export interface ModelErrorOptions {
  readonly code: ModelErrorCode
  readonly message: string
  readonly provider: string
  readonly retryable?: boolean
  readonly status?: number
  readonly cause?: unknown
}

/**
 * Adapter 输出的规范模型错误。
 *
 * Adapter 只负责分类，不在内部重试；后续 Agent Loop 会结合预算、取消和轨迹决定是否重试。
 */
export class ModelError extends Error {
  readonly code: ModelErrorCode
  readonly provider: string
  readonly retryable: boolean
  readonly status?: number

  constructor(options: ModelErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'ModelError'
    this.code = options.code
    this.provider = options.provider
    this.retryable = options.retryable ?? false
    this.status = options.status
  }
}
