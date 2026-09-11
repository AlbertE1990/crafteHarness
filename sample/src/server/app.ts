import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { ServerResponse } from 'node:http'
import type {
  Agent,
  AgentOutputEvent,
  AgentRunResult,
  AgentSessionDetail,
  AgentSessionMessage,
  ModelMessage,
  SessionSummary,
} from '../../../src'
import Fastify from 'fastify'
import { z } from 'zod'

/** 当前参考 Runtime 是单用户部署，仍显式组装固定 Session 作用域。 */
const SINGLE_USER_SCOPE_ID = 'default'

/** 会话名称长度上限；只在 HTTP 边界约束，存储层只要求非空。 */
const MAX_CONVERSATION_NAME_LENGTH = 80

const approvalBodySchema = z.strictObject({
  decision: z.enum(['allow', 'deny']),
})

const modelResponseSchema = z.strictObject({
  data: z.strictObject({
    provider: z.string(),
    defaultModel: z.string(),
    models: z.array(z.strictObject({
      id: z.string(),
      label: z.string(),
      reasoningEfforts: z.array(z.string()),
      defaultReasoningEffort: z.string().nullable(),
    })),
  }),
})

const conversationListResponseSchema = z.strictObject({
  data: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    createAt: z.string(),
  })),
})

const conversationNameBodySchema = z.strictObject({
  name: z.string().min(1).max(MAX_CONVERSATION_NAME_LENGTH).regex(/\S/),
})

const chatBodySchema = z.strictObject({
  sessionId: z.string().optional(),
  message: z.string().min(1).regex(/\S/),
  stream: z.boolean().optional(),
  reasoningEffort: z.string().min(1).regex(/\S/).optional(),
  model: z.string().min(1).regex(/\S/).optional(),
})

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

/** Server 自身在 Agent 外部失败时使用的传输错误，不伪装成 AgentOutputEvent。 */
export interface ServerStreamErrorEvent {
  readonly type: 'server.error'
  readonly message: string
}

/** 默认 SSE 直接输出 CraftAgent 标准事件；仅额外保留 Server 自身的传输错误。 */
export type ServerStreamEvent
  = AgentOutputEvent | ServerStreamErrorEvent

/** 非流式聊天直接返回一次封闭的 Agent Run 结果，不使用 SSE 包装。 */
export interface ServerChatJsonResponse {
  readonly data: AgentRunResult
}

/**
 * 一个模型及其推理能力。
 *
 * `reasoningEfforts` 是该模型允许的等级；空数组表示这个模型没有推理控制（例如纯推理模型），
 * 前端据此隐藏等级控件，请求里也不应带 `reasoningEffort`。等级集合由部署声明，
 * Adapter 不做校验——它只把开放值翻译成供应商字段。
 */
export interface ServerModelCapability {
  readonly id: string
  /** 展示名称；缺省时等于 id。 */
  readonly label: string
  /** 该模型允许的推理等级；`[]` 表示不允许在请求里表达推理等级。 */
  readonly reasoningEfforts: readonly string[]
  /** 请求未指定等级时采用的默认值；null 表示不下发该参数，由供应商决定。 */
  readonly defaultReasoningEffort: string | null
}

/**
 * 当前部署的模型能力目录；由 Runtime 从配置文件（或环境变量回退）组装。
 *
 * 供应商会不断新增模型和推理等级，因此这份词表属于部署而不是库或前端：前端只渲染
 * 这里给出的候选，换模型或增删等级不需要改动前端代码，也不需要改 Adapter。
 */
export interface ServerModelInfo {
  readonly provider: string
  /** 默认模型 id；必须在 models 中。 */
  readonly defaultModel: string
  readonly models: readonly ServerModelCapability[]
}

/**
 * 会话目录的可变操作；由 Runtime 注入。
 *
 * 库的 `SessionStore` 契约只有 append/read/list，刻意不提供重命名与删除：
 * 名称是可变的展示投影，删除则会移除已记录的事实。把这两件事留在 Runtime，
 * 是为了让这个取舍停在应用层，而不是改变库的 append-only 协议。
 */
export interface ConversationCatalogMutations {
  /**
   * 重命名会话，成功返回更新后的摘要，会话不存在返回 undefined。
   *
   * 返回摘要而不是布尔值，是为了让处理器不必再读一次会话就能回出与列表端点一致的形状：
   * 「改名成功、随后读不到」若回 404，会把一次成功操作报成失败。
   */
  rename: (sessionId: string, name: string) => Promise<SessionSummary | undefined>
  remove: (sessionId: string) => Promise<boolean>
}

/** 创建 Fastify 应用时注入的 Runtime 和日志配置。 */
export interface CreateServerAppOptions {
  readonly agent: Agent
  /** 前端用来渲染模型与推理等级候选的部署信息。 */
  readonly model: ServerModelInfo
  /**
   * 按模型名取对应 Agent；省略时所有请求都用 `agent`。
   *
   * 库把模型名绑定在 Adapter 实例上（不是每次请求的参数），因此多模型部署由 Runtime
   * 持有多个 Agent 实例并在这里分发，而不是把模型名塞进 AgentRequest。
   */
  readonly resolveAgent?: (model: string) => Agent | undefined
  /** 未注入时，重命名与删除接口返回 501，而不是静默无效。 */
  readonly conversations?: ConversationCatalogMutations
  readonly logger?: FastifyServerOptions['logger']
}

/**
 * 创建当前前端使用的 Fastify 应用，但不监听端口。
 *
 * 进程启动与路由构建分离后，生产入口可以监听真实端口，测试则可使用 Fastify.inject 验证完整 HTTP/SSE 协议。
 */
export function createServerApp(options: CreateServerAppOptions): FastifyInstance {
  const fastify = Fastify({
    logger: options.logger ?? true,
    // Zod strictObject 投影出的 additionalProperties:false 必须拒绝未知字段，不能被 Ajv 静默移除。
    ajv: { customOptions: { removeAdditional: false } },
  })

  fastify.post<{
    Params: { approvalId: string }
    Body: z.output<typeof approvalBodySchema>
  }>('/api/tool-approvals/:approvalId', {
    schema: {
      body: toFastifySchema(approvalBodySchema, 'input'),
    },
  }, async (request, reply) => {
    // Server 只转换 HTTP 数据；一次性校验和 pending Promise 都由 Agent 内部管理。
    const result = options.agent.resolveToolApproval({
      approvalId: request.params.approvalId,
      decision: request.body.decision,
    })
    if (!result.accepted) {
      // 同一个 approvalId 只能使用一次；已处理、超时和未知 ID 统一视为不存在。
      reply.code(404)
      return {
        error: 'TOOL_APPROVAL_NOT_FOUND',
        message: '审批不存在、已处理或已经超时',
      }
    }
    return result
  })

  // 前端从这里获得模型与其推理能力，避免把供应商词表写死在页面里。
  fastify.get('/api/model', {
    schema: {
      response: {
        200: toFastifySchema(modelResponseSchema, 'output'),
      },
    },
  }, async () => ({ data: options.model }))

  fastify.get('/api/conversation/list', {
    schema: {
      response: {
        200: toFastifySchema(conversationListResponseSchema, 'output'),
      },
    },
  }, async () => {
    const page = await options.agent.listSessions({ scopeId: SINGLE_USER_SCOPE_ID })
    return { data: page.sessions.map(createConversationSummary) }
  })

  fastify.get<{
    Params: { sessionId: string }
  }>('/api/conversation/:sessionId', async (request, reply) => {
    const session = await options.agent.getSession({
      scopeId: SINGLE_USER_SCOPE_ID,
      sessionId: request.params.sessionId,
    })
    if (!session) {
      reply.code(404)
      return {
        error: 'SESSION_NOT_FOUND',
        message: `会话 ${request.params.sessionId} 不存在`,
      }
    }

    return { data: createConversationDetail(session) }
  })

  fastify.patch<{
    Params: { sessionId: string }
    Body: z.output<typeof conversationNameBodySchema>
  }>('/api/conversation/:sessionId', {
    schema: {
      body: toFastifySchema(conversationNameBodySchema, 'input'),
    },
  }, async (request, reply) => {
    if (!options.conversations) {
      reply.code(501)
      return {
        error: 'CONVERSATION_MUTATION_UNSUPPORTED',
        message: '当前 Runtime 未注入会话目录写能力',
      }
    }

    const name = request.body.name.trim()
    const renamed = await options.conversations.rename(request.params.sessionId, name)
    if (!renamed) {
      reply.code(404)
      return {
        error: 'SESSION_NOT_FOUND',
        message: `会话 ${request.params.sessionId} 不存在`,
      }
    }

    // 名称以目录为权威；端口已返回更新后的摘要，不必再读一次会话。
    return { data: createConversationSummary(renamed) }
  })

  fastify.delete<{
    Params: { sessionId: string }
  }>('/api/conversation/:sessionId', async (request, reply) => {
    if (!options.conversations) {
      reply.code(501)
      return {
        error: 'CONVERSATION_MUTATION_UNSUPPORTED',
        message: '当前 Runtime 未注入会话目录写能力',
      }
    }

    const removed = await options.conversations.remove(request.params.sessionId)
    if (!removed) {
      reply.code(404)
      return {
        error: 'SESSION_NOT_FOUND',
        message: `会话 ${request.params.sessionId} 不存在`,
      }
    }

    return { data: { id: request.params.sessionId, deleted: true } }
  })

  fastify.post<{
    Body: z.output<typeof chatBodySchema>
  }>('/api/chat', {
    schema: {
      body: toFastifySchema(chatBodySchema, 'input'),
    },
  }, async (request, reply) => {
    const abortController = new AbortController()
    const useStream = request.body.stream ?? true
    // 模型名绑定在 Adapter 实例上，因此按模型选 Agent；未声明的模型直接拒绝，
    // 而不是静默退回默认模型让用户以为切换生效了。
    const capability = request.body.model
      ? options.model.models.find(item => item.id === request.body.model)
      : options.model.models.find(item => item.id === options.model.defaultModel)
    if (!capability) {
      reply.code(400)
      return {
        error: 'MODEL_NOT_SUPPORTED',
        message: `未声明的模型：${request.body.model ?? ''}`,
      }
    }
    /*
      默认模型直接用门面注入的 `agent`，不要求 Runtime 再注册一次（`createServerApp({ agent })`
      的语义就是"默认模型的 Agent"）；只有切换到别的模型时才查 `resolveAgent`。
    */
    const agent = capability.id === options.model.defaultModel
      ? options.agent
      : options.resolveAgent?.(capability.id)
    if (!agent) {
      reply.code(400)
      return {
        error: 'MODEL_NOT_SUPPORTED',
        message: `模型 ${capability.id} 没有可用的 Agent 实例`,
      }
    }

    /*
      推理等级按"选中模型的能力"校验，而不是按全局列表：目录是运维自己写的部署事实，
      在 HTTP 边界拒绝能给出明确原因（这属于部署自查），也避免把明显的非法值送给供应商。
      请求未提供时用该模型的默认等级；默认值为 null 时不带该参数，由供应商决定。
    */
    const requestedEffort = request.body.reasoningEffort?.trim()
    if (requestedEffort && !capability.reasoningEfforts.includes(requestedEffort)) {
      reply.code(400)
      return {
        error: 'REASONING_EFFORT_NOT_SUPPORTED',
        message: capability.reasoningEfforts.length
          ? `模型 ${capability.id} 不支持推理等级 ${requestedEffort}；可用：${capability.reasoningEfforts.join(', ')}`
          : `模型 ${capability.id} 不支持设置推理等级`,
      }
    }
    const reasoningEffort = requestedEffort || capability.defaultReasoningEffort

    const agentRequest = {
      scopeId: SINGLE_USER_SCOPE_ID,
      input: request.body.message,
      ...(request.body.sessionId
        ? { sessionId: request.body.sessionId }
        : {}),
      ...(!request.body.sessionId
        ? {
            sessionMetadata: {
              source: 'server-runtime',
            },
            sessionName: createConversationTitle(request.body.message),
          }
        : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }

    // 浏览器断开连接时取消同一个 Agent Run，模型和工具会收到组合后的 AbortSignal。
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished)
        abortController.abort()
    })

    if (!useStream) {
      // 普通 JSON 请求没有实时事件通道，因此不会注册交互式工具审批观察器。
      // ToolGuard 的 ask 会得到 unavailable 并作为工具失败交回 AgentLoop，而不会永久等待。
      const result = await agent.invoke(agentRequest, abortController.signal)
      const response: ServerChatJsonResponse = { data: result }
      return response
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders()

    try {
      for await (const event of agent.stream(agentRequest, abortController.signal)) {
        // AgentOutputEvent 已是 craft-harness 的标准应用协议，默认原样写出即可。
        await writeSseEvent(reply.raw, event)
      }
    }
    catch (error) {
      if (!abortController.signal.aborted) {
        await writeSseEvent(reply.raw, {
          type: 'server.error',
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

/** 让 Zod 同时成为 HTTP 类型与 Fastify Draft 7 Schema 的唯一来源。 */
function toFastifySchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io,
  }) as Record<string, unknown>
}

/** 把最小 Session 摘要投影为会话目录项。 */
function createConversationSummary(session: SessionSummary): ConversationSummary {
  return Object.freeze({
    id: session.sessionId,
    name: session.sessionName ?? '新对话',
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
  event: ServerStreamEvent,
): Promise<void> {
  if (response.write(`data: ${JSON.stringify(event)}\n\n`))
    return

  await new Promise<void>((resolve, reject) => {
    function cleanup() {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
    }
    function onDrain() {
      cleanup()
      resolve()
    }
    function onClose() {
      cleanup()
      reject(new Error('SSE 客户端已断开'))
    }
    function onError(error: Error) {
      cleanup()
      reject(error)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
  })
}
