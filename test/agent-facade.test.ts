// @vitest-environment node

import type {
  AgentEvent,
  AgentOutputEvent,
  ModelCompletion,
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

/** 构造门面非流式测试使用的完整响应。 */
function completion(content: string): ModelCompletion {
  return {
    id: `completion-${content}`,
    choices: [{
      finish_reason: 'stop',
      index: 0,
      logprobs: null,
      message: { role: 'assistant', content },
    }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion',
  }
}

/** 完整消费一次 Agent 标准事件流。 */
async function collectEvents(
  stream: AsyncIterable<AgentOutputEvent>,
): Promise<AgentOutputEvent[]> {
  const events: AgentOutputEvent[] = []
  for await (const event of stream)
    events.push(event)
  return events
}

describe('agent facade', () => {
  it('lets the method choose streaming and the request override flat model defaults', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'complete', result: completion('默认非流式') },
        { method: 'stream', chunks: [chunk('单次改为流式')] },
      ],
    })
    const agent = new Agent({
      model: adapter,
      execution: {
        model: {
          reasoningEnabled: true,
          reasoningEffort: 'high',
        },
      },
    })

    await agent.invoke({ sessionId: 'facade-default-model', input: '默认设置' })
    await collectEvents(agent.stream({
      sessionId: 'facade-run-model',
      input: '覆盖设置',
      model: { reasoningEffort: 'max' },
    }))

    expect(adapter.calls.map(call => ({
      method: call.method,
      reasoning: call.request.reasoning,
    }))).toEqual([
      { method: 'complete', reasoning: { enabled: true, effort: 'high' } },
      { method: 'stream', reasoning: { enabled: true, effort: 'max' } },
    ])
  })

  it('creates session IDs, emits simplified output and preserves complete traces', async () => {
    const configuredTraces: AgentEvent[] = []
    const agent = new Agent({
      model: new ScriptedModelAdapter({
        script: [{ method: 'stream', chunks: [chunk('门面回答')] }],
      }),
      observability: {
        onTrace: event => configuredTraces.push(event),
      },
    })

    const output = await collectEvents(agent.stream({ input: '使用统一入口' }))
    const sessionId = output[0]?.sessionId
    expect(sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(output).toEqual([
      { type: 'session.started', sessionId },
      {
        type: 'message.delta',
        sessionId,
        channel: 'content',
        delta: '门面回答',
      },
      {
        type: 'message.completed',
        sessionId,
        content: '门面回答',
        reasoning: '',
      },
    ])
    expect(configuredTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.run.started' }),
      expect.objectContaining({ type: 'agent.run.completed' }),
    ]))
  })

  it('accepts AbortSignal directly and cancels when a stream consumer stops', async () => {
    const invokeAgent = new Agent({
      model: new ScriptedModelAdapter({ script: [] }),
    })
    const controller = new AbortController()
    controller.abort('caller-cancelled')

    const invoke = invokeAgent.invoke({ input: '取消完整调用' }, controller.signal)
    await expect(invoke).resolves.toMatchObject({
      status: 'stopped',
      stopReason: 'cancelled',
    })

    const streamAdapter = new ScriptedModelAdapter({ script: [] })
    const streamAgent = new Agent({ model: streamAdapter })
    const stream = streamAgent.stream({ input: '停止读取事件' })
    expect(streamAdapter.calls).toHaveLength(0)

    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.type).toBe('session.started')
    await iterator.return?.()
    expect(streamAdapter.calls).toHaveLength(0)
  })

  it('lists and reads sessions without maintaining a second in-memory index', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'stream', chunks: [chunk('第一条回答')] },
        { method: 'stream', chunks: [chunk('第二条回答')] },
      ],
    })
    const agent = new Agent({ model: adapter })

    await collectEvents(agent.stream({ sessionId: 'session-a', input: '第一条问题' }))
    await collectEvents(agent.stream({ sessionId: 'session-b', input: '第二条问题' }))

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
      sessionStore: executionStore,
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
    const agent = new Agent({
      model: adapter,
      tools: {
        mode: 'replace',
        tools: [tool],
        approvalTimeoutMs: 120_000,
        guard: () => ({
          decision: 'ask',
          reason: '需要写入数据',
          // 单次 -1 覆盖通用 120 秒，Agent 不创建过期定时器。
          approvalTimeoutMs: -1,
        }),
      },
      execution: {
        now: () => new Date('2026-09-10T02:00:00.000Z'),
      },
    })
    const output: AgentOutputEvent[] = []
    let approvalId: string | undefined

    for await (const event of agent.stream({
      sessionId: 'approval-facade',
      input: '写入',
    })) {
      output.push(event)
      if (event.type === 'tool.approval.requested') {
        approvalId = event.approvalId
        expect(agent.resolveToolApproval({
          approvalId: event.approvalId,
          decision: 'allow',
        })).toEqual({ accepted: true })
      }
    }

    expect(output.at(-1)).toMatchObject({
      type: 'message.completed',
      content: '审批后完成',
    })
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool.approval.requested',
        approvalId: expect.stringMatching(/^approval-[0-9a-f-]{36}$/),
        approvalTimeoutMs: -1,
        expiresAt: null,
      }),
      expect.objectContaining({
        type: 'tool.approval.resolved',
        outcome: 'allowed',
      }),
    ]))
    expect(approvalId).toBeDefined()
    expect(agent.resolveToolApproval({
      approvalId: approvalId!,
      decision: 'deny',
    })).toEqual({ accepted: false, reason: 'not-found-or-settled' })
  })

  it('passes one trusted context and request object through both Guards and tool execution', async () => {
    interface AppContext {
      readonly tenantId: string
      readonly user: { readonly id: string }
      readonly environment: 'test'
    }
    const inputSchema = z.strictObject({ key: z.string() })
    const outputSchema = z.strictObject({ owner: z.string() })
    let localGuardRequest: unknown
    let globalGuardRequest: unknown
    const executedContexts: AppContext[] = []
    const tool = defineTool<typeof inputSchema, typeof outputSchema, AppContext>({
      name: 'read_tenant_record',
      description: '读取当前租户的数据',
      inputSchema,
      outputSchema,
      metadata: { domain: 'tenant-records' },
      guard(request) {
        localGuardRequest = request
        return { decision: 'allow' }
      },
      execute(_input, context) {
        executedContexts.push(context.context)
        return { owner: context.context.user.id }
      },
    })
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [{
            id: 'chunk-context-tool',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-context-tool',
                  type: 'function',
                  function: { name: tool.name, arguments: '{"key":"record-1"}' },
                }],
              },
            }],
            created: 1_788_748_800,
            model: 'scripted-model',
            object: 'chat.completion.chunk',
          }],
        },
        { method: 'stream', chunks: [chunk('上下文调用完成')] },
      ],
    })
    const agent = new Agent<AppContext>({
      model: adapter,
      tools: {
        mode: 'replace',
        tools: [tool],
        guard(request) {
          globalGuardRequest = request
          return request.context.tenantId === 'tenant-a'
            ? { decision: 'allow' }
            : { decision: 'deny', reason: '租户不匹配' }
        },
      },
    })
    const context: AppContext = {
      tenantId: 'tenant-a',
      user: { id: 'user-1' },
      environment: 'test',
    }

    const events = await collectEvents(agent.stream({
      sessionId: 'context-facade',
      input: '读取记录',
      context,
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'message.completed',
      content: '上下文调用完成',
    })
    expect(globalGuardRequest).toBe(localGuardRequest)
    expect(globalGuardRequest).toMatchObject({ context })
    expect((globalGuardRequest as { context: AppContext }).context).toBe(context)
    expect(executedContexts).toHaveLength(1)
    expect(executedContexts[0]).toBe(context)
  })
})
