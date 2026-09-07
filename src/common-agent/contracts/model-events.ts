import type { JsonObject } from '../types/json'
import type { ModelMessageRole } from './message'
import type { ModelFinishReason, ModelTokenUsage } from './model'

/** OpenAI 兼容流中的旧版函数调用增量。 */
export interface ModelFunctionCallDelta {
  readonly name?: string
  readonly arguments?: string
}

/** OpenAI 兼容流中的函数工具调用增量。 */
export interface ModelFunctionToolCallDelta {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly function?: ModelFunctionCallDelta
}

/** OpenAI 兼容流中的自定义工具调用增量。 */
export interface ModelCustomToolCallDelta {
  readonly index: number
  readonly id?: string
  readonly type?: 'custom'
  readonly custom?: {
    readonly name?: string
    readonly input?: string
  }
}

/** 模型流中的工具调用增量。 */
export type ModelToolCallDelta
  = | ModelFunctionToolCallDelta
    | ModelCustomToolCallDelta

/**
 * 模型消息增量，以 OpenAI `ChatCompletionChunk.Choice.Delta` 为基线。
 *
 * 标准字段保持原名；`reasoning_content` 是 CommonAgent 的加法扩展。索引签名允许
 * 后续 adapter 保留供应商新增字段，而不迫使 Agent Core 直接依赖供应商 SDK 类型。
 */
export interface ModelChoiceDelta {
  readonly content?: string | null
  readonly function_call?: ModelFunctionCallDelta
  readonly refusal?: string | null
  readonly role?: ModelMessageRole | null
  readonly tool_calls?: readonly ModelToolCallDelta[]
  readonly reasoning_content?: string | null
  readonly [extension: string]: unknown
}

/** OpenAI 兼容流中的单个候选增量。 */
export interface ModelStreamChoice {
  readonly delta: ModelChoiceDelta
  readonly finish_reason: ModelFinishReason | null
  readonly index: number
  readonly logprobs?: JsonObject | null
  readonly [extension: string]: unknown
}

/**
 * CommonAgent 标准模型流块。
 *
 * 必需字段与 OpenAI Chat Completions chunk 一致，adapter 只能在此基础上增加字段，
 * 不能删改已有字段语义。`provider` 用于诊断来源，不参与模型控制流程。
 */
export interface ModelStreamChunk {
  readonly id: string
  readonly choices: readonly ModelStreamChoice[]
  readonly created: number
  readonly model: string
  readonly object: 'chat.completion.chunk'
  readonly moderation?: JsonObject | null
  readonly obfuscation?: string
  readonly service_tier?: string | null
  readonly system_fingerprint?: string
  readonly usage?: ModelTokenUsage | null
  readonly provider?: string
  readonly [extension: string]: unknown
}
