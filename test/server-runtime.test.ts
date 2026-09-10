// @vitest-environment node

import type { ModelStreamChunk } from '../src/craft-agent'
import type { AgentStreamEvent } from '../src/server/app'
import { describe, expect, it, vi } from 'vitest'
import Agent, { MemorySessionStore } from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'
import {
  manageRuntimeResourceTool,
  trustedServerToolPolicy,
} from '../src/server/agent-tools'
import { createServerApp } from '../src/server/app'
import { ToolApprovalBroker } from '../src/server/tool-approval-broker'

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

/** 解析当前前端使用的 JSON SSE 帧。 */
function parseSse(body: string): AgentStreamEvent[] {
  return body
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      return JSON.parse(data) as AgentStreamEvent
    })
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
        { type: 'conversation', conversationId: 'http-session' },
        { type: 'message.delta', channel: 'reasoning', delta: 'HTTP 思考' },
        { type: 'message.delta', channel: 'content', delta: 'HTTP 回答' },
        {
          type: 'message.completed',
          conversationId: 'http-session',
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
    const broker = new ToolApprovalBroker({ createApprovalId: () => 'approval-http' })
    const agent = new Agent({
      model: adapter,
      createSessionId: () => 'approval-session',
      tools: { mode: 'replace', tools: [manageRuntimeResourceTool] },
      toolPolicy: trustedServerToolPolicy,
      requestToolApproval: broker.requestApproval,
    })
    const app = createServerApp({ agent, approvalBroker: broker, logger: false })

    try {
      const chatPromise = app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '写入演示资源' },
      })
      await vi.waitFor(() => expect(broker.hasPending('approval-http')).toBe(true))

      const approval = await app.inject({
        method: 'POST',
        url: '/api/tool-approvals/approval-http',
        payload: { decision: 'approve' },
      })
      const chat = await chatPromise

      expect(approval.statusCode).toBe(200)
      expect(parseSse(chat.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.requested',
          approvalId: 'approval-http',
          toolName: 'manage_runtime_resource',
        }),
        expect.objectContaining({
          type: 'tool.approval.decided',
          approvalId: 'approval-http',
          outcome: 'allowed-once',
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
    const broker = new ToolApprovalBroker({ createApprovalId: () => 'approval-reject' })
    const agent = new Agent({
      model: adapter,
      createSessionId: () => 'rejection-session',
      tools: { mode: 'replace', tools: [manageRuntimeResourceTool] },
      toolPolicy: trustedServerToolPolicy,
      requestToolApproval: broker.requestApproval,
    })
    const app = createServerApp({ agent, approvalBroker: broker, logger: false })

    try {
      const chatPromise = app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: '写入后由我拒绝' },
      })
      await vi.waitFor(() => expect(broker.hasPending('approval-reject')).toBe(true))

      const rejection = await app.inject({
        method: 'POST',
        url: '/api/tool-approvals/approval-reject',
        payload: { decision: 'reject' },
      })
      const chat = await chatPromise

      expect(rejection.statusCode).toBe(200)
      expect(parseSse(chat.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.decided',
          approvalId: 'approval-reject',
          outcome: 'rejected',
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
      toolPolicy: trustedServerToolPolicy,
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
        {
          type: 'tool.policy.denied',
          callId: 'call-denied-delete',
          toolName: 'manage_runtime_resource',
          reason: '受保护资源 protected/system 禁止删除',
        },
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
