// @vitest-environment node

import type {
  AgentEvent,
  AgentOutputEvent,
  ModelStreamChunk,
  SessionStore,
} from '../src/craft-agent'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import Agent, { defineTool, MemorySessionStore } from '../src/craft-agent'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

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
      session: {
        createSessionId: () => 'facade-session',
      },
      observability: {
        onTrace: event => configuredTraces.push(event),
      },
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

    const read = vi.spyOn(agent.store, 'read')
    const firstPage = await agent.listSessions({ limit: 1 })
    const secondPage = await agent.listSessions({
      limit: 1,
      afterSessionId: firstPage.nextAfterSessionId,
    })

    // 目录查询只读取摘要，不能退化成每个会话一次完整 read() 的 N+1 查询。
    expect(read).not.toHaveBeenCalled()
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
    expect(session?.messages.at(-1)).toMatchObject({
      sessionId: 'session-b',
      turnId: expect.any(String),
      sequence: expect.any(Number),
      timestamp: expect.any(String),
      message: {
        role: 'assistant',
        content: '第二条回答',
      },
    })
  })

  it('requires the explicit SessionCatalogStore capability only when listing sessions', async () => {
    const memory = new MemorySessionStore()
    const executionStore: SessionStore = {
      append: request => memory.append(request),
      read: (sessionId, options) => memory.read(sessionId, options),
    }
    const agent = new Agent({
      model: new ScriptedModelAdapter({ script: [] }),
      session: { store: executionStore },
    })

    await expect(agent.listSessions()).rejects.toThrow(
      '当前 SessionStore 未实现 list() 会话目录能力',
    )
  })

  it('owns approval waiting and lets the application resolve it through the Agent instance', async () => {
    const tool = defineTool({
      name: 'write_demo',
      description: '写入演示数据',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ saved: z.boolean() }),
      security: { risk: 'write', idempotent: false },
      execute: () => ({ saved: true }),
    })
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [{
            id: 'chunk-tool-call',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-write',
                  type: 'function',
                  function: { name: 'write_demo', arguments: '{"value":"hello"}' },
                }],
              },
            }],
            created: 1_788_748_800,
            model: 'scripted-model',
            object: 'chat.completion.chunk',
          }],
        },
        { method: 'stream', chunks: [chunk('审批后完成')] },
      ],
    })
    let eventId = 0
    const agent = new Agent({
      model: adapter,
      tools: { mode: 'replace', tools: [tool] },
      toolGuard: {
        approvalTimeoutMs: 120_000,
        evaluate: () => ({
          decision: 'ask',
          reason: '需要写入数据',
          // 单次 -1 覆盖通用 120 秒，Agent 不创建过期定时器。
          approvalTimeoutMs: -1,
        }),
      },
      execution: {
        createId: kind => kind === 'event' ? `event-${++eventId}` : `${kind}-facade`,
        now: () => new Date('2026-09-10T02:00:00.000Z'),
      },
    })
    const output: AgentOutputEvent[] = []

    const result = await agent.run({ sessionId: 'approval-facade', input: '写入' }, {
      onEvent(event) {
        output.push(event)
        if (event.type === 'tool.approval.requested') {
          expect(agent.resolveToolApproval({
            approvalId: event.approvalId,
            decision: 'allow',
          })).toEqual({ accepted: true })
        }
      },
    })

    expect(result).toMatchObject({ status: 'completed', content: '审批后完成' })
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool.approval.requested',
        approvalId: 'approval-facade',
        approvalTimeoutMs: -1,
        expiresAt: null,
      }),
      expect.objectContaining({
        type: 'tool.approval.resolved',
        outcome: 'allowed',
      }),
    ]))
    expect(agent.resolveToolApproval({
      approvalId: 'approval-facade',
      decision: 'deny',
    })).toEqual({ accepted: false, reason: 'not-found-or-settled' })
  })
})
