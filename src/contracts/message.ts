/** 模型消息支持的角色集合，与 OpenAI Chat Completions 的角色保持同名。 */
export type ModelMessageRole
  = | 'developer'
    | 'system'
    | 'user'
    | 'assistant'
    | 'tool'
    | 'function'

/** 模型生成的函数工具调用。参数保留为原始 JSON 文本，等待 Harness 校验。 */
export interface ModelFunctionToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

/** OpenAI 兼容协议中的自定义文本工具调用；当前 Tool Harness 尚不执行该类型。 */
export interface ModelCustomToolCall {
  readonly id: string
  readonly type: 'custom'
  readonly custom: {
    readonly name: string
    readonly input: string
  }
}

/** 模型可以返回的工具调用联合类型。 */
export type ModelToolCall = ModelFunctionToolCall | ModelCustomToolCall

/** 系统或开发者指令消息。 */
export interface ModelInstructionMessage {
  readonly role: 'developer' | 'system'
  readonly content: string
  readonly name?: string
}

/** 最终用户输入消息。 */
export interface ModelUserMessage {
  readonly role: 'user'
  readonly content: string
  readonly name?: string
}

/**
 * 模型助手消息。
 *
 * `reasoning_content` 是在 OpenAI 兼容消息上的加法扩展。需要连续思考的 adapter
 * 可以回放它，不支持该字段的供应商可以忽略或转换成自己的等价结构。
 */
export interface ModelAssistantMessage {
  readonly role: 'assistant'
  readonly content?: string | null
  readonly name?: string
  readonly refusal?: string | null
  readonly reasoning_content?: string | null
  readonly tool_calls?: readonly ModelToolCall[]
  /** OpenAI 兼容协议保留的旧版函数调用字段。 */
  readonly function_call?: {
    readonly name: string
    readonly arguments: string
  } | null
  readonly [extension: string]: unknown
}

/** 工具执行结果消息。 */
export interface ModelToolMessage {
  readonly role: 'tool'
  readonly content: string
  readonly tool_call_id: string
}

/** OpenAI 兼容协议保留的旧版函数结果消息。 */
export interface ModelFunctionMessage {
  readonly role: 'function'
  readonly name: string
  readonly content: string | null
}

/** CraftAgent 内部使用的供应商无关消息联合类型。 */
export type ModelMessage
  = | ModelInstructionMessage
    | ModelUserMessage
    | ModelAssistantMessage
    | ModelToolMessage
    | ModelFunctionMessage
