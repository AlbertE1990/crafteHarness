import process from 'node:process'
import Fastify from 'fastify'
import { Agent, getConversations } from './agent'

const PORT = Number(process.env.PORT ?? 3000)

const fastify = Fastify({ logger: true })

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
        properties: {
          data: { type: 'array' },
        },
        required: ['data'],
        additionalProperties: false,
      },
    },
  },
}, async () => {
  // 当前列表直接携带历史消息，前端切换会话时无需再次请求详情接口。
  return { data: getConversations() }
})

/** 通过 POST 接收用户消息，并以 SSE 返回会话 ID、分频道消息增量和完成事件。 */
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
  const agent = new Agent()
  const abortController = new AbortController()

  // 浏览器断开连接时同步取消上游模型请求，避免继续消耗 token 和连接资源。
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished)
      abortController.abort()
  })

  // SSE 需要直接控制响应流；hijack 可绕过 Fastify 的 JSON 序列化和自动结束响应。
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  try {
    for await (const event of agent.chatStream(
      request.body.message,
      request.body.conversationId,
      abortController.signal,
    )) {
      // 每个 SSE 事件必须用一个空行结尾；事件内容统一使用 JSON，便于前端校验类型。
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }
  catch (error) {
    if (!abortController.signal.aborted) {
      const message = error instanceof Error ? error.message : '流式响应失败'
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)
    }
  }
  finally {
    if (!reply.raw.writableEnded)
      reply.raw.end()
  }
})

/** 启动本地 HTTP 服务；启动失败会由运行时记录为未处理异常并终止进程。 */
async function start() {
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
}

start()
