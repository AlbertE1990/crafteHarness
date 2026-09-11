import type { HarnessLocale } from '../locale'
import type { ToolModelDefinition } from '../tools'
import type { JsonObject } from '../types/json'
import type { ModelAssistantMessage, ModelMessage } from './message'
import type { ModelStreamChunk } from './model-events'

/**
 * Core 保留的推理强度字面量：显式关闭推理。
 *
 * 它是供应商无关的意图，因此由 Core 定义并作为契约词汇的一部分；ModelAdapter 必须按这个
 * 小写字面量识别它，再翻译成自己协议上的关闭语义（DeepSeek 是 `thinking.type: disabled`，
 * OpenAI 兼容是 `reasoning_effort: none`）。上游会先归一化大小写，Adapter 无需自行处理。
 */
export const REASONING_OFF = 'off'

/** 一次 Agent Run 使用的模型标识与可选推理强度。 */
export interface ModelSelection {
  /** 供应商识别的模型 ID；展示名称应由应用自己的模型目录维护。 */
  readonly id: string
  /** CraftAgent 标准化的推理强度，由 Adapter 翻译成供应商字段。 */
  readonly reasoningEffort?: string
}

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

/**
 * 一次模型请求。连接配置归 Adapter，模型标识和推理强度按 Run 传入。
 */
export interface ModelRequest {
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolModelDefinition[]
  /**
   * 本次调用的推理强度；`REASONING_OFF` 是 Core 保留值，表示显式关闭推理。
   *
   * 这是全链路唯一的推理设置形态：其他任何非空字符串都是供应商定义的等级，Adapter
   * 原样透传、不做等级校验，合法值最终由供应商裁定。保留值由上游统一归一化为小写
   * `REASONING_OFF`，因此 Adapter 只需按该字面量识别，不必各自处理大小写。省略该字段
   * 表示不下发任何推理参数，由供应商或模型自身默认值决定。
   */
  readonly reasoningEffort?: string
  readonly max_completion_tokens?: number
  readonly parallel_tool_calls?: boolean
  readonly tool_choice?: 'none' | 'auto' | 'required'
}

/** 单次模型调用的取消与关联选项。 */
export interface ModelCallOptions {
  /** Adapter 自身产生诊断文本时使用的语言；默认 zh-CN。 */
  readonly locale?: HarnessLocale
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
 * Core 只依赖本接口。具体 SDK、鉴权、base URL 和供应商错误必须封装在实现内部；模型名随
 * ModelRequest 传入，使同一个 Adapter 可以服务多个兼容模型。
 */
export interface ModelAdapter {
  readonly provider: string
  complete: (
    request: ModelRequest,
    options?: ModelCallOptions,
  ) => Promise<ModelCompletion>
  stream: (
    request: ModelRequest,
    options?: ModelCallOptions,
  ) => Promise<AsyncIterable<ModelStreamChunk>>
}
