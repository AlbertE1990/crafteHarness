import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'

interface DeepSeekReasoningDelta {
  reasoning_content?: unknown
}

/**
 * 从 DeepSeek 的 OpenAI 兼容增量中读取供应商专属思考字段。
 * 通用 Agent 只接收规范化后的字符串，不直接依赖供应商响应结构。
 */
export function getDeepSeekReasoningDelta(delta: unknown): string {
  if (typeof delta !== 'object' || delta === null)
    return ''

  const reasoning = (delta as DeepSeekReasoningDelta).reasoning_content
  return typeof reasoning === 'string' ? reasoning : ''
}

/**
 * 创建 DeepSeek 工具调用消息。Thinking Mode 要求后续工具轮次原样带回
 * reasoning_content；即使本轮思考为空，也必须保留空字符串字段。
 */
export function createDeepSeekToolCallMessage(
  content: string,
  reasoning: string,
  toolCalls: ChatCompletionMessageFunctionToolCall[],
): ChatCompletionMessageParam {
  return {
    role: 'assistant',
    // DeepSeek 对纯工具调用消息使用空字符串；部分兼容网关会拒绝 null。
    content: content || '',
    reasoning_content: reasoning,
    tool_calls: toolCalls,
  } as ChatCompletionMessageParam
}
