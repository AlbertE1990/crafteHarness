import type { AgentOutputEvent, ModelStreamChunk } from '../../src'
import { describe, expect, it } from 'vitest'
import Agent from '../../src'
import { ScriptedModelAdapter } from '../../test/support/scripted-model-adapter'
import { serverToolGuard, serverTools } from '../src/server/agent-tools'

const SCOPE_ID = 'scope-agent-model-adapter'

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
    adapter,
    model: { id: 'mock-model' },
    tools: {
      additional: serverTools,
      guard: serverToolGuard,
    },
    systemPrompt: '你是一个AI助手',
  })
}

/** 完整消费一次门面事件流，模拟 SSE/CLI 的标准读取方式。 */
async function collectEvents(
  stream: AsyncIterable<AgentOutputEvent>,
): Promise<AgentOutputEvent[]> {
  const events: AgentOutputEvent[] = []
  for await (const event of stream)
    events.push(event)
  return events
}

describe('agent runtime model adapter boundary', () => {
  it('projects standard chunks to frontend events and derives history from Session Log', async () => {
    const adapter = new ScriptedModelAdapter({
      provider: 'mock',
      script: [{
        method: 'stream',
        chunks: [
          chunk({ reasoning_content: '正在分析' }),
          chunk({ content: '最终回答' }, 'stop'),
        ],
      }],
    })
    const agent = createAgent(adapter)
    const events = await collectEvents(agent.stream({
      scopeId: SCOPE_ID,
      input: '你好',
      sessionId: 'adapter-test-conversation',
    }))

    expect(events.at(-1)?.type).toBe('message.completed')
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

    const page = await agent.listSessions({ scopeId: SCOPE_ID })
    const detail = await agent.getSession({ scopeId: SCOPE_ID, sessionId: 'adapter-test-conversation' })
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
    const events = await collectEvents(agent.stream({
      scopeId: SCOPE_ID,
      input: '现在几点',
      sessionId: 'fragmented-tool-call',
    }))

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

    await collectEvents(agent.stream({ scopeId: SCOPE_ID, input: '第一轮问题', sessionId: 'multi-turn' }))
    await collectEvents(agent.stream({ scopeId: SCOPE_ID, input: '第二轮问题', sessionId: 'multi-turn' }))

    expect(adapter.calls[1]?.request.messages).toEqual([
      { role: 'system', content: '你是一个AI助手' },
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮问题' },
    ])
    const page = await agent.listSessions({ scopeId: SCOPE_ID })
    expect(page.sessions).toHaveLength(1)
    const detail = await agent.getSession({ scopeId: SCOPE_ID, sessionId: 'multi-turn' })
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
    const events = await collectEvents(agent.stream({ scopeId: SCOPE_ID, input: '执行自定义工具' }))
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'MODEL_PROTOCOL_ERROR',
      stopReason: 'model_protocol_error',
    })
  })
})
