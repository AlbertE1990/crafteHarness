import type { AgentEvent, ModelAdapter, ModelStreamChunk, SessionStore } from '../src/craft-agent'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AgentLoop,
  createAgentTool,
  defineTool,
  deriveModelMessages,
  MemorySessionStore,
  readSessionSnapshot,
  SessionStoreError,
} from '../src/craft-agent'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

/** 构造只包含候选 0 的标准流块，让测试关注 Agent 控制流而不是供应商 SDK。 */
function chunk(
  delta: ModelStreamChunk['choices'][number]['delta'],
  finishReason: ModelStreamChunk['choices'][number]['finish_reason'] = null,
  usage?: ModelStreamChunk['usage'],
): ModelStreamChunk {
  return {
    id: 'completion-test',
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion.chunk',
    provider: 'scripted',
    ...(usage === undefined ? {} : { usage }),
  }
}

/** 创建确定性的内存 Store，事件 ID 不参与测试业务断言。 */
function createStore(): MemorySessionStore {
  let event = 0
  return new MemorySessionStore({
    createEventId: () => `event-${++event}`,
    now: () => new Date('2026-09-08T02:00:00.000Z'),
  })
}

describe('agent loop', () => {
  it('creates a Session, streams a final answer and commits the completed Turn', async () => {
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'stream',
        chunks: [
          chunk({ reasoning_content: '先分析' }),
          chunk({ content: '最终回答' }, 'stop', {
            completion_tokens: 4,
            prompt_tokens: 6,
            total_tokens: 10,
          }),
        ],
      }],
    })
    const events: AgentEvent[] = []
    let eventId = 0
    const loop = new AgentLoop({
      model: adapter,
      store,
      systemPrompt: '你是测试助手',
      createId: kind => kind === 'event' ? `event-${++eventId}` : `${kind}-1`,
    })

    const result = await loop.run({
      sessionId: 'session-final',
      input: ' 你好 ',
      sessionMetadata: { owner: 'test' },
    }, { onEvent: event => events.push(event) })

    expect(result).toEqual({
      status: 'completed',
      stopReason: 'completed',
      runId: 'run-1',
      turnId: 'turn-1',
      sessionId: 'session-final',
      content: '最终回答',
      reasoning: '先分析',
      steps: 1,
      toolCalls: 0,
      usage: {
        completion_tokens: 4,
        prompt_tokens: 6,
        total_tokens: 10,
      },
      sessionVersion: 6,
    })
    expect(adapter.calls[0]?.request.messages).toEqual([
      { role: 'system', content: '你是测试助手' },
      { role: 'user', content: '你好' },
    ])
    expect(adapter.calls[0]?.request).not.toHaveProperty('tools')
    expect(events.map(event => event.type)).toEqual([
      'agent.run.started',
      'agent.turn.started',
      'agent.step.started',
      'agent.model.chunk',
      'agent.model.chunk',
      'agent.step.completed',
      'agent.run.completed',
    ])

    const snapshot = await readSessionSnapshot('session-final', store)
    expect(snapshot.events.map(event => event.type)).toEqual([
      'session.created',
      'message.appended',
      'turn.started',
      'message.appended',
      'message.appended',
      'turn.completed',
    ])
    expect(deriveModelMessages(snapshot.events).at(-1)).toEqual({
      role: 'assistant',
      content: '最终回答',
      reasoning_content: '先分析',
    })
  })

  it('assembles fragmented calls, executes the Tool Harness and reloads Session history', async () => {
    const execute = vi.fn((input: { text: string }) => ({ text: input.text.toUpperCase() }))
    const echo = createAgentTool(defineTool({
      name: 'echo',
      description: '把文本转换成大写',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.strictObject({ text: z.string() }),
      security: { risk: 'safe', idempotent: true },
      execute,
    }))
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [
            chunk({
              reasoning_content: '调用工具',
              tool_calls: [{
                index: 0,
                id: 'call-echo',
                type: 'function',
                function: { name: 'ec', arguments: '{"text":' },
              }],
            }),
            chunk({
              tool_calls: [{
                index: 0,
                type: 'function',
                function: { name: 'ho', arguments: '"hello"}' },
              }],
            }, 'tool_calls'),
          ],
        },
        {
          method: 'stream',
          chunks: [chunk({ reasoning_content: '整理结果', content: '工具返回 HELLO' }, 'stop')],
        },
      ],
    })
    const events: AgentEvent[] = []
    const loop = new AgentLoop({ model: adapter, store, tools: [echo] })

    const result = await loop.run(
      { sessionId: 'session-tool', input: '转成大写' },
      { runId: 'run-tool', turnId: 'turn-tool', onEvent: event => events.push(event) },
    )

    expect(result).toMatchObject({
      status: 'completed',
      content: '工具返回 HELLO',
      reasoning: '调用工具\n\n整理结果',
      steps: 2,
      toolCalls: 1,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(adapter.calls[0]?.request).toMatchObject({
      parallel_tool_calls: false,
      tools: [expect.objectContaining({ name: 'echo' })],
    })
    expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([
      {
        role: 'assistant',
        content: '',
        reasoning_content: '调用工具',
        tool_calls: [{
          id: 'call-echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-echo',
        content: '{"text":"HELLO"}',
      },
    ]))
    expect(events.some(event => event.type === 'agent.tool.event')).toBe(true)
    expect(events.find(event => event.type === 'agent.tool.call.completed')).toMatchObject({
      result: { ok: true, value: { text: 'HELLO' } },
    })
  })

  it('writes an unknown tool failure back to the model instead of crashing the Run', async () => {
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [chunk({
            tool_calls: [{
              index: 0,
              id: 'call-missing',
              type: 'function',
              function: { name: 'missing', arguments: '{}' },
            }],
          }, 'tool_calls')],
        },
        { method: 'stream', chunks: [chunk({ content: '已处理工具错误' }, 'stop')] },
      ],
    })
    const loop = new AgentLoop({ model: adapter, store })

    const result = await loop.run({ sessionId: 'session-missing', input: '调用工具' })

    expect(result.status).toBe('completed')
    expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([
      {
        role: 'tool',
        tool_call_id: 'call-missing',
        content: 'Error: 工具 missing 不存在',
      },
    ]))
  })

  it.each([
    {
      name: 'user rejection',
      policyDecision: { decision: 'ask' as const, reason: '写操作需要确认' },
      expectedMessage: '工具审批结果：rejected',
      expectedApprovalCalls: 1,
    },
    {
      name: 'automatic policy denial',
      policyDecision: { decision: 'deny' as const, reason: '受保护资源禁止删除' },
      expectedMessage: '受保护资源禁止删除',
      expectedApprovalCalls: 0,
    },
  ])('returns $name to the model and continues the Loop', async (scenario) => {
    const execute = vi.fn(() => ({ changed: true }))
    const mutatingTool = createAgentTool(defineTool({
      name: 'mutate_resource',
      description: '修改测试资源',
      inputSchema: z.strictObject({ resource: z.string() }),
      outputSchema: z.strictObject({ changed: z.boolean() }),
      security: { risk: 'write', idempotent: false },
      execute,
    }))
    const requestToolApproval = vi.fn(async () => 'rejected' as const)
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [chunk({
            tool_calls: [{
              index: 0,
              id: 'call-mutate',
              type: 'function',
              function: { name: 'mutate_resource', arguments: '{"resource":"protected/a"}' },
            }],
          }, 'tool_calls')],
        },
        { method: 'stream', chunks: [chunk({ content: '已根据权限结果调整回答' }, 'stop')] },
      ],
    })
    const loop = new AgentLoop({
      model: adapter,
      store: createStore(),
      tools: [mutatingTool],
      toolPolicy: { evaluate: () => scenario.policyDecision },
      requestToolApproval,
    })

    const result = await loop.run({ sessionId: `session-${scenario.name}`, input: '修改资源' })

    expect(result).toMatchObject({
      status: 'completed',
      content: '已根据权限结果调整回答',
      steps: 2,
      toolCalls: 1,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(requestToolApproval).toHaveBeenCalledTimes(scenario.expectedApprovalCalls)
    expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([{
      role: 'tool',
      tool_call_id: 'call-mutate',
      content: `Error: ${scenario.expectedMessage}`,
    }]))
  })

  it('stops before persisting or executing a tool batch that exceeds the call budget', async () => {
    const execute = vi.fn(() => 'never')
    const tool = createAgentTool(defineTool({
      name: 'noop',
      description: '测试预算',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute,
    }))
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'stream',
        chunks: [chunk({
          tool_calls: [0, 1].map(index => ({
            index,
            id: `call-${index}`,
            type: 'function' as const,
            function: { name: 'noop', arguments: '{}' },
          })),
        }, 'tool_calls')],
      }],
    })
    const loop = new AgentLoop({
      model: adapter,
      store,
      tools: [tool],
      limits: { maxToolCalls: 1 },
    })

    const result = await loop.run({ sessionId: 'session-tool-budget', input: '运行两次' })

    expect(result).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tool_calls',
      toolCalls: 0,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(deriveModelMessages((await readSessionSnapshot('session-tool-budget', store)).events))
      .toEqual([{ role: 'user', content: '运行两次' }])
  })

  it('stops after persisted tool results when the model Step budget is exhausted', async () => {
    const tool = createAgentTool(defineTool({
      name: 'noop',
      description: '返回完成',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute: () => 'done',
    }))
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'stream',
        chunks: [chunk({
          tool_calls: [{
            index: 0,
            id: 'call-noop',
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          }],
        }, 'tool_calls')],
      }],
    })
    const loop = new AgentLoop({
      model: adapter,
      store,
      tools: [tool],
      limits: { maxModelSteps: 1 },
    })

    const result = await loop.run({ sessionId: 'session-step-budget', input: '调用一次' })

    expect(result).toMatchObject({
      status: 'stopped',
      stopReason: 'max_model_steps',
      steps: 1,
      toolCalls: 1,
    })
    expect(deriveModelMessages((await readSessionSnapshot('session-step-budget', store)).events)
      .map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('uses reported usage as a total-token guard before starting the next Step', async () => {
    const tool = createAgentTool(defineTool({
      name: 'noop',
      description: '返回完成',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute: () => 'done',
    }))
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'stream',
        chunks: [chunk({
          tool_calls: [{
            index: 0,
            id: 'call-token',
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          }],
        }, 'tool_calls', {
          completion_tokens: 3,
          prompt_tokens: 7,
          total_tokens: 10,
        })],
      }],
    })
    const loop = new AgentLoop({
      model: adapter,
      store: createStore(),
      tools: [tool],
      limits: { maxTotalTokens: 10 },
    })

    const result = await loop.run({ sessionId: 'session-token-budget', input: '测试 token' })

    expect(result).toMatchObject({
      status: 'stopped',
      stopReason: 'max_total_tokens',
      steps: 1,
      usage: { total_tokens: 10 },
    })
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.request.max_completion_tokens).toBe(10)
  })

  it('records a pre-aborted Run as a cancelled Turn without calling the model', async () => {
    const controller = new AbortController()
    controller.abort('user left')
    const store = createStore()
    const adapter = new ScriptedModelAdapter({ script: [] })
    const loop = new AgentLoop({ model: adapter, store })

    const result = await loop.run(
      { sessionId: 'session-cancelled', input: '不会请求模型' },
      { signal: controller.signal },
    )

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'cancelled', steps: 0 })
    expect(adapter.calls).toHaveLength(0)
    expect((await readSessionSnapshot('session-cancelled', store)).events.at(-1)?.type)
      .toBe('turn.cancelled')
  })

  it('stops a cooperative model stream when the Run duration budget expires', async () => {
    const adapter: ModelAdapter = {
      provider: 'waiting',
      model: 'waiting-model',
      complete: async () => { throw new Error('complete should not be called') },
      async stream(_request, options = {}) {
        return (async function* () {
          if (!options.signal?.aborted) {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        })()
      },
    }
    const loop = new AgentLoop({
      model: adapter,
      store: createStore(),
      limits: { maxDurationMs: 5 },
    })

    const result = await loop.run({ sessionId: 'session-duration', input: '等待' })

    expect(result).toMatchObject({
      status: 'stopped',
      stopReason: 'max_duration',
      steps: 1,
    })
  })

  it('normalizes Adapter exceptions and records a failed Turn', async () => {
    const store = createStore()
    const adapter = new ScriptedModelAdapter({
      provider: 'broken-provider',
      script: [{ method: 'stream', error: new Error('upstream unavailable') }],
    })
    const loop = new AgentLoop({ model: adapter, store })

    const result = await loop.run({ sessionId: 'session-model-error', input: '请求模型' })

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'model_error',
      error: {
        code: 'MODEL_CALL_FAILED',
        message: 'upstream unavailable',
        details: { provider: 'broken-provider' },
      },
    })
    expect((await readSessionSnapshot('session-model-error', store)).events.at(-1))
      .toMatchObject({ type: 'turn.failed', error: { code: 'MODEL_CALL_FAILED' } })
  })

  it('fails deterministically when another writer changes the Session during a Run', async () => {
    const store = createStore()
    const adapter = new ScriptedModelAdapter({ script: [] })
    const loop = new AgentLoop({ model: adapter, store })
    let inserted = false

    const result = await loop.run(
      { sessionId: 'session-conflict', input: '触发冲突' },
      {
        onEvent: async (event) => {
          if (event.type !== 'agent.step.started' || inserted)
            return
          inserted = true
          await store.append({
            sessionId: event.sessionId,
            expectedVersion: 3,
            events: [{ type: 'message.appended', message: { role: 'system', content: '并发写入' } }],
          })
        },
      },
    )

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'session_error',
      error: { code: 'SESSION_VERSION_CONFLICT' },
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('classifies external persistence failures as session errors', async () => {
    const memory = createStore()
    let reads = 0
    const store: SessionStore = {
      append: request => memory.append(request),
      async read(sessionId, options) {
        reads += 1
        if (reads > 1) {
          throw new SessionStoreError({
            code: 'SESSION_OPERATION_FAILED',
            message: '数据库暂时不可用',
            sessionId,
            operation: 'read',
          })
        }
        return await memory.read(sessionId, options)
      },
    }
    const adapter = new ScriptedModelAdapter({ script: [] })
    const loop = new AgentLoop({ model: adapter, store })

    const result = await loop.run({ sessionId: 'session-storage-error', input: '触发存储错误' })

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'session_error',
      error: {
        code: 'SESSION_OPERATION_FAILED',
        details: { operation: 'read' },
      },
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('isolates Agent event observer failures', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [{ method: 'stream', chunks: [chunk({ content: 'ok' }, 'stop')] }],
    })
    const loop = new AgentLoop({ model: adapter, store: createStore() })

    const result = await loop.run(
      { sessionId: 'session-observer', input: '继续' },
      { onEvent: () => { throw new Error('observer unavailable') } },
    )

    expect(result).toMatchObject({ status: 'completed', content: 'ok' })
  })

  it('rejects duplicate tool names during construction', () => {
    const defined = defineTool({
      name: 'same',
      description: '重复工具',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute: () => 'ok',
    })
    const tool = createAgentTool(defined)

    expect(() => new AgentLoop({
      model: new ScriptedModelAdapter({ script: [] }),
      store: createStore(),
      tools: [tool, tool],
    })).toThrow('工具名称重复')
  })
})

/** 编译期确认自定义 Store 仍只需实现标准 SessionStore Port。 */
const _sessionStoreContract: SessionStore = createStore()
void _sessionStoreContract
