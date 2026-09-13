import type { AgentEvent } from 'craft-harness'

/** HTTP 分页游标使用数据库分配的稳定轨迹序号。 */
export interface TrajectoryEventRecord {
  readonly sequence: number
  readonly event: AgentEvent
}

export interface ReadTrajectoryRequest {
  readonly scopeId: string
  readonly sessionId: string
  /** 只读取此序号之前的事件；省略时从最新事件向前读取。 */
  readonly beforeSequence?: number
  readonly limit: number
}

export interface TrajectoryEventPage {
  readonly events: readonly TrajectoryEventRecord[]
  readonly hasEarlier: boolean
  readonly nextBeforeSequence?: number
}

/**
 * Sample Runtime 的旁路轨迹端口。
 *
 * CraftAgent 只负责发出 `onTrace`；作用域绑定、持久化与 HTTP 查询全部留在应用层。
 */
export interface TrajectoryStore {
  readonly record: (event: AgentEvent) => Promise<void>
  readonly bindSession: (scopeId: string, sessionId: string) => Promise<void>
  readonly read: (request: ReadTrajectoryRequest) => Promise<TrajectoryEventPage>
}
