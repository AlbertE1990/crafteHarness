import type {
  ModelCompletion,
  ModelStreamChunk,
} from '../src/craft-agent'
import { describe, expect, it } from 'vitest'
import { assertModelAdapterContract } from './support/model-adapter-contract'
import {
  ScriptedModelAdapter,
} from './support/scripted-model-adapter'

function completion(): ModelCompletion {
  return {
    id: 'scripted-completion',
    choices: [{
      finish_reason: 'stop',
      index: 0,
      logprobs: null,
      message: { role: 'assistant', content: '固定回答' },
    }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion',
    provider: 'scripted',
  }
}

function chunk(): ModelStreamChunk {
  return {
    id: 'scripted-chunk',
    choices: [{
      delta: { content: '固定流' },
      finish_reason: 'stop',
      index: 0,
    }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion.chunk',
    provider: 'scripted',
  }
}

describe('model adapter testing utilities', () => {
  it('runs a reusable complete and stream contract probe without network access', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'complete', result: completion() },
        { method: 'stream', chunks: [chunk()] },
      ],
    })

    const result = await assertModelAdapterContract(adapter)

    expect(result.completion.choices[0]?.message.content).toBe('固定回答')
    expect(result.chunks).toHaveLength(1)
    expect(adapter.calls.map(call => call.method)).toEqual(['complete', 'stream'])
  })

  it('captures request snapshots and obeys cancellation', async () => {
    const controller = new AbortController()
    const adapter = new ScriptedModelAdapter({
      script: [{ method: 'stream', chunks: [chunk()] }],
    })
    const messages = [{ role: 'user' as const, content: '原始消息' }]
    const stream = await adapter.stream({ messages }, { signal: controller.signal })
    messages.push({ role: 'user', content: '后续消息' })
    controller.abort('test abort')

    await expect((async () => {
      for await (const _chunk of stream) {
        // ScriptedModelAdapter 在每个 chunk 前检查取消状态。
      }
    })()).rejects.toMatchObject({
      code: 'MODEL_ABORTED',
      provider: 'scripted',
    })
    expect(adapter.calls[0]?.request.messages).toEqual([
      { role: 'user', content: '原始消息' },
    ])
  })
})
