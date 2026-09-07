import type { ToolModelDefinition } from '../tools'
import type { JsonObject } from '../types/json'
import type { ModelAssistantMessage, ModelMessage } from './message'
import type { ModelStreamChunk } from './model-events'

/** OpenAI Chat Completions 已定义的停止原因，并允许 adapter 保留新增字符串。 */
export type ModelFinishReason
  = | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | 'function_call'
    | (string & {})

/** 模型 token 用量；字段名复用 OpenAI Chat Completions。 */
export interface ModelTokenUsage {
  readonly completion_tokens: number
  readonly prompt_tokens: number
  readonly total_tokens: number
  readonly completion_tokens_details?: JsonObject | null
  readonly prompt_tokens_details?: JsonObject | null
  readonly [extension: string]: unknown
}

/** 一次模型请求。模型标识和供应商连接配置归具体 Adapter，而不是每次请求。 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolModelDefinition[]
  readonly max_completion_tokens?: number
  readonly parallel_tool_calls?: boolean
  readonly tool_choice?: 'none' | 'auto' | 'required'
}

/** 单次模型调用的取消与关联选项。 */
export interface ModelCallOptions {
  readonly signal?: AbortSignal
  readonly runId?: string
  readonly sessionId?: string
}

/** 非流式模型结果中的单个候选。 */
export interface ModelCompletionChoice {
  readonly finish_reason: ModelFinishReason
  readonly index: number
  readonly logprobs: JsonObject | null
  readonly message: ModelAssistantMessage
  readonly [extension: string]: unknown
}

/** 非流式模型结果，保持 OpenAI Chat Completions 的主体结构。 */
export interface ModelCompletion {
  readonly id: string
  readonly choices: readonly ModelCompletionChoice[]
  readonly created: number
  readonly model: string
  readonly object: 'chat.completion'
  readonly metadata?: JsonObject | null
  readonly moderation?: JsonObject | null
  readonly service_tier?: string | null
  readonly system_fingerprint?: string
  readonly usage?: ModelTokenUsage
  readonly provider?: string
  readonly [extension: string]: unknown
}

/**
 * 模型供应商适配接口。
 *
 * Core 只依赖本接口。具体 SDK、鉴权、base URL、模型名和供应商错误必须封装在实现内部。
 */
export interface ModelAdapter {
  readonly provider: string
  readonly model: string
  complete: (
    request: ModelRequest,
    options?: ModelCallOptions,
  ) => Promise<ModelCompletion>
  stream: (
    request: ModelRequest,
    options?: ModelCallOptions,
  ) => Promise<AsyncIterable<ModelStreamChunk>>
}
