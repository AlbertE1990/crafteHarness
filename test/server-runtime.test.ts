// @vitest-environment node

import type { ModelStreamChunk } from '../src/craft-agent'
import type { AgentStreamEvent } from '../src/server/app'
import { describe, expect, it } from 'vitest'
import Agent from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'
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
})
