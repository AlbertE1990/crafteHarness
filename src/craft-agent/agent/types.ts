import type {
  ModelMessage,
  SessionSummary,
} from '../contracts'
import type {
  AgentEventListener,
  AgentRunResult,
} from '../core'
import type { JsonObject } from '../types/json'
import type { ToolGuardOutputEvent } from './tool-guard'

/** Agent.run() 的业务输入；未传 sessionId 时由 Agent 自动创建。 */
export interface AgentRequest {
  readonly input: string
  readonly sessionId?: string
  readonly sessionMetadata?: JsonObject
}

/** 面向应用层的精简实时输出；完整执行轨迹由 onTrace 暴露。 */
export type AgentOutputEvent
  = ToolGuardOutputEvent
    | { readonly type: 'session.started', readonly sessionId: string }
    | {
      readonly type: 'message.delta'
      readonly sessionId: string
      readonly channel: 'reasoning' | 'content'
      readonly delta: string
    }
    | {
      readonly type: 'message.completed'
      readonly sessionId: string
      readonly content: string
      readonly reasoning: string
    }
    | {
      readonly type: 'error'
      readonly sessionId: string
      readonly message: string
      readonly code: string
      readonly stopReason: AgentRunResult['stopReason']
    }

/** 观察面向应用层实时输出的回调；异常会被隔离。 */
export type AgentOutputEventListener
  = (event: AgentOutputEvent) => void | Promise<void>

/** 单次运行的取消、关联 ID 与两级事件观察选项。 */
export interface AgentExecutionOptions {
  readonly signal?: AbortSignal
  readonly runId?: string
  readonly turnId?: string
  /** 适合 CLI、SSE 和业务界面的精简输出。 */
  readonly onEvent?: AgentOutputEventListener
  /** 适合调试器和轨迹存储的完整 AgentEvent。 */
  readonly onTrace?: AgentEventListener
}

/** 会话详情中的一条模型消息，同时保留其 Session Log 关联信息。 */
export interface AgentSessionMessage {
  readonly eventId: string
  readonly sessionId: string
  readonly sequence: number
  readonly timestamp: string
  readonly runId?: string
  readonly turnId?: string
  readonly message: ModelMessage
}

/** Agent.getSession() 返回的会话详情，不包含任何前端专用字段。 */
export interface AgentSessionDetail extends SessionSummary {
  readonly messages: readonly AgentSessionMessage[]
}

/** Agent.getSession() 的可选查询参数。 */
export interface GetAgentSessionOptions {
  /** 读取完整快照时每页的事件数。 */
  readonly pageSize?: number
}
