import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { ServerResponse } from 'node:http'
import type {
  Agent,
  AgentEvent,
  AgentOutputEvent,
  AgentSessionDetail,
  AgentSessionMessage,
  ModelMessage,
  SessionSummary,
} from '../craft-agent'
import type {
  ToolApprovalBroker,
  ToolApprovalStreamEvent,
  UserToolApprovalDecision,
} from './tool-approval-broker'
import { randomUUID } from 'node:crypto'
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
  = ToolApprovalStreamEvent
    | { readonly type: 'conversation', readonly conversationId: string }
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
    | {
      readonly type: 'tool.policy.denied'
      readonly callId: string
      readonly toolName: string
      readonly reason: string
    }

/** 创建 Fastify 应用时注入的 Runtime 和日志配置。 */
export interface CreateServerAppOptions {
  readonly agent: Agent
  /** 连接等待中的 ToolApprovalHandler 与前端确认接口；省略时 ask 会 fail-closed。 */
  readonly approvalBroker?: ToolApprovalBroker
  readonly logger?: FastifyServerOptions['logger']
}

/**
 * 创建当前前端使用的 Fastify 应用，但不监听端口。
 *
 * 进程启动与路由构建分离后，生产入口可以监听真实端口，测试则可使用 Fastify.inject 验证完整 HTTP/SSE 协议。
 */
export function createServerApp(options: CreateServerAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: options.logger ?? true })

  fastify.post<{
    Params: { approvalId: string }
    Body: { decision: UserToolApprovalDecision }
  }>('/api/tool-approvals/:approvalId', {
    schema: {
      body: {
        type: 'object',
        properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
        required: ['decision'],
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    if (!options.approvalBroker) {
      await reply.code(503)
      return {
        error: 'TOOL_APPROVAL_UNAVAILABLE',
        message: '当前服务未配置工具审批通道',
      }
    }

    const decided = options.approvalBroker.decide(
      request.params.approvalId,
      request.body.decision,
    )
    if (!decided) {
      await reply.code(404)
      return {
        error: 'TOOL_APPROVAL_NOT_FOUND',
        message: '审批不存在、已处理或已经超时',
      }
    }
    return { accepted: true }
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
    const runId = randomUUID()

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

    // 审批事件与聊天增量共用当前 SSE；Run 结束后必须删除临时路由关系。
    const stopObservingApprovals = options.approvalBroker?.observeRun(
      runId,
      event => writeSseEvent(reply.raw, event),
    )

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
        runId,
        signal: abortController.signal,
        onEvent: async (event) => {
          const projected = projectAgentEvent(event)
          if (projected)
            await writeSseEvent(reply.raw, projected)
        },
        onTrace: async (event) => {
          const denial = projectToolPolicyDenial(event)
          if (denial)
            await writeSseEvent(reply.raw, denial)
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
      stopObservingApprovals?.()
      if (!reply.raw.writableEnded)
        reply.raw.end()
    }
  })

  return fastify
}

/** 只把自动策略拒绝投影给页面；ask 的生命周期由带 approvalId 的 Broker 发送。 */
function projectToolPolicyDenial(
  event: AgentEvent,
): Extract<AgentStreamEvent, { type: 'tool.policy.denied' }> | undefined {
  if (event.type !== 'agent.tool.event'
    || event.event.type !== 'tool.policy.decided'
    || event.event.result.decision !== 'deny') {
    return undefined
  }

  return {
    type: 'tool.policy.denied',
    callId: event.event.callId,
    toolName: event.event.toolName,
    reason: event.event.result.reason,
  }
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
    displayHistory: createDisplayHistory(session.messages),
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

/**
 * 按 Turn 聚合所有模型 Step 的思考，并挂到该 Turn 的最终助手回复上。
 *
 * 带 Tool Call 的 assistant 仍不作为聊天气泡展示，但它的 reasoning_content 不能丢失；
 * 最终结果必须与实时 AgentRunResult.reasoning 的“Step 间空行分隔”语义一致。
 */
function createDisplayHistory(
  history: readonly AgentSessionMessage[],
): readonly DisplayMessage[] {
  const display: DisplayMessage[] = []
  const reasoningByTurn = new Map<string, string[]>()
  let uncorrelatedReasoning: string[] = []

  for (const item of history) {
    const message = item.message
    if (message.role === 'user') {
      display.push({ role: 'user', content: message.content })
      uncorrelatedReasoning = []
      continue
    }
    if (message.role !== 'assistant')
      continue

    const reasoning = typeof message.reasoning_content === 'string'
      && message.reasoning_content.trim()
      ? message.reasoning_content
      : undefined
    const reasoningParts = item.turnId
      ? getOrCreateReasoningParts(reasoningByTurn, item.turnId)
      : uncorrelatedReasoning
    if (reasoning)
      reasoningParts.push(reasoning)

    // 工具调用消息是中间 Step，只累积思考；最终文本由后续 assistant 消息展示。
    if (message.tool_calls?.length
      || typeof message.content !== 'string'
      || !message.content.trim()) {
      continue
    }

    const combinedReasoning = reasoningParts.join('\n\n')
    display.push({
      role: 'assistant',
      content: message.content,
      ...(combinedReasoning ? { reasoning_content: combinedReasoning } : {}),
    })
    if (item.turnId)
      reasoningByTurn.delete(item.turnId)
    else
      uncorrelatedReasoning = []
  }

  return Object.freeze(display)
}

/** 返回指定 Turn 的思考片段容器，不存在时创建一个。 */
function getOrCreateReasoningParts(
  reasoningByTurn: Map<string, string[]>,
  turnId: string,
): string[] {
  const existing = reasoningByTurn.get(turnId)
  if (existing)
    return existing
  const created: string[] = []
  reasoningByTurn.set(turnId, created)
  return created
}

/** 使用标准双换行帧写入一个 JSON SSE 事件。 */
async function writeSseEvent(
  response: ServerResponse,
  event: AgentStreamEvent,
): Promise<void> {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
