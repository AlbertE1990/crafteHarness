// @vitest-environment node

import type {
  ModelCompletion,
  ModelStreamChunk,
} from '../../src'
import type { ServerModelInfo, ServerStreamEvent } from '../src/server/app'
import { describe, expect, it } from 'vitest'
import Agent, { MemorySessionStore } from '../../src'
import { ScriptedModelAdapter } from '../../test/support/scripted-model-adapter'
import {
  manageRuntimeResourceTool,
  serverToolGuard,
} from '../src/server/agent-tools'
import { createServerApp as createRuntimeServerApp, SCOPE_ID_HEADER } from '../src/server/app'

/**
 * 契约测试注入的部署模型目录。
 *
 * 真实 Runtime 从 `sample/config/models.json`（或环境变量回退）读取这份词表；测试只需要
 * 覆盖"候选由部署提供、前端不硬编码、请求按选中模型校验"这几条契约，因此使用固定值。
 */
const MODEL_INFO: ServerModelInfo = {
  provider: 'scripted',
  defaultModel: 'scripted-model',
  models: [{
    id: 'scripted-model',
    label: 'Scripted Model',
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
  }],
}

/** 既有边界测试聚焦各自协议；显式 fallback 让它们不必重复声明同一个测试 scope。 */
function createServerApp(options: Parameters<typeof createRuntimeServerApp>[0]) {
  return createRuntimeServerApp({ ...options, fallbackScopeId: 'default' })
}

/** 构造 Server Runtime 契约测试使用的标准模型 chunk。 */
function chunk(
  delta: ModelStreamChunk['choices'][number]['delta'],
  finishReason: ModelStreamChunk['choices'][number]['finish_reason'] = null,
): ModelStreamChunk {
  return {
    id: 'server-runtime-completion',
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion.chunk',
  }
}

/** 构造 HTTP 非流式契约测试使用的完整模型结果。 */
function completion(content: string, reasoning = ''): ModelCompletion {
  return {
    id: 'server-runtime-non-stream',
    choices: [{
      finish_reason: 'stop',
      index: 0,
      logprobs: null,
      message: {
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
    }],
    created: 1_788_748_800,
    model: 'scripted-model',
    object: 'chat.completion',
  }
}

/** 解析 Server 默认直出的 CraftAgent 标准 JSON SSE 帧。 */
function parseSse(body: string): ServerStreamEvent[] {
  return body
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      return JSON.parse(data) as ServerStreamEvent
    })
}

type ApprovalRequestedEvent = Extract<
  ServerStreamEvent,
  { readonly type: 'tool.approval.requested' }
>

/** 从真实 SSE 中读取 Agent 生成的审批 ID，再提交一次用户决定。 */
async function resolveStreamApproval(
  chat: Response,
  baseUrl: string,
  decision: 'allow' | 'deny',
): Promise<{
  readonly approval: Response
  readonly approvalId: string
  readonly body: string
  readonly requested: ApprovalRequestedEvent
}> {
  if (!chat.body)
    throw new Error('聊天响应缺少 SSE body')
  const [inspectionStream, bodyStream] = chat.body.tee()
  const bodyPromise = new Response(bodyStream).text()
  const requested = await readApprovalRequest(inspectionStream)
  const approval = await fetch(
    `${baseUrl}/api/tool-approvals/${requested.approvalId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  )
  return {
    approval,
    approvalId: requested.approvalId,
    body: await bodyPromise,
    requested,
  }
}

/** 增量解析 SSE，直到观察到工具审批请求。 */
async function readApprovalRequest(
  stream: ReadableStream<Uint8Array>,
): Promise<ApprovalRequestedEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let boundary = buffer.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + separator.length)
      const event = parseSse(frame)[0]
      if (event?.type === 'tool.approval.requested') {
        void reader.cancel()
        return event
      }
      boundary = buffer.search(/\r?\n\r?\n/)
    }
    if (done)
      throw new Error('SSE 在工具审批请求出现前结束')
  }
}

describe('server runtime HTTP boundary', () => {
  it('requires a valid scope header on private endpoints in production mode', async () => {
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
    })
    const app = createRuntimeServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const missing = await app.inject({ method: 'GET', url: '/api/conversation/list' })
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/conversation/list',
        headers: { [SCOPE_ID_HEADER]: '../not-safe' },
      })
      const publicModel = await app.inject({ method: 'GET', url: '/api/model' })

      expect(missing.statusCode).toBe(400)
      expect(missing.json().error).toBe('SCOPE_ID_REQUIRED')
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error).toBe('INVALID_SCOPE_ID')
      expect(publicModel.statusCode).toBe(200)
    }
    finally {
      await app.close()
    }
  })

  it('serves the deployment model vocabulary so the UI never hardcodes it', async () => {
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const response = await app.inject({ method: 'GET', url: '/api/model' })

      // 前端下拉的候选来自部署目录：换模型或增删等级不需要改动前端代码，也不需要改 Adapter。
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        data: {
          provider: 'scripted',
          defaultModel: 'scripted-model',
          models: [{
            id: 'scripted-model',
            label: 'Scripted Model',
            reasoningEfforts: ['off', 'low', 'high', 'max'],
            defaultReasoningEffort: 'high',
          }],
        },
      })
    }
    finally {
      await app.close()
    }
  })

  it('renames and deletes conversations through the injected catalog port', async () => {
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
    })
    // 端口用内存实现即可：真正的 SQL 由 postgres-session-store.contract.ts 覆盖。
    const names = new Map([['session-known', '旧名称']])
    const app = createServerApp({
      agent,
      model: MODEL_INFO,
      logger: false,
      conversations: {
        rename: async (scopeId, sessionId, name) => {
          expect(scopeId).toBe('default')
          if (!names.has(sessionId))
            return undefined
          names.set(sessionId, name)
          return {
            scopeId: 'default',
            sessionId,
            sessionName: name,
            createdAt: '2026-09-11T00:00:00.000Z',
            version: 3,
          }
        },
        remove: async (scopeId, sessionId) => {
          expect(scopeId).toBe('default')
          return names.delete(sessionId)
        },
      },
    })

    try {
      const renamed = await app.inject({
        method: 'PATCH',
        url: '/api/conversation/session-known',
        payload: { name: '  新名称  ' },
      })
      expect(renamed.statusCode).toBe(200)
      // 名称前后空白在 HTTP 边界裁掉，返回与列表端点一致的摘要形状。
      expect(renamed.json().data).toMatchObject({ id: 'session-known', name: '新名称' })
      expect(names.get('session-known')).toBe('新名称')

      const missing = await app.inject({
        method: 'PATCH',
        url: '/api/conversation/session-missing',
        payload: { name: '新名称' },
      })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().error).toBe('SESSION_NOT_FOUND')

      // 纯空白名称不进入业务层：schema 直接判 400。
      const blank = await app.inject({
        method: 'PATCH',
        url: '/api/conversation/session-known',
        payload: { name: '   ' },
      })
      expect(blank.statusCode).toBe(400)

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/conversation/session-known',
      })
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json()).toEqual({ data: { id: 'session-known', deleted: true } })
      expect(names.has('session-known')).toBe(false)

      const deleteMissing = await app.inject({
        method: 'DELETE',
        url: '/api/conversation/session-known',
      })
      expect(deleteMissing.statusCode).toBe(404)
    }
    finally {
      await app.close()
    }
  })

  it('isolates conversation history by the browser scope header', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'complete', result: completion('甲的回答') },
        { method: 'complete', result: completion('乙的回答') },
      ],
    })
    const store = new MemorySessionStore()
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
      sessionStore: store,
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })
    const scopeA = 'browser-11111111-1111-4111-8111-111111111111'
    const scopeB = 'browser-22222222-2222-4222-8222-222222222222'

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: { [SCOPE_ID_HEADER]: scopeA },
        payload: { message: '甲的会话', stream: false },
      })
      const second = await app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: { [SCOPE_ID_HEADER]: scopeB },
        payload: { message: '乙的会话', stream: false },
      })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)

      const firstSessionId = first.json().data.sessionId as string
      const listA = await app.inject({
        method: 'GET',
        url: '/api/conversation/list',
        headers: { [SCOPE_ID_HEADER]: scopeA },
      })
      const listB = await app.inject({
        method: 'GET',
        url: '/api/conversation/list',
        headers: { [SCOPE_ID_HEADER]: scopeB },
      })
      expect(listA.json().data.map((item: { name: string }) => item.name)).toEqual(['甲的会话'])
      expect(listB.json().data.map((item: { name: string }) => item.name)).toEqual(['乙的会话'])

      const crossScopeRead = await app.inject({
        method: 'GET',
        url: `/api/conversation/${firstSessionId}`,
        headers: { [SCOPE_ID_HEADER]: scopeB },
      })
      expect(crossScopeRead.statusCode).toBe(404)
    }
    finally {
      await app.close()
    }
  })

  it('refuses conversation mutations when the runtime injects no catalog port', async () => {
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      // 缺少写能力时必须明确拒绝，而不是返回 200 让调用方以为改成功了。
      const renamed = await app.inject({
        method: 'PATCH',
        url: '/api/conversation/session-any',
        payload: { name: '新名称' },
      })
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/conversation/session-any',
      })

      expect(renamed.statusCode).toBe(501)
      expect(deleted.statusCode).toBe(501)
      expect(renamed.json().error).toBe('CONVERSATION_MUTATION_UNSUPPORTED')
    }
    finally {
      await app.close()
    }
  })

  it('selects the requested model on one reusable agent and adapter', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [{ method: 'complete', result: completion('其它模型回答') }],
    })
    const app = createServerApp({
      agent: new Agent({ adapter, model: { id: 'scripted-model' } }),
      model: {
        ...MODEL_INFO,
        models: [
          ...MODEL_INFO.models,
          {
            id: 'other-model',
            label: 'Other',
            reasoningEfforts: ['high'],
            defaultReasoningEffort: null,
          },
        ],
      },
      logger: false,
    })

    try {
      const switched = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '换模型', stream: false, model: 'other-model' },
      })
      expect(switched.statusCode).toBe(200)
      expect(switched.json().data.content).toBe('其它模型回答')
      expect(adapter.calls).toHaveLength(1)
      expect(adapter.calls[0]?.request.model).toBe('other-model')

      // 未声明的模型直接 400，不静默退回默认模型。
      const unsupported = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '换模型', stream: false, model: 'missing-model' },
      })
      expect(unsupported.statusCode).toBe(400)
      expect(unsupported.json().error).toBe('MODEL_NOT_SUPPORTED')
      expect(adapter.calls).toHaveLength(1)
    }
    finally {
      await app.close()
    }
  })

  it('validates the reasoning level against the selected model', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        { method: 'complete', result: completion('回答一') },
        { method: 'complete', result: completion('回答二') },
      ],
    })
    const app = createServerApp({
      agent: new Agent({ adapter, model: { id: 'scripted-model' } }),
      model: {
        ...MODEL_INFO,
        models: [
          ...MODEL_INFO.models,
          // 纯推理模型：不接受任何等级，因此请求里带等级会被拒绝。
          {
            id: 'reasoner-model',
            label: 'Reasoner',
            reasoningEfforts: [],
            defaultReasoningEffort: null,
          },
        ],
      },
      logger: false,
    })

    try {
      // 模型没声明的等级：在 HTTP 边界拒绝，并说明可用值。
      const wrongLevel = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '试试', stream: false, model: 'scripted-model', reasoningEffort: 'ultra' },
      })
      expect(wrongLevel.statusCode).toBe(400)
      expect(wrongLevel.json().error).toBe('REASONING_EFFORT_NOT_SUPPORTED')
      expect(wrongLevel.json().message).toContain('off, low, high, max')
      expect(adapter.calls).toHaveLength(0)

      // 不支持等级的模型：任何等级都被拒绝。
      const noLevels = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '试试', stream: false, model: 'reasoner-model', reasoningEffort: 'high' },
      })
      expect(noLevels.statusCode).toBe(400)
      expect(noLevels.json().message).toContain('不支持设置推理等级')
      expect(adapter.calls).toHaveLength(0)

      // 请求未指定等级时用该模型的默认值；默认值为 null 则不下发该参数。
      await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '默认等级', stream: false, model: 'scripted-model' },
      })
      expect(adapter.calls[0]?.request.reasoningEffort).toBe('high')

      await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '无默认等级', stream: false, model: 'reasoner-model' },
      })
      expect(adapter.calls[1]?.request).not.toHaveProperty('reasoningEffort')
    }
    finally {
      await app.close()
    }
  })

  it('answers the not-found path instead of awaiting the reply object', async () => {
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      // 回归保护：Fastify 的 Reply 是 thenable，`await reply.code(404)` 会等待一个
      // 还没发送的响应，导致该请求永久挂起（表现为测试超时而不是 404）。
      const missing = await app.inject({
        method: 'GET',
        url: '/api/conversation/session-does-not-exist',
      })

      expect(missing.statusCode).toBe(404)
      expect(missing.json().error).toBe('SESSION_NOT_FOUND')
    }
    finally {
      await app.close()
    }
  })

  it('rejects blank input at the HTTP boundary instead of failing inside the Agent', async () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const agent = new Agent({ adapter, model: { id: 'scripted-model' } })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const blankMessage = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '   ', stream: false },
      })
      const blankEffort = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '正常输入', stream: false, reasoningEffort: '   ' },
      })
      const legacySessionField = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '正常输入', stream: false, conversationId: 'legacy-id' },
      })

      // 纯空白与 Agent 的 trim 校验等价：应当判为客户端 400，而不是落到 Agent 抛错变 500。
      expect(blankMessage.statusCode).toBe(400)
      expect(blankEffort.statusCode).toBe(400)
      expect(legacySessionField.statusCode).toBe(400)
      expect(adapter.calls).toHaveLength(0)
    }
    finally {
      await app.close()
    }
  })

  it('returns ordinary JSON and never opens SSE when stream is false', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [{ method: 'complete', result: completion('JSON 回答', 'JSON 思考') }],
    })
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          message: '使用非流式请求',
          stream: false,
          reasoningEffort: 'max',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.headers['content-type']).not.toContain('text/event-stream')
      expect(response.json()).toMatchObject({
        data: {
          status: 'completed',
          sessionId: expect.stringMatching(/^session-[0-9a-f-]{36}$/),
          content: 'JSON 回答',
          reasoning: 'JSON 思考',
        },
      })
      // 请求里给出的等级原样进入模型请求；"库不校验等级"由 Adapter 契约测试守着。
      expect(adapter.calls[0]).toMatchObject({
        method: 'complete',
        request: { reasoningEffort: 'max' },
      })
    }
    finally {
      await app.close()
    }
  })

  it('serves AgentLoop output through the frontend SSE and conversation APIs', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'stream',
        chunks: [
          chunk({ reasoning_content: 'HTTP 思考' }),
          chunk({ content: 'HTTP 回答' }, 'stop'),
        ],
      }],
    })
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
      systemPrompt: '你是一个AI助手',
      execution: {
        now: () => new Date('2026-09-08T09:00:00.000Z'),
      },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const chat = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '通过 HTTP 调用 Agent' },
      })

      expect(chat.statusCode).toBe(200)
      expect(chat.headers['content-type']).toContain('text/event-stream')
      const events = parseSse(chat.body)
      // 首个事件必然是 session.started；显式收窄联合类型，而不是让断言退化成宽松类型。
      const firstEvent = events[0]
      if (firstEvent?.type !== 'session.started')
        throw new Error(`首个事件应为 session.started，实际为 ${String(firstEvent?.type)}`)
      const sessionId = firstEvent.sessionId
      expect(sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
      expect(events).toEqual([
        { type: 'session.started', sessionId },
        {
          type: 'message.delta',
          sessionId,
          channel: 'reasoning',
          delta: 'HTTP 思考',
        },
        {
          type: 'message.delta',
          sessionId,
          channel: 'content',
          delta: 'HTTP 回答',
        },
        {
          type: 'message.completed',
          sessionId,
          content: 'HTTP 回答',
          reasoning: 'HTTP 思考',
        },
      ])

      const list = await app.inject({ method: 'GET', url: '/api/conversation/list' })
      expect(list.statusCode).toBe(200)
      expect(list.json()).toMatchObject({
        data: [{
          id: sessionId,
          name: '通过 HTTP 调用 Agent',
          createAt: '2026-09-08T09:00:00.000Z',
        }],
      })
      expect(list.json().data[0]).not.toHaveProperty('history')

      const detail = await app.inject({
        method: 'GET',
        url: `/api/conversation/${sessionId}`,
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json()).toMatchObject({
        data: {
          id: sessionId,
          name: '通过 HTTP 调用 Agent',
          displayHistory: [
            { role: 'user', content: '通过 HTTP 调用 Agent' },
            {
              role: 'assistant',
              content: 'HTTP 回答',
              reasoning_content: 'HTTP 思考',
            },
          ],
        },
      })
    }
    finally {
      await app.close()
    }
  })

  it('aggregates every assistant reasoning step within its own turn', async () => {
    const store = new MemorySessionStore()
    await store.append({
      scopeId: 'default',
      sessionId: 'multi-step-reasoning',
      expectedVersion: 0,
      events: [
        { type: 'session.created', sessionName: '多步思考' },
        { type: 'turn.started', runId: 'run-1', turnId: 'turn-1' },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: { role: 'user', content: '第一轮问题' },
        },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: '第一步：决定调用工具',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            }],
          },
        },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
        },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: {
            role: 'assistant',
            content: '第一轮答案',
            reasoning_content: '第二步：整理工具结果',
          },
        },
        { type: 'turn.completed', runId: 'run-1', turnId: 'turn-1' },
        { type: 'turn.started', runId: 'run-2', turnId: 'turn-2' },
        {
          type: 'message.appended',
          runId: 'run-2',
          turnId: 'turn-2',
          message: { role: 'user', content: '第二轮问题' },
        },
        {
          type: 'message.appended',
          runId: 'run-2',
          turnId: 'turn-2',
          message: {
            role: 'assistant',
            content: '第二轮答案',
            reasoning_content: '第二轮思考',
          },
        },
        { type: 'turn.completed', runId: 'run-2', turnId: 'turn-2' },
      ],
    })
    const agent = new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
      sessionStore: store,
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const detail = await app.inject({
        method: 'GET',
        url: '/api/conversation/multi-step-reasoning',
      })

      expect(detail.statusCode).toBe(200)
      expect(detail.json().data.displayHistory).toEqual([
        { role: 'user', content: '第一轮问题' },
        {
          role: 'assistant',
          content: '第一轮答案',
          reasoning_content: '第一步：决定调用工具\n\n第二步：整理工具结果',
        },
        { role: 'user', content: '第二轮问题' },
        {
          role: 'assistant',
          content: '第二轮答案',
          reasoning_content: '第二轮思考',
        },
      ])
    }
    finally {
      await app.close()
    }
  })

  it('pauses an asked tool call until the approval endpoint allows it once', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [chunk({
            tool_calls: [{
              index: 0,
              id: 'call-approved-write',
              type: 'function',
              function: {
                name: 'manage_runtime_resource',
                arguments: '{"operation":"write","resource":"demo/http","content":"approved"}',
              },
            }],
          }, 'tool_calls')],
        },
        { method: 'stream', chunks: [chunk({ content: '资源已在用户同意后写入' }, 'stop')] },
      ],
    })
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
      execution: {
        now: () => new Date('2026-09-10T02:00:00.000Z'),
      },
      tools: {
        mode: 'replace',
        tools: [manageRuntimeResourceTool],
        guard: serverToolGuard,
        approvalTimeoutMs: 120_000,
      },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '写入演示资源' }),
      })
      const resolved = await resolveStreamApproval(chat, baseUrl, 'allow')
      // Agent 才是一次性语义的事实边界；HTTP 路由只把 accepted=false 投影为 404。
      const duplicateApproval = agent.resolveToolApproval({
        approvalId: resolved.approvalId,
        decision: 'allow',
      })

      expect(resolved.approval.status).toBe(200)
      expect(duplicateApproval).toEqual({
        accepted: false,
        reason: 'not-found-or-settled',
      })
      expect(resolved.requested).toMatchObject({
        type: 'tool.approval.requested',
        sessionId: expect.stringMatching(/^session-[0-9a-f-]{36}$/),
        runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
        approvalId: expect.stringMatching(/^approval-[0-9a-f-]{36}$/),
        toolName: 'manage_runtime_resource',
        approvalTimeoutMs: 45_000,
        expiresAt: '2026-09-10T02:00:45.000Z',
      })
      expect(parseSse(resolved.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.resolved',
          sessionId: resolved.requested.sessionId,
          runId: resolved.requested.runId,
          approvalId: resolved.approvalId,
          outcome: 'allowed',
        }),
        expect.objectContaining({
          type: 'message.completed',
          content: '资源已在用户同意后写入',
        }),
      ]))
      expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([{
        role: 'tool',
        tool_call_id: 'call-approved-write',
        content: expect.stringContaining('approved'),
      }]))
    }
    finally {
      await app.close()
    }
  })

  it('returns a user rejection to the model without executing the asked tool', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [chunk({
            tool_calls: [{
              index: 0,
              id: 'call-rejected-write',
              type: 'function',
              function: {
                name: 'manage_runtime_resource',
                arguments: '{"operation":"write","resource":"demo/rejected","content":"blocked"}',
              },
            }],
          }, 'tool_calls')],
        },
        { method: 'stream', chunks: [chunk({ content: '已尊重用户拒绝，不再写入' }, 'stop')] },
      ],
    })
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
      tools: {
        mode: 'replace',
        tools: [manageRuntimeResourceTool],
        guard: serverToolGuard,
      },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '写入后由我拒绝' }),
      })
      const resolved = await resolveStreamApproval(chat, baseUrl, 'deny')

      expect(resolved.approval.status).toBe(200)
      expect(parseSse(resolved.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.resolved',
          sessionId: resolved.requested.sessionId,
          runId: resolved.requested.runId,
          approvalId: resolved.approvalId,
          outcome: 'denied',
        }),
        expect.objectContaining({
          type: 'message.completed',
          content: '已尊重用户拒绝，不再写入',
        }),
      ]))
      expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([{
        role: 'tool',
        tool_call_id: 'call-rejected-write',
        content: 'Error: 工具审批结果：rejected',
      }]))
    }
    finally {
      await app.close()
    }
  })

  it('streams an automatic policy denial and lets the model produce a final answer', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          method: 'stream',
          chunks: [chunk({
            tool_calls: [{
              index: 0,
              id: 'call-denied-delete',
              type: 'function',
              function: {
                name: 'manage_runtime_resource',
                arguments: '{"operation":"delete","resource":"protected/system","content":null}',
              },
            }],
          }, 'tool_calls')],
        },
        { method: 'stream', chunks: [chunk({ content: '策略阻止了删除操作' }, 'stop')] },
      ],
    })
    const agent = new Agent({
      adapter,
      model: { id: 'scripted-model' },
      tools: {
        mode: 'replace',
        tools: [manageRuntimeResourceTool],
        guard: serverToolGuard,
      },
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const chat = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '删除受保护资源' },
      })
      const events = parseSse(chat.body)

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.guard.denied',
          sessionId: expect.stringMatching(/^session-[0-9a-f-]{36}$/),
          callId: 'call-denied-delete',
          toolName: 'manage_runtime_resource',
          reason: '受保护资源 protected/system 禁止删除',
        }),
        expect.objectContaining({
          type: 'message.completed',
          content: '策略阻止了删除操作',
        }),
      ]))
      expect(adapter.calls[1]?.request.messages).toEqual(expect.arrayContaining([{
        role: 'tool',
        tool_call_id: 'call-denied-delete',
        content: 'Error: 受保护资源 protected/system 禁止删除',
      }]))
    }
    finally {
      await app.close()
    }
  })
})
