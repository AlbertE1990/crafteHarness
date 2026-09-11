import type OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeOpenAICompatibleCompletion,
  OpenAICompatibleModelAdapter,
} from '../src/craft-agent/adapters/openai-compatible'

function createMockClient(create: ReturnType<typeof vi.fn>): OpenAI {
  return {
    chat: { completions: { create } },
  } as unknown as OpenAI
}

function createCompletion(): ChatCompletion {
  return {
    id: 'completion-compatible',
    choices: [{
      finish_reason: 'stop',
      index: 0,
      logprobs: null,
      message: { role: 'assistant', content: '兼容响应', refusal: null },
    }],
    created: 1_788_748_800,
    model: 'compatible-model',
    object: 'chat.completion',
    usage: {
      completion_tokens: 2,
      prompt_tokens: 3,
      total_tokens: 5,
    },
  }
}

function createChunk(): ChatCompletionChunk {
  return {
    id: 'chunk-compatible',
    choices: [{
      delta: { content: '兼容流' },
      finish_reason: 'stop',
      index: 0,
    }],
    created: 1_788_748_800,
    model: 'compatible-model',
    object: 'chat.completion.chunk',
    usage: null,
  }
}

describe('openAI compatible model adapter', () => {
  it('maps standard messages, tools and request controls without provider branches', async () => {
    async function* sourceStream() {
      yield createChunk()
    }

    const create = vi.fn().mockResolvedValue(sourceStream())
    const adapter = new OpenAICompatibleModelAdapter({
      provider: 'compatible-cloud',
      apiKey: 'test-key',
      baseURL: 'https://example.com/v1',
      model: 'compatible-model',
    }, createMockClient(create))

    const stream = await adapter.stream({
      messages: [
        { role: 'developer', content: '开发者指令' },
        { role: 'user', content: '你好' },
      ],
      tools: [{
        name: 'lookup',
        description: '查询数据',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
      max_completion_tokens: 128,
      reasoningEffort: 'future-level',
      parallel_tool_calls: false,
      tool_choice: 'auto',
    })
    const chunks = []
    for await (const chunk of stream)
      chunks.push(chunk)

    expect(chunks[0]).toMatchObject({
      provider: 'compatible-cloud',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: '兼容流' } }],
    })
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'compatible-model',
      messages: [
        { role: 'developer', content: '开发者指令' },
        { role: 'user', content: '你好' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'lookup', strict: true },
      }],
      max_completion_tokens: 128,
      reasoning_effort: 'future-level',
      parallel_tool_calls: false,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('preserves compatible response extensions while adding provider identity', () => {
    const source = {
      ...createCompletion(),
      future_standard_field: { retained: true },
    } as unknown as ChatCompletion

    expect(normalizeOpenAICompatibleCompletion(source, 'compatible-cloud'))
      .toMatchObject({
        provider: 'compatible-cloud',
        future_standard_field: { retained: true },
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5,
        },
      })
  })

  it('normalizes errors raised while consuming the provider stream', async () => {
    async function* failingStream() {
      yield createChunk()
      throw new Error('socket closed during stream')
    }

    const adapter = new OpenAICompatibleModelAdapter({
      provider: 'compatible-cloud',
      apiKey: 'test-key',
      model: 'compatible-model',
    }, createMockClient(vi.fn().mockResolvedValue(failingStream())))
    const stream = await adapter.stream({
      messages: [{ role: 'user', content: '你好' }],
    })

    await expect((async () => {
      for await (const _chunk of stream) {
        // 完整消费，才能观察供应商流在迭代期间抛出的错误。
      }
    })()).rejects.toMatchObject({
      code: 'MODEL_CALL_FAILED',
      provider: 'compatible-cloud',
      retryable: false,
    })
  })
})
