import type { ModelStreamChunk } from '../src/common-agent'
import { describe, expect, it } from 'vitest'
import { ScriptedModelAdapter } from '../src/common-agent/adapters/testing'
import { Agent, getConversations } from '../src/server/agent'
import { AgentConfig } from '../src/server/agent-config'

function chunk(
  delta: ModelStreamChunk['choices'][number]['delta'],
  finishReason: ModelStreamChunk['choices'][number]['finish_reason'] = null,
): ModelStreamChunk {
  return {
    id: 'test-completion',
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1_788_748_800,
    model: 'mock-model',
    object: 'chat.completion.chunk',
    provider: 'mock',
  }
}

describe('agent model adapter boundary', () => {
  it('consumes only standard chunks and preserves reasoning in stored history', async () => {
    const adapter = new ScriptedModelAdapter({
      provider: 'mock',
      model: 'mock-model',
      script: [{
        method: 'stream',
        chunks: [
          chunk({ reasoning_content: '正在分析' }),
          chunk({ content: '最终回答' }, 'stop'),
        ],
      }],
    })
    const config = new AgentConfig({
      model: { provider: 'custom', adapter },
    })
    const agent = new Agent(config)

    const events = []
    for await (const event of agent.chatStream('你好', 'adapter-test-conversation'))
      events.push(event)

    expect(adapter.calls[0]?.request.messages).toEqual([
      { role: 'system', content: '你是一个AI助手' },
      { role: 'user', content: '你好' },
    ])
    expect(adapter.calls[0]?.request.tools).toHaveLength(3)
    expect(events).toContainEqual({
      type: 'message.delta',
      channel: 'reasoning',
      delta: '正在分析',
    })
    expect(events.at(-1)).toMatchObject({
      type: 'message.completed',
      content: '最终回答',
      reasoning: '正在分析',
    })
    expect(getConversations()
      .find(item => item.id === 'adapter-test-conversation')
      ?.history
      .at(-1))
      .toEqual({
        role: 'assistant',
        content: '最终回答',
        reasoning_content: '正在分析',
      })
  })

  it('assembles fragmented tool calls before invoking the Harness', async () => {
    const adapter = new ScriptedModelAdapter({
      provider: 'mock',
      model: 'mock-model',
      script: [
        {
          method: 'stream',
          chunks: [
            chunk({
              reasoning_content: '需要查询时间',
              tool_calls: [{
                index: 0,
                id: 'call-time',
                type: 'function',
                function: { name: 'get_', arguments: '{"amount":0,' },
              }],
            }),
            chunk({
              tool_calls: [{
                index: 0,
                type: 'function',
                function: {
                  name: 'time',
                  arguments: '"unit":"day","preset":null,"timezone":"Asia/Shanghai"}',
                },
              }],
            }, 'tool_calls'),
          ],
        },
        {
          method: 'stream',
          chunks: [chunk({ content: '现在时间已查询' }, 'stop')],
        },
      ],
    })
    const config = new AgentConfig({
      model: { provider: 'custom', adapter },
    })
    const agent = new Agent(config)

    const events = []
    for await (const event of agent.chatStream('现在几点', 'fragmented-tool-call'))
      events.push(event)

    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        reasoning_content: '需要查询时间',
        tool_calls: [{
          id: 'call-time',
          type: 'function',
          function: {
            name: 'get_time',
            arguments: '{"amount":0,"unit":"day","preset":null,"timezone":"Asia/Shanghai"}',
          },
        }],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-time',
      }),
    ]))
    expect(events.at(-1)).toMatchObject({
      type: 'message.completed',
      content: '现在时间已查询',
    })
  })

  it('reports unsupported custom tool chunks as model protocol errors', async () => {
    const adapter = new ScriptedModelAdapter({
      provider: 'mock',
      model: 'mock-model',
      script: [{
        method: 'stream',
        chunks: [chunk({
          tool_calls: [{
            index: 0,
            id: 'custom-call',
            type: 'custom',
            custom: { name: 'shell', input: 'pwd' },
          }],
        }, 'tool_calls')],
      }],
    })
    const config = new AgentConfig({
      model: { provider: 'custom', adapter },
    })
    const agent = new Agent(config)

    await expect((async () => {
      for await (const _event of agent.chatStream('执行自定义工具')) {
        // 消费生成器才能观察流迭代期间抛出的协议错误。
      }
    })()).rejects.toMatchObject({
      code: 'MODEL_PROTOCOL_ERROR',
      provider: 'mock',
    })
  })
})
