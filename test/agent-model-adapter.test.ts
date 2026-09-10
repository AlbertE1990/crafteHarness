import type { AgentOutputEvent, ModelStreamChunk } from '../src/craft-agent'
import { describe, expect, it } from 'vitest'
import Agent from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'
import { serverToolGuard, serverTools } from '../src/server/agent-tools'

/** 构造供应商无关模型流块，验证 Server 只消费 CraftAgent 标准协议。 */
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

/** 使用确定会话 ID 创建测试 Agent，避免测试依赖随机 UUID。 */
function createAgent(adapter: ScriptedModelAdapter): Agent {
  return new Agent({
    model: adapter,
    tools: {
      additional: serverTools,
    },
    toolGuard: serverToolGuard,
    systemPrompt: '你是一个AI助手',
    createSessionId: () => 'generated-conversation',
  })
}

describe('agent runtime model adapter boundary', () => {
  it('projects standard chunks to frontend events and derives history from Session Log', async () => {
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
    const agent = createAgent(adapter)
    const events: AgentOutputEvent[] = []

    const result = await agent.run({
      input: '你好',
      sessionId: 'adapter-test-conversation',
    }, { onEvent: event => events.push(event) })

    expect(result.status).toBe('completed')
    expect(adapter.calls[0]?.request.messages).toEqual([
      { role: 'system', content: '你是一个AI助手' },
      { role: 'user', content: '你好' },
    ])
    expect(adapter.calls[0]?.request.tools?.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
      'get_user_location',
      'get_weather',
      'manage_runtime_resource',
    ])
    expect(events).toContainEqual({
      type: 'message.delta',
      sessionId: 'adapter-test-conversation',
      channel: 'reasoning',
      delta: '正在分析',
    })
    expect(events.at(-1)).toEqual({
      type: 'message.completed',
      sessionId: 'adapter-test-conversation',
      content: '最终回答',
      reasoning: '正在分析',
    })

    const page = await agent.listSessions()
    const detail = await agent.getSession('adapter-test-conversation')
    expect(detail?.messages.at(-1)?.message).toEqual({
      role: 'assistant',
      content: '最终回答',
      reasoning_content: '正在分析',
    })
    expect(page.sessions[0]?.sessionId).toBe('adapter-test-conversation')
  })

  it('uses AgentLoop to assemble and execute fragmented tool calls', async () => {
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
                function: { name: 'get_current_', arguments: '{"time' },
              }],
            }),
            chunk({
              tool_calls: [{
                index: 0,
                type: 'function',
                function: {
                  name: 'time',
                  arguments: 'zone":"Asia/Shanghai"}',
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
    const agent = createAgent(adapter)
    const events: AgentOutputEvent[] = []

    const result = await agent.run({
      input: '现在几点',
      sessionId: 'fragmented-tool-call',
    }, { onEvent: event => events.push(event) })

    expect(result).toMatchObject({ status: 'completed', steps: 2, toolCalls: 1 })
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        reasoning_content: '需要查询时间',
        tool_calls: [{
          id: 'call-time',
          type: 'function',
          function: {
            name: 'get_current_time',
            arguments: '{"timezone":"Asia/Shanghai"}',
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

  it('reuses one SessionStore across requests and restores the complete next-turn context', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'stream', chunks: [chunk({ content: '第一轮回答' }, 'stop')] },
        { method: 'stream', chunks: [chunk({ content: '第二轮回答' }, 'stop')] },
      ],
    })
    const agent = createAgent(adapter)

    await agent.run({ input: '第一轮问题', sessionId: 'multi-turn' })
    await agent.run({ input: '第二轮问题', sessionId: 'multi-turn' })

    expect(adapter.calls[1]?.request.messages).toEqual([
      { role: 'system', content: '你是一个AI助手' },
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮问题' },
    ])
    const page = await agent.listSessions()
    expect(page.sessions).toHaveLength(1)
    const detail = await agent.getSession('multi-turn')
    expect(detail?.messages.map(item => item.message).filter(message => (
      message.role === 'user' || message.role === 'assistant'
    )).map(message => message.content)).toEqual([
      '第一轮问题',
      '第一轮回答',
      '第二轮问题',
      '第二轮回答',
    ])
  })

  it('projects AgentLoop protocol failures as frontend error events', async () => {
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
    const agent = createAgent(adapter)
    const events: AgentOutputEvent[] = []

    const result = await agent.run({ input: '执行自定义工具' }, {
      onEvent: event => events.push(event),
    })

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'model_protocol_error',
      error: { code: 'MODEL_PROTOCOL_ERROR' },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'MODEL_PROTOCOL_ERROR',
      stopReason: 'model_protocol_error',
    })
  })
})
