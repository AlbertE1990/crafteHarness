import type {
  ModelCompletion,
  ModelFinishReason,
  ModelFunctionToolCall,
  ModelStreamChunk,
  ModelTokenUsage,
  ModelToolCall,
} from '../contracts'
import type { HarnessLocale } from '../locale'
import { ModelError } from '../contracts'
import { DEFAULT_LOCALE, diagnostic } from '../locale'

interface PendingToolCall {
  readonly index: number
  id: string
  name: string
  arguments: string
}

/** 一个模型流结束后交给 Agent 状态机的完整 Step 投影。 */
export interface ModelStepResult {
  readonly content: string
  readonly reasoning: string
  readonly toolCalls: readonly ModelFunctionToolCall[]
  readonly finishReason?: ModelFinishReason
  readonly usage?: ModelTokenUsage
}

/**
 * 校验并投影一次完整的非流式 completion。
 *
 * AgentLoop 最终只需要第一个候选的文本、思考、函数调用、停止原因和 usage；完整原始结果
 * 仍通过 agent.model.completed 轨迹暴露，不在这里丢失。
 */
export function consumeModelCompletion(
  completion: ModelCompletion,
  provider: string,
  locale: HarnessLocale = DEFAULT_LOCALE,
): ModelStepResult {
  if (completion.object !== 'chat.completion')
    throw protocolError(provider, locale, '非流式模型结果 object 必须是 chat.completion', 'Non-streaming model result object must be chat.completion')
  if (!Array.isArray(completion.choices))
    throw protocolError(provider, locale, '非流式模型结果 choices 必须是数组', 'Non-streaming model result choices must be an array')

  const choice = completion.choices.find(item => item.index === 0)
    ?? completion.choices[0]
  if (!choice)
    throw protocolError(provider, locale, '非流式模型结果没有候选消息', 'Non-streaming model result has no candidate message')
  if (choice.message.role !== 'assistant')
    throw protocolError(provider, locale, '非流式模型候选必须返回 assistant 消息', 'Non-streaming model candidate must return an assistant message')
  if (choice.message.function_call)
    throw protocolError(provider, locale, '当前 AgentLoop 不支持旧版 function_call', 'AgentLoop does not support legacy function_call')
  if (choice.message.content !== undefined
    && choice.message.content !== null
    && typeof choice.message.content !== 'string') {
    throw protocolError(provider, locale, '非流式 assistant content 必须是字符串或 null', 'Non-streaming assistant content must be a string or null')
  }
  if (choice.message.reasoning_content !== undefined
    && choice.message.reasoning_content !== null
    && typeof choice.message.reasoning_content !== 'string') {
    throw protocolError(provider, locale, '非流式 assistant reasoning_content 必须是字符串或 null', 'Non-streaming assistant reasoning_content must be a string or null')
  }

  const rawToolCalls = (choice.message.tool_calls ?? []) as readonly ModelToolCall[]
  const toolCalls = rawToolCalls.map((call): ModelFunctionToolCall => {
    if (call.type === 'custom')
      throw protocolError(provider, locale, '当前 AgentLoop 不支持 custom 工具调用', 'AgentLoop does not support custom tool calls')
    if (!call.id || !call.function.name || typeof call.function.arguments !== 'string')
      throw protocolError(provider, locale, '模型返回了不完整的工具调用', 'The model returned an incomplete tool call')
    return call
  })
  const ids = new Set(toolCalls.map(call => call.id))
  if (ids.size !== toolCalls.length)
    throw protocolError(provider, locale, '同一 Step 中的工具调用 ID 必须唯一', 'Tool call IDs must be unique within a Step')
  if (choice.finish_reason === 'tool_calls' && toolCalls.length === 0)
    throw protocolError(provider, locale, '模型以 tool_calls 停止，但没有返回工具调用', 'The model stopped with tool_calls but returned no tool calls')
  if (completion.usage)
    validateUsage(completion.usage, provider, locale)

  return {
    content: choice.message.content ?? '',
    reasoning: choice.message.reasoning_content ?? '',
    toolCalls,
    ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(completion.usage ? { usage: completion.usage } : {}),
  }
}

/** 消费标准 chunk，并组装一个完整 Step 的文本、reasoning 和函数调用。 */
export async function consumeModelStream(
  stream: AsyncIterable<ModelStreamChunk>,
  onChunk: (chunk: ModelStreamChunk) => Promise<void>,
  provider: string,
  locale: HarnessLocale = DEFAULT_LOCALE,
): Promise<ModelStepResult> {
  const pending = new Map<number, PendingToolCall>()
  let content = ''
  let reasoning = ''
  let finishReason: ModelFinishReason | undefined
  let usage: ModelTokenUsage | undefined

  for await (const chunk of stream) {
    await onChunk(chunk)
    if (chunk.usage) {
      validateUsage(chunk.usage, provider, locale)
      usage = chunk.usage
    }

    const choice = chunk.choices.find(item => item.index === 0) ?? chunk.choices[0]
    if (!choice)
      continue
    if (choice.finish_reason)
      finishReason = choice.finish_reason
    if (choice.delta.function_call)
      throw protocolError(provider, locale, '当前 AgentLoop 不支持旧版 function_call 增量', 'AgentLoop does not support legacy function_call deltas')

    content += choice.delta.content ?? ''
    reasoning += choice.delta.reasoning_content ?? ''

    for (const fragment of choice.delta.tool_calls ?? []) {
      if (!Number.isSafeInteger(fragment.index) || fragment.index < 0)
        throw protocolError(provider, locale, '模型工具调用 index 必须是非负安全整数', 'Model tool call index must be a non-negative safe integer')
      if (fragment.type === 'custom' || 'custom' in fragment)
        throw protocolError(provider, locale, '当前 AgentLoop 不支持 custom 工具调用', 'AgentLoop does not support custom tool calls')
      if (!('function' in fragment))
        throw protocolError(provider, locale, '模型返回了无法识别的工具调用增量', 'The model returned an unrecognized tool call delta')

      const current = pending.get(fragment.index) ?? {
        index: fragment.index,
        id: '',
        name: '',
        arguments: '',
      }
      if (fragment.id && current.id && fragment.id !== current.id)
        throw protocolError(provider, locale, `工具调用 index=${fragment.index} 返回了冲突 ID`, `Tool call index=${fragment.index} returned conflicting IDs`)
      current.id ||= fragment.id ?? ''
      current.name += fragment.function?.name ?? ''
      current.arguments += fragment.function?.arguments ?? ''
      pending.set(fragment.index, current)
    }
  }

  const toolCalls = [...pending.values()]
    .sort((left, right) => left.index - right.index)
    .map((call): ModelFunctionToolCall => {
      if (!call.id || !call.name)
        throw protocolError(provider, locale, '模型返回了不完整的工具调用', 'The model returned an incomplete tool call')
      return {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }
    })
  const ids = new Set(toolCalls.map(call => call.id))
  if (ids.size !== toolCalls.length)
    throw protocolError(provider, locale, '同一 Step 中的工具调用 ID 必须唯一', 'Tool call IDs must be unique within a Step')
  if (finishReason === 'tool_calls' && toolCalls.length === 0)
    throw protocolError(provider, locale, '模型以 tool_calls 停止，但没有返回工具调用', 'The model stopped with tool_calls but returned no tool calls')

  return {
    content,
    reasoning,
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** 构造模型协议错误，并保留 Adapter provider。 */
function protocolError(
  provider: string,
  locale: HarnessLocale,
  zhCN: string,
  enUS: string,
): ModelError {
  return new ModelError({
    code: 'MODEL_PROTOCOL_ERROR',
    message: diagnostic(locale, zhCN, enUS),
    provider,
  })
}

/** 模型 usage 属于外部运行时数据，进入预算计算前必须验证。 */
function validateUsage(usage: ModelTokenUsage, provider: string, locale: HarnessLocale): void {
  for (const field of ['completion_tokens', 'prompt_tokens', 'total_tokens'] as const) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0)
      throw protocolError(provider, locale, `模型 usage.${field} 必须是非负安全整数`, `Model usage.${field} must be a non-negative safe integer`)
  }
}
