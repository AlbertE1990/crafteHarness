import type OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions'
import type { DeepSeekModelAdapterConfig } from '../src/craft-agent/adapters/deepseek'
import { describe, expect, it, vi } from 'vitest'
import {
  DeepSeekModelAdapter,
  getDeepSeekReasoningContent,
  normalizeDeepSeekChunk,
  normalizeDeepSeekCompletion,
  normalizeDeepSeekError,
} from '../src/craft-agent/adapters/deepseek'

function createMockClient(create: ReturnType<typeof vi.fn>): OpenAI {
  return {
    chat: { completions: { create } },
  } as unknown as OpenAI
}

function createChunk(
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice['finish_reason'] = null,
): ChatCompletionChunk {
  return {
    id: 'completion-1',
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1_788_748_800,
    model: 'deepseek-v4-flash',
    object: 'chat.completion.chunk',
    usage: null,
  }
}

describe('deepSeek model adapter', () => {
  it('keeps OpenAI chunk fields and adds normalized reasoning/provider fields', () => {
    const source = {
      ...createChunk({ content: null }),
      future_standard_field: { retained: true },
      choices: [{
        delta: {
          content: null,
          reasoning_content: '分析天气请求',
          future_delta_field: 'retained',
        },
        finish_reason: null,
        index: 0,
      }],
    } as unknown as ChatCompletionChunk

    const chunk = normalizeDeepSeekChunk(source)

    expect(chunk).toMatchObject({
      id: 'completion-1',
      model: 'deepseek-v4-flash',
      object: 'chat.completion.chunk',
      provider: 'deepseek',
      future_standard_field: { retained: true },
      choices: [{
        delta: {
          reasoning_content: '分析天气请求',
          future_delta_field: 'retained',
        },
      }],
    })
  })

  it('reads only string reasoning_content values', () => {
    expect(getDeepSeekReasoningContent({ reasoning_content: '分析天气请求' }))
      .toBe('分析天气请求')
    expect(getDeepSeekReasoningContent({ reasoning_content: null })).toBe('')
    expect(getDeepSeekReasoningContent({ content: '最终回答' })).toBe('')
  })

  it('maps stream requests and preserves empty reasoning on assistant messages', async () => {
    async function* sourceStream() {
      yield createChunk({ reasoning_content: '先思考' } as ChatCompletionChunk.Choice.Delta)
      yield createChunk({ content: '答案' }, 'stop')
    }

    const create = vi.fn().mockResolvedValue(sourceStream())
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    }, createMockClient(create))

    const stream = await adapter.stream({
      messages: [
        { role: 'system', content: '系统指令' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '',
          tool_calls: [{
            id: 'call-weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"杭州"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-weather', content: '晴' },
      ],
      tools: [{
        name: 'get_weather',
        description: '查询天气',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
      reasoningEffort: 'high',
    })
    const chunks = []
    for await (const chunk of stream)
      chunks.push(chunk)

    expect(chunks.map(chunk => chunk.choices[0]?.delta)).toEqual([
      expect.objectContaining({ reasoning_content: '先思考' }),
      expect.objectContaining({ content: '答案' }),
    ])

    const request = create.mock.calls[0][0]
    expect(request).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      tools: [{
        type: 'function',
        function: { name: 'get_weather', strict: true },
      }],
    })
    expect(request.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: '',
    })
    expect(Object.hasOwn(request.messages[1], 'reasoning_content')).toBe(true)
  })

  it('normalizes non-streaming content, tool calls, reasoning and usage', () => {
    const response = {
      id: 'completion-2',
      future_standard_field: { retained: true },
      choices: [{
        future_choice_field: 'retained',
        finish_reason: 'tool_calls',
        index: 0,
        logprobs: null,
        message: {
          role: 'assistant',
          content: '',
          future_message_field: 'retained',
          reasoning_content: '需要查询天气',
          refusal: null,
          tool_calls: [{
            id: 'call-weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"杭州"}' },
          }],
        },
      }],
      created: 1_788_748_800,
      model: 'deepseek-v4-flash',
      object: 'chat.completion',
      usage: {
        completion_tokens: 8,
        prompt_tokens: 12,
        total_tokens: 20,
      },
    } as unknown as ChatCompletion

    expect(normalizeDeepSeekCompletion(response)).toMatchObject({
      provider: 'deepseek',
      future_standard_field: { retained: true },
      choices: [{
        finish_reason: 'tool_calls',
        future_choice_field: 'retained',
        message: {
          future_message_field: 'retained',
          reasoning_content: '需要查询天气',
          tool_calls: [{
            id: 'call-weather',
            function: { name: 'get_weather' },
          }],
        },
      }],
      usage: {
        completion_tokens: 8,
        prompt_tokens: 12,
        total_tokens: 20,
      },
    })
  })

  it('passes a provider-defined reasoning effort through without a library enum', async () => {
    const response = {
      id: 'completion-3',
      choices: [{
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
        message: { role: 'assistant', content: '回答', refusal: null },
      }],
      created: 1_788_748_800,
      model: 'deepseek-v4-flash',
      object: 'chat.completion',
    } as unknown as ChatCompletion
    const create = vi.fn().mockResolvedValue(response)
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    }, createMockClient(create))

    // 等级集合由 DeepSeek 维护并会新增；库必须原样透传，让供应商成为权威。
    await adapter.complete({
      messages: [{ role: 'user', content: '测试未知等级' }],
      reasoningEffort: 'future-level',
    })

    expect(create.mock.calls[0][0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'future-level',
    })
  })

  it('maps the reserved off level to a disabled DeepSeek thinking switch', async () => {
    const response = {
      id: 'completion-4',
      choices: [{
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
        message: { role: 'assistant', content: '回答', refusal: null },
      }],
      created: 1_788_748_800,
      model: 'deepseek-v4-flash',
      object: 'chat.completion',
    } as unknown as ChatCompletion
    const create = vi.fn().mockResolvedValue(response)
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    }, createMockClient(create))

    await adapter.complete({
      messages: [{ role: 'user', content: '不要思考' }],
      reasoningEffort: 'off',
    })

    // 关闭语义只通过 thinking 表达，并且不能同时下发等级。
    const sent = create.mock.calls[0][0]
    expect(sent).toMatchObject({ thinking: { type: 'disabled' } })
    expect(sent).not.toHaveProperty('reasoning_effort')
  })

  it('omits every reasoning field when no effort is requested', async () => {
    const response = {
      id: 'completion-5',
      choices: [{
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
        message: { role: 'assistant', content: '回答', refusal: null },
      }],
      created: 1_788_748_800,
      model: 'deepseek-v4-flash',
      object: 'chat.completion',
    } as unknown as ChatCompletion
    const create = vi.fn().mockResolvedValue(response)
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    }, createMockClient(create))

    // 省略表示不覆盖：由供应商或模型自身默认值决定，库不替它表态。
    await adapter.complete({
      messages: [{ role: 'user', content: '使用默认设置' }],
    })

    const sent = create.mock.calls[0][0]
    expect(sent).not.toHaveProperty('thinking')
    expect(sent).not.toHaveProperty('reasoning_effort')
  })

  it('requires an explicit model name instead of a built-in default', () => {
    expect(() => new DeepSeekModelAdapter({
      apiKey: 'test-key',
    } as unknown as DeepSeekModelAdapterConfig)).toThrow('DeepSeek model 不能为空')

    expect(() => new DeepSeekModelAdapter({
      apiKey: 'test-key',
      model: '   ',
    })).toThrow('DeepSeek model 不能为空')
  })

  it('classifies unknown failures without retrying inside the adapter', () => {
    const error = normalizeDeepSeekError(new Error('socket closed'))

    expect(error).toMatchObject({
      code: 'MODEL_CALL_FAILED',
      provider: 'deepseek',
      retryable: false,
    })
  })
})
