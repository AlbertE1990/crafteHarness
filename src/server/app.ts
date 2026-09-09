import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { ServerResponse } from 'node:http'
import type {
  Agent,
  AgentOutputEvent,
  AgentSessionDetail,
  ModelMessage,
  SessionSummary,
} from '../craft-agent'
import Fastify from 'fastify'

/** 前端会话列表需要的展示消息；工具和系统消息不会进入该投影。 */
export interface DisplayMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly reasoning_content?: string
}

/** 会话目录项只携带列表展示所需字段，避免为每项加载完整历史。 */
export interface ConversationSummary {
  readonly id: string
  readonly name: string
  readonly createAt: string
}

/** 用户进入一个会话后按需读取的完整页面投影。 */
export interface ConversationDetail extends ConversationSummary {
  readonly history: readonly ModelMessage[]
  readonly displayHistory: readonly DisplayMessage[]
}

/** 当前页面消费的 SSE 事件。 */
export type AgentStreamEvent
  = | { readonly type: 'conversation', readonly conversationId: string }
    | {
      readonly type: 'message.delta'
      readonly channel: 'reasoning' | 'content'
      readonly delta: string
    }
    | {
      readonly type: 'message.completed'
      readonly conversationId: string
      readonly content: string
      readonly reasoning: string
    }
    | {
      readonly type: 'error'
      readonly message: string
      readonly code?: string
      readonly stopReason?: string
    }

/** 创建 Fastify 应用时注入的 Runtime 和日志配置。 */
export interface CreateServerAppOptions {
  readonly agent: Agent
  readonly logger?: FastifyServerOptions['logger']
}

/**
 * 创建当前前端使用的 Fastify 应用，但不监听端口。
 *
 * 进程启动与路由构建分离后，生产入口可以监听真实端口，测试则可使用 Fastify.inject 验证完整 HTTP/SSE 协议。
 */
export function createServerApp(options: CreateServerAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: options.logger ?? true })

  fastify.get<{
    Querystring: { name?: string }
    Reply: { hello: string }
  }>('/api/hello', {
    schema: {
      querystring: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: { hello: { type: 'string' } },
          required: ['hello'],
          additionalProperties: false,
        },
      },
    },
  }, async (request) => {
    return { hello: request.query.name ?? 'world' }
  })

  fastify.post<{
    Body: { name?: string }
    Reply: { data: string }
  }>('/api/conversation', {
    schema: {
      body: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'string' } },
          required: ['data'],
          additionalProperties: false,
        },
      },
    },
  }, async () => {
    return { data: '' }
  })

  fastify.get('/api/conversation/list', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array' } },
          required: ['data'],
          additionalProperties: false,
        },
      },
    },
  }, async () => {
    const page = await options.agent.listSessions()
    return { data: page.sessions.map(createConversationSummary) }
  })

  fastify.get<{
    Params: { sessionId: string }
  }>('/api/conversation/:sessionId', async (request, reply) => {
    const session = await options.agent.getSession(request.params.sessionId)
    if (!session) {
      await reply.code(404)
      return {
        error: 'SESSION_NOT_FOUND',
        message: `会话 ${request.params.sessionId} 不存在`,
      }
    }

    return { data: createConversationDetail(session) }
  })

  fastify.post<{
    Body: {
      conversationId?: string
      message: string
    }
  }>('/api/chat', {
    schema: {
      body: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          message: { type: 'string', minLength: 1 },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const abortController = new AbortController()

    // 浏览器断开连接时取消同一个 Agent Run，模型和工具会收到组合后的 AbortSignal。
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished)
        abortController.abort()
    })

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders()

    try {
      await options.agent.run({
        input: request.body.message,
        ...(request.body.conversationId
          ? { sessionId: request.body.conversationId }
          : {}),
        ...(!request.body.conversationId
          ? {
              sessionMetadata: {
                source: 'server-runtime',
                name: createConversationTitle(request.body.message),
              },
            }
          : {}),
      }, {
        signal: abortController.signal,
        onEvent: async (event) => {
          const projected = projectAgentEvent(event)
          if (projected)
            await writeSseEvent(reply.raw, projected)
        },
      })
    }
    catch (error) {
      if (!abortController.signal.aborted) {
        await writeSseEvent(reply.raw, {
          type: 'error',
          message: error instanceof Error ? error.message : '流式响应失败',
        })
      }
    }
    finally {
      if (!reply.raw.writableEnded)
        reply.raw.end()
    }
  })

  return fastify
}

/** 将通用 CraftAgent 输出映射为现有页面字段。 */
function projectAgentEvent(event: AgentOutputEvent): AgentStreamEvent | undefined {
  if (event.type === 'session.started')
    return { type: 'conversation', conversationId: event.sessionId }
  if (event.type === 'message.delta') {
    return {
      type: event.type,
      channel: event.channel,
      delta: event.delta,
    }
  }
  if (event.type === 'message.completed') {
    return {
      type: event.type,
      conversationId: event.sessionId,
      content: event.content,
      reasoning: event.reasoning,
    }
  }
  return {
    type: 'error',
    message: event.message,
    code: event.code,
    stopReason: event.stopReason,
  }
}

/** 把最小 Session 摘要投影为会话目录项。 */
function createConversationSummary(session: SessionSummary): ConversationSummary {
  return Object.freeze({
    id: session.sessionId,
    name: getMetadataName(session) ?? '新对话',
    createAt: session.createdAt,
  })
}

/** 把带事件上下文的 Agent 详情转换为页面所需的消息数组。 */
function createConversationDetail(session: AgentSessionDetail): ConversationDetail {
  const history = Object.freeze(session.messages.map(item => item.message))
  return Object.freeze({
    ...createConversationSummary(session),
    history,
    displayHistory: createDisplayHistory(history),
  })
}

/** 读取创建 Session 时写入的可选标题。 */
function getMetadataName(session: SessionSummary): string | undefined {
  const name = session.metadata?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

/** 从第一条用户输入生成稳定短标题，不额外调用模型。 */
function createConversationTitle(message: string): string {
  return message.trim().slice(0, 40) || '新对话'
}

/** 过滤系统、工具和中间 Tool Call，只保留页面真正展示的消息。 */
function createDisplayHistory(history: readonly ModelMessage[]): readonly DisplayMessage[] {
  return Object.freeze(history.flatMap((message): DisplayMessage[] => {
    if (message.role === 'user')
      return [{ role: 'user', content: message.content }]
    if (message.role !== 'assistant'
      || message.tool_calls?.length
      || typeof message.content !== 'string'
      || !message.content.trim()) {
      return []
    }
    return [{
      role: 'assistant',
      content: message.content,
      ...(message.reasoning_content
        ? { reasoning_content: message.reasoning_content }
        : {}),
    }]
  }))
}

/** 使用标准双换行帧写入一个 JSON SSE 事件。 */
async function writeSseEvent(
  response: ServerResponse,
  event: AgentStreamEvent,
): Promise<void> {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
