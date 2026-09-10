import type {
  ModelMessage,
  SessionSummary,
} from '../contracts'
import type { AgentRunResult } from '../core'
import type { JsonObject } from '../types/json'
import type { ToolGuardOutputEvent } from './tool-guard'

/** 单次 Agent 请求的模型选项；传给 Adapter 前会被转换为供应商无关的嵌套协议。 */
export type AgentModelExecutionOptions
  = | {
    readonly reasoningEnabled?: true
    /** 供应商定义的推理强度；填写它即表示启用推理。 */
    readonly reasoningEffort?: string
  }
  | {
    readonly reasoningEnabled: false
    readonly reasoningEffort?: never
  }

/** 校验并继承构造默认值后的扁平模型选项。 */
export interface DefinedAgentModelExecutionOptions {
  readonly reasoningEnabled?: boolean
  readonly reasoningEffort?: string
}

/** 所有 Agent 请求共有的业务字段。 */
interface AgentRequestBase {
  readonly input: string
  readonly sessionId?: string
  readonly sessionMetadata?: JsonObject
  /** 覆盖本次请求的模型默认值；流式方式由 invoke()/stream() 决定。 */
  readonly model?: AgentModelExecutionOptions
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

/** Agent.getSession() 的可选查询参数。 */
export interface GetAgentSessionOptions {
  /** 读取完整快照时每页的事件数。 */
  readonly pageSize?: number
}
