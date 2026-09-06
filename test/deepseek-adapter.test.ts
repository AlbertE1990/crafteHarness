import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions'
import { describe, expect, it } from 'vitest'
import {
  createDeepSeekToolCallMessage,
  getDeepSeekReasoningDelta,
} from '../src/server/deepseek-adapter'

const toolCall: ChatCompletionMessageFunctionToolCall = {
  id: 'call-weather',
  type: 'function',
  function: {
    name: 'get_weather',
    arguments: '{"city":"杭州"}',
  },
}

describe('deepSeek provider adapter', () => {
  it('normalizes the provider-specific reasoning delta', () => {
    expect(getDeepSeekReasoningDelta({ reasoning_content: '分析天气请求' }))
      .toBe('分析天气请求')
    expect(getDeepSeekReasoningDelta({ reasoning_content: null })).toBe('')
    expect(getDeepSeekReasoningDelta({ content: '最终回答' })).toBe('')
  })

  it('keeps an empty reasoning_content field on tool-call messages', () => {
    const message = createDeepSeekToolCallMessage('', '', [toolCall])
    const wireMessage = message as unknown as Record<string, unknown>

    expect(wireMessage).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [toolCall],
    })
    expect(Object.hasOwn(wireMessage, 'reasoning_content')).toBe(true)
  })
})
