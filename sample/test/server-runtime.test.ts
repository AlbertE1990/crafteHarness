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
import { createServerApp } from '../src/server/app'

/**
 * 契约测试注入的部署模型信息。
 *
 * 真实 Runtime 由环境变量组装这份词表；测试只需要覆盖"前端候选来自 Server 而不是
 * 硬编码"这一契约，因此使用固定值。
 */
const MODEL_INFO: ServerModelInfo = {
  provider: 'scripted',
  model: 'scripted-model',
  reasoningEffort: null,
  reasoningEfforts: ['off', 'low', 'high', 'max'],
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
  it('serves the deployment model vocabulary so the UI never hardcodes it', async () => {
    const agent = new Agent({ model: new ScriptedModelAdapter({ script: [] }) })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const response = await app.inject({ method: 'GET', url: '/api/model' })

      // 前端下拉的候选来自部署配置：换模型或增删等级不需要改动前端代码。
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        data: {
          provider: 'scripted',
          model: 'scripted-model',
          reasoningEffort: null,
          reasoningEfforts: ['off', 'low', 'high', 'max'],
        },
      })
    }
    finally {
      await app.close()
    }
  })

  it('rejects blank input at the HTTP boundary instead of failing inside the Agent', async () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const agent = new Agent({ model: adapter })
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

      // 纯空白与 Agent 的 trim 校验等价：应当判为客户端 400，而不是落到 Agent 抛错变 500。
      expect(blankMessage.statusCode).toBe(400)
      expect(blankEffort.statusCode).toBe(400)
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
      model: adapter,
    })
    const app = createServerApp({ agent, model: MODEL_INFO, logger: false })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          message: '使用非流式请求',
          stream: false,
          reasoningEffort: 'future-level',
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
      expect(adapter.calls[0]).toMatchObject({
        method: 'complete',
        request: { reasoningEffort: 'future-level' },
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
      model: adapter,
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
      model: new ScriptedModelAdapter({ script: [] }),
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
      model: adapter,
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
      model: adapter,
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
      model: adapter,
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
