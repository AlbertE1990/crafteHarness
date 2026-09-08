// @vitest-environment node

import type { AgentEvent, AgentOutputEvent, ModelStreamChunk } from '../src/craft-agent'
import { describe, expect, it } from 'vitest'
import Agent from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'

/** 构造门面测试使用的单候选标准流块。 */
function chunk(content: string): ModelStreamChunk {
  return {
    id: `chunk-${content}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      delta: { content },
    }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion.chunk',
  }
}

describe('agent facade', () => {
  it('creates session IDs, emits simplified output and preserves complete traces', async () => {
    const configuredTraces: AgentEvent[] = []
    const runTraces: AgentEvent[] = []
    const output: AgentOutputEvent[] = []
    const agent = new Agent({
      model: new ScriptedModelAdapter({
        script: [{ method: 'stream', chunks: [chunk('门面回答')] }],
      }),
      createSessionId: () => 'facade-session',
      onTrace: event => configuredTraces.push(event),
    })

    const result = await agent.run({ input: '使用统一入口' }, {
      onEvent: event => output.push(event),
      onTrace: event => runTraces.push(event),
    })

    expect(result).toMatchObject({
      status: 'completed',
      sessionId: 'facade-session',
      content: '门面回答',
    })
    expect(output).toEqual([
      { type: 'session.started', sessionId: 'facade-session' },
      {
        type: 'message.delta',
        sessionId: 'facade-session',
        channel: 'content',
        delta: '门面回答',
      },
      {
        type: 'message.completed',
        sessionId: 'facade-session',
        content: '门面回答',
        reasoning: '',
      },
    ])
    expect(configuredTraces.map(event => event.type)).toEqual(
      runTraces.map(event => event.type),
    )
    expect(runTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.run.started' }),
      expect.objectContaining({ type: 'agent.run.completed' }),
    ]))
  })

  it('lists and reads sessions without maintaining a second in-memory index', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'stream', chunks: [chunk('第一条回答')] },
        { method: 'stream', chunks: [chunk('第二条回答')] },
      ],
    })
    const agent = new Agent({ model: adapter })

    await agent.run({ sessionId: 'session-a', input: '第一条问题' })
    await agent.run({ sessionId: 'session-b', input: '第二条问题' })

    const firstPage = await agent.listSessions({ limit: 1 })
    const secondPage = await agent.listSessions({
      limit: 1,
      afterSessionId: firstPage.nextAfterSessionId,
    })
    const session = await agent.getSession('session-b')

    expect(firstPage).toMatchObject({
      hasMore: true,
      nextAfterSessionId: 'session-a',
      sessions: [{ sessionId: 'session-a' }],
    })
    expect(secondPage).toMatchObject({
      hasMore: false,
      sessions: [{ sessionId: 'session-b' }],
    })
    expect(session?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: '第二条回答',
    })
  })
})
