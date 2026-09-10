// @vitest-environment node

import type { AgentConfigInput, ModelStreamChunk } from '../src/craft-agent'
import type { ServerStreamEvent } from '../src/server/app'
import { describe, expect, it } from 'vitest'
import Agent, { MemorySessionStore } from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'
import {
  manageRuntimeResourceTool,
  serverToolGuard,
} from '../src/server/agent-tools'
import { createServerApp } from '../src/server/app'

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

/** 为一次 Agent 测试生成唯一关联 ID，并固定预期 approvalId。 */
function createIdFactory(
  approvalId: string,
): NonNullable<AgentConfigInput['createId']> {
  let eventId = 0
  return (kind) => {
    if (kind === 'approval')
      return approvalId
    if (kind === 'event')
      return `event-${++eventId}`
    return `${kind}-http`
  }
}

/** Fastify.inject 在 SSE 完成后才返回，因此轮询独立 POST，直到 Agent 已建立 pending approval。 */
async function submitApprovalWhenReady(
  baseUrl: string,
  approvalId: string,
  decision: 'allow' | 'deny',
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/tool-approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    if (response.status === 200)
      return response
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`审批 ${approvalId} 未进入等待状态`)
}

describe('server runtime HTTP boundary', () => {
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
      createSessionId: () => 'http-session',
      now: () => new Date('2026-09-08T09:00:00.000Z'),
    })
    const app = createServerApp({ agent, logger: false })

    try {
      const chat = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '通过 HTTP 调用 Agent' },
      })

      expect(chat.statusCode).toBe(200)
      expect(chat.headers['content-type']).toContain('text/event-stream')
      expect(parseSse(chat.body)).toEqual([
        { type: 'session.started', sessionId: 'http-session' },
        {
          type: 'message.delta',
          sessionId: 'http-session',
          channel: 'reasoning',
          delta: 'HTTP 思考',
        },
        {
          type: 'message.delta',
          sessionId: 'http-session',
          channel: 'content',
          delta: 'HTTP 回答',
        },
        {
          type: 'message.completed',
          sessionId: 'http-session',
          content: 'HTTP 回答',
          reasoning: 'HTTP 思考',
        },
      ])

      const list = await app.inject({ method: 'GET', url: '/api/conversation/list' })
      expect(list.statusCode).toBe(200)
      expect(list.json()).toMatchObject({
        data: [{
          id: 'http-session',
          name: '通过 HTTP 调用 Agent',
          createAt: '2026-09-08T09:00:00.000Z',
        }],
      })
      expect(list.json().data[0]).not.toHaveProperty('history')

      const detail = await app.inject({
        method: 'GET',
        url: '/api/conversation/http-session',
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json()).toMatchObject({
        data: {
          id: 'http-session',
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
      sessionId: 'multi-step-reasoning',
      expectedVersion: 0,
      events: [
        { type: 'session.created', metadata: { name: '多步思考' } },
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
      store,
    })
    const app = createServerApp({ agent, logger: false })

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
      createSessionId: () => 'approval-session',
      createId: createIdFactory('approval-http'),
      now: () => new Date('2026-09-10T02:00:00.000Z'),
      tools: { mode: 'replace', tools: [manageRuntimeResourceTool] },
      toolGuard: serverToolGuard,
    })
    const app = createServerApp({ agent, logger: false })

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '写入演示资源' }),
      })
      const approval = await submitApprovalWhenReady(baseUrl, 'approval-http', 'allow')
      const chatBody = await chat.text()
      // Agent 才是一次性语义的事实边界；HTTP 路由只把 accepted=false 投影为 404。
      const duplicateApproval = agent.resolveToolApproval({
        approvalId: 'approval-http',
        decision: 'allow',
      })

      expect(approval.status).toBe(200)
      expect(duplicateApproval).toEqual({
        accepted: false,
        reason: 'not-found-or-settled',
      })
      expect(parseSse(chatBody)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.requested',
          sessionId: 'approval-session',
          runId: 'run-http',
          approvalId: 'approval-http',
          toolName: 'manage_runtime_resource',
          approvalTimeoutMs: 45_000,
          expiresAt: '2026-09-10T02:00:45.000Z',
        }),
        expect.objectContaining({
          type: 'tool.approval.resolved',
          sessionId: 'approval-session',
          runId: 'run-http',
          approvalId: 'approval-http',
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
      createSessionId: () => 'rejection-session',
      createId: createIdFactory('approval-reject'),
      tools: { mode: 'replace', tools: [manageRuntimeResourceTool] },
      toolGuard: serverToolGuard,
    })
    const app = createServerApp({ agent, logger: false })

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '写入后由我拒绝' }),
      })
      const rejection = await submitApprovalWhenReady(baseUrl, 'approval-reject', 'deny')
      const chatBody = await chat.text()

      expect(rejection.status).toBe(200)
      expect(parseSse(chatBody)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.resolved',
          sessionId: 'rejection-session',
          runId: 'run-http',
          approvalId: 'approval-reject',
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
      createSessionId: () => 'denial-session',
      tools: { mode: 'replace', tools: [manageRuntimeResourceTool] },
      toolGuard: serverToolGuard,
    })
    const app = createServerApp({ agent, logger: false })

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
          sessionId: 'denial-session',
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
