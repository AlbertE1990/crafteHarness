import type {
  ModelMessage,
  ModelSelection,
  SessionIdentity,
  SessionSummary,
} from '../contracts'
import type { AgentRunResult } from '../core'
import type { JsonObject } from '../types/json'
import type { ToolGuardOutputEvent } from './tool-guard'

/** 所有 Agent 请求共有的业务字段。 */
interface AgentRequestBase {
  /** Session 数据分区；单用户 Runtime 也应显式组装固定值。 */
  readonly scopeId: string
  readonly input: string
  readonly sessionId?: string
  /** 仅在创建新 Session 时写入标准可搜索名称。 */
  readonly sessionName?: string
  readonly sessionMetadata?: JsonObject
  /** 整体覆盖默认模型选择；省略 reasoningEffort 表示使用供应商默认值。 */
  readonly model?: ModelSelection
}

/**
 * Agent.invoke()/stream() 的业务输入；未传 sessionId 时由 Agent 自动创建。
 *
 * Agent 声明了运行上下文类型后，context 成为必填字段；默认无上下文时无需传入。
 */
export type AgentRequest<TContext = undefined>
  = AgentRequestBase & ([TContext] extends [undefined]
    ? { readonly context?: undefined }
    : { readonly context: TContext })

/** 面向应用层的标准实时输出；可直接传输，完整执行轨迹由 onTrace 暴露。 */
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

/** Agent.getSession() 的作用域身份和可选分页参数。 */
export interface GetAgentSessionRequest extends SessionIdentity {
  /** 读取完整快照时每页的事件数。 */
  readonly pageSize?: number
}
