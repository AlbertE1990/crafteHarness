/** Session Store 对外暴露的稳定错误码。 */
export type SessionStoreErrorCode
  = | 'SESSION_INVALID_ARGUMENT'
    | 'SESSION_VERSION_CONFLICT'
    | 'SESSION_INVALID_EVENT_SEQUENCE'
    | 'SESSION_SERIALIZATION_FAILED'
    | 'SESSION_EVENT_ID_CONFLICT'

/** 构造 SessionStoreError 时使用的结构化信息。 */
export interface SessionStoreErrorOptions {
  readonly code: SessionStoreErrorCode
  readonly message: string
  readonly sessionId?: string
  readonly expectedVersion?: number
  readonly actualVersion?: number
  readonly cause?: unknown
}

/** Session 协议或持久化边界产生的规范错误。 */
export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode
  readonly sessionId?: string
  readonly expectedVersion?: number
  readonly actualVersion?: number

  constructor(options: SessionStoreErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'SessionStoreError'
    this.code = options.code
    this.sessionId = options.sessionId
    this.expectedVersion = options.expectedVersion
    this.actualVersion = options.actualVersion
  }
}
