import type { JsonObject } from '../types/json'
import type { ModelMessage } from './message'

/** Session Event 可选的 Run/Turn 关联字段。 */
export interface SessionEventCorrelation {
  readonly runId?: string
  readonly turnId?: string
}

/** 创建一个新 Session 时写入的第一个事实。 */
export interface SessionCreatedEventDraft {
  readonly type: 'session.created'
  readonly metadata?: JsonObject
}

/** 把一条模型可见消息追加到 Session 历史。 */
export interface SessionMessageAppendedEventDraft extends SessionEventCorrelation {
  readonly type: 'message.appended'
  readonly message: ModelMessage
}

/** 标记一次 Turn 已经开始。 */
export interface SessionTurnStartedEventDraft {
  readonly type: 'turn.started'
  readonly runId?: string
  readonly turnId: string
}

/** 标记一次 Turn 已经正常完成。 */
export interface SessionTurnCompletedEventDraft {
  readonly type: 'turn.completed'
  readonly runId?: string
  readonly turnId: string
}

/** 可安全持久化的 Turn 失败信息。 */
export interface SessionFailureInfo {
  readonly code: string
  readonly message: string
  readonly details?: JsonObject
}

/** 标记一次 Turn 因异常结束。 */
export interface SessionTurnFailedEventDraft {
  readonly type: 'turn.failed'
  readonly runId?: string
  readonly turnId: string
  readonly error: SessionFailureInfo
}

/** 标记一次 Turn 被调用方主动取消。 */
export interface SessionTurnCancelledEventDraft {
  readonly type: 'turn.cancelled'
  readonly runId?: string
  readonly turnId: string
  readonly reason?: string
}

/** Store 分配身份和顺序前，由 Agent Loop 创建的 Session 事实。 */
export type SessionEventDraft
  = | SessionCreatedEventDraft
    | SessionMessageAppendedEventDraft
    | SessionTurnStartedEventDraft
    | SessionTurnCompletedEventDraft
    | SessionTurnFailedEventDraft
    | SessionTurnCancelledEventDraft

/** Store 为每个 Session Event 附加的稳定持久化信封。 */
export interface SessionEventEnvelope {
  readonly eventId: string
  readonly sessionId: string
  /** Session 内从 1 开始严格递增且无空洞的顺序号。 */
  readonly sequence: number
  /** Store 接受该事实时生成的 ISO 8601 时间。 */
  readonly timestamp: string
}

/** Append-only Session Log 中已经持久化的事实。 */
export type SessionEvent = SessionEventEnvelope & SessionEventDraft

/** 原子追加一批 Session Event 时使用的请求。 */
export interface AppendSessionEventsRequest {
  readonly sessionId: string
  /** 调用方最后观察到的版本；新 Session 从 0 开始。 */
  readonly expectedVersion: number
  readonly events: readonly SessionEventDraft[]
}

/** 成功追加后返回的新版本和本次写入事件。 */
export interface AppendSessionEventsResult {
  readonly sessionId: string
  readonly previousVersion: number
  readonly version: number
  readonly events: readonly SessionEvent[]
}

/** 分页读取 Session Event 时使用的控制参数。 */
export interface ReadSessionEventsOptions {
  /** 只返回 sequence 大于该值的事件，默认 0。 */
  readonly afterSequence?: number
  /** 单页事件数，默认 100，最大 1000。 */
  readonly limit?: number
  /** 固定读取到某一版本，确保多页读取期间不会混入新追加事件。 */
  readonly throughVersion?: number
}

/** Session Event 的一致性分页结果。 */
export interface SessionEventPage {
  readonly sessionId: string
  /** 当前页面所属的一致性快照版本。 */
  readonly snapshotVersion: number
  /** 读取发生时 Store 中的最新版本。 */
  readonly latestVersion: number
  readonly events: readonly SessionEvent[]
  readonly hasMore: boolean
  /** 下一页应使用的 afterSequence；空页面保持原游标。 */
  readonly nextAfterSequence: number
}

/** 一次完整、一致的 Session Event 快照。 */
export interface SessionSnapshot {
  readonly sessionId: string
  readonly version: number
  readonly events: readonly SessionEvent[]
}

/**
 * Session 持久化端口。
 *
 * 实现可以使用内存、文件或数据库，但必须保持原子追加、乐观并发和稳定顺序语义。
 */
export interface SessionStore {
  append: (request: AppendSessionEventsRequest) => Promise<AppendSessionEventsResult>
  read: (
    sessionId: string,
    options?: ReadSessionEventsOptions,
  ) => Promise<SessionEventPage>
}
