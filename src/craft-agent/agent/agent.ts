import type {
  ListSessionsOptions,
  SessionCatalogStore,
  SessionEvent,
  SessionListPage,
  SessionStore,
} from '../contracts'
import type { AgentEvent, AgentRunResult } from '../core'
import type { AgentConfigInput, DefinedAgentConfig } from './config'
import type {
  ResolveToolApprovalRequest,
  ResolveToolApprovalResult,
} from './tool-guard'
import type {
  AgentExecutionOptions,
  AgentOutputEvent,
  AgentOutputEventListener,
  AgentRequest,
  AgentSessionDetail,
  AgentSessionMessage,
  GetAgentSessionOptions,
} from './types'
import { randomUUID } from 'node:crypto'
import { AgentLoop } from '../core'
import { defineAgentModelExecutionOptions } from '../core/model-options'
import { readSessionSnapshot } from '../sessions'
import { defineAgentConfig } from './config'
import { ToolApprovalManager } from './tool-approval-manager'
import { createToolGuardPolicy } from './tool-guard'

/**
 * CraftAgent 的开发者门面。
 *
 * 本类统一包装模型配置、工具、Session Store、AgentLoop 和标准应用事件；它不读取环境变量，
 * 也不依赖 Fastify、数据库驱动或前端协议。
 */
export class Agent {
  readonly config: DefinedAgentConfig
  readonly store: SessionStore
  readonly limits: DefinedAgentConfig['execution']['limits']

  private readonly approvalManager: ToolApprovalManager
  private readonly loop: AgentLoop

  constructor(config: AgentConfigInput) {
    this.config = defineAgentConfig(config)
    this.store = this.config.session.store
    const createId = this.config.execution.createId
    this.approvalManager = new ToolApprovalManager({
      defaultTimeoutMs: this.config.toolGuard.approvalTimeoutMs,
      now: this.config.execution.now,
      ...(createId
        ? { createApprovalId: () => createId('approval') }
        : {}),
    })
    const toolPolicy = createToolGuardPolicy(
      this.config.toolGuard,
      this.config.tools,
      (request, decision) => this.approvalManager.notifyDenied(request, decision),
    )
    this.loop = new AgentLoop({
      model: this.config.model,
      store: this.store,
      tools: this.config.tools,
      ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
      limits: this.config.execution.limits,
      toolPolicy,
      requestToolApproval: this.approvalManager.requestApproval,
      ...(this.config.observability.onToolEvent
        ? { onToolEvent: this.config.observability.onToolEvent }
        : {}),
      now: this.config.execution.now,
      ...(this.config.execution.createId
        ? { createId: this.config.execution.createId }
        : {}),
    })
    this.limits = this.loop.limits
  }

  /**
   * 执行一次用户 Turn。
   *
   * onEvent 提供稳定的应用输出，onTrace 暴露完整 AgentEvent；二者都是观察旁路，
   * 回调异常不会改变模型、工具或 Session 的执行结果。
   */
  async run(
    request: AgentRequest,
    options: AgentExecutionOptions = {},
  ): Promise<AgentRunResult> {
    if (typeof request !== 'object' || request === null)
      throw new TypeError('Agent request 必须是对象')
    const input = typeof request.input === 'string' ? request.input.trim() : ''
    if (!input)
      throw new TypeError('Agent request.input 不能为空')

    const generatedSessionId = request.sessionId === undefined
      ? this.config.session.createSessionId()
      : undefined
    const sessionId = typeof request.sessionId === 'string'
      ? request.sessionId.trim()
      : typeof generatedSessionId === 'string'
        ? generatedSessionId.trim()
        : ''
    if (!sessionId)
      throw new TypeError('Agent sessionId 不能为空')

    const runId = createRunId(options.runId, this.config)
    // 在进入循环前一次性解析，确保同一 Run 的多个模型 Step 不会使用不同设置。
    const modelExecution = defineAgentModelExecutionOptions(
      options.model,
      this.config.execution.model,
    )
    // 没有应用事件出口时 ask 会得到 unavailable；这避免无法展示的审批长期占用内存。
    const stopObservingApprovals = options.onEvent
      ? this.approvalManager.observeRun(
          runId,
          options.onEvent,
        )
      : undefined

    try {
      await emit(options.onEvent, { type: 'session.started', sessionId })
      const project = createOutputProjector(sessionId, options.onEvent)

      return await this.loop.run({
        sessionId,
        input,
        ...(request.sessionMetadata
          ? { sessionMetadata: request.sessionMetadata }
          : {}),
      }, {
        runId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.turnId ? { turnId: options.turnId } : {}),
        model: modelExecution,
        onEvent: async (event) => {
          await emitTrace(this.config.observability.onTrace, event)
          await emitTrace(options.onTrace, event)
          await project(event)
        },
      })
    }
    finally {
      stopObservingApprovals?.()
    }
  }

  /**
   * 解决一次等待中的工具审批。
   *
   * approvalId 只接受首个 allow/deny；重复、过期或未知决定返回 accepted=false，绝不会再次执行工具。
   */
  resolveToolApproval(
    request: ResolveToolApprovalRequest,
  ): ResolveToolApprovalResult {
    return this.approvalManager.resolve(request)
  }

  /** 读取一个 Session 的一致快照并返回带事件上下文的消息详情。 */
  async getSession(
    sessionId: string,
    options: GetAgentSessionOptions = {},
  ): Promise<AgentSessionDetail | undefined> {
    const normalizedId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedId)
      throw new TypeError('sessionId 不能为空')

    const snapshot = await readSessionSnapshot(normalizedId, this.store, options)
    if (snapshot.version === 0)
      return undefined
    const created = snapshot.events[0]
    if (!created || created.type !== 'session.created')
      throw new Error(`Session ${normalizedId} 缺少 session.created`)

    return Object.freeze({
      sessionId: normalizedId,
      createdAt: created.timestamp,
      version: snapshot.version,
      ...(created.metadata ? { metadata: created.metadata } : {}),
      messages: createSessionMessages(snapshot.events),
    })
  }

  /**
   * 分页列出 Session 摘要，不读取完整事件和模型消息。
   *
   * 自定义 Store 若未实现 SessionCatalogStore，Agent 仍可运行，但本方法会明确拒绝调用。
   */
  async listSessions(options: ListSessionsOptions = {}): Promise<SessionListPage> {
    if (!isSessionCatalogStore(this.store))
      throw new TypeError('当前 SessionStore 未实现 list() 会话目录能力')

    return await this.store.list(options)
  }
}

/** Agent 必须在进入 AgentLoop 前确定 runId，审批管理器才能提前注册对应事件出口。 */
function createRunId(
  value: string | undefined,
  config: DefinedAgentConfig,
): string {
  const runId = value === undefined
    ? config.execution.createId?.('run') ?? `run-${randomUUID()}`
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (!runId)
    throw new TypeError('Agent runId 不能为空')
  return runId
}

/**
 * 从 Session Log 中筛选模型消息，并保留调试和前端定位所需的事件关联字段。
 *
 * AgentLoop 仍会使用纯 ModelMessage 历史；这里仅服务于面向应用的详情查询。
 */
function createSessionMessages(
  events: readonly SessionEvent[],
): readonly AgentSessionMessage[] {
  return Object.freeze(events.flatMap((event): AgentSessionMessage[] => {
    if (event.type !== 'message.appended')
      return []

    return [Object.freeze({
      eventId: event.eventId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      message: event.message,
    })]
  }))
}

/** 在不扩大基本 SessionStore 协议的前提下识别可查询会话目录的实现。 */
function isSessionCatalogStore(store: SessionStore): store is SessionCatalogStore {
  return 'list' in store && typeof store.list === 'function'
}

/** 把完整 AgentEvent 投影为供应商、网络和 UI 无关的标准应用事件。 */
function createOutputProjector(
  sessionId: string,
  listener: AgentOutputEventListener | undefined,
): (event: AgentEvent) => Promise<void> {
  const reasoningSteps = new Set<number>()
  let emittedReasoning = false

  return async (event) => {
    if (event.type === 'agent.model.chunk') {
      const choice = event.chunk.choices.find(item => item.index === 0)
        ?? event.chunk.choices[0]
      if (!choice)
        return

      const reasoning = choice.delta.reasoning_content ?? ''
      if (reasoning) {
        const firstInStep = !reasoningSteps.has(event.step)
        const separator = firstInStep && emittedReasoning ? '\n\n' : ''
        reasoningSteps.add(event.step)
        emittedReasoning = true
        await emit(listener, {
          type: 'message.delta',
          sessionId,
          channel: 'reasoning',
          delta: separator + reasoning,
        })
      }

      const content = choice.delta.content ?? ''
      if (content) {
        await emit(listener, {
          type: 'message.delta',
          sessionId,
          channel: 'content',
          delta: content,
        })
      }
      return
    }

    if (event.type === 'agent.run.completed') {
      await emit(listener, {
        type: 'message.completed',
        sessionId,
        content: event.result.content,
        reasoning: event.result.reasoning,
      })
      return
    }
    if (event.type !== 'agent.run.failed' && event.type !== 'agent.run.stopped')
      return

    await emit(listener, {
      type: 'error',
      sessionId,
      message: event.result.error.message,
      code: event.result.error.code,
      stopReason: event.result.stopReason,
    })
  }
}

/** 应用输出属于观察旁路，监听器失败不能中断 Agent Run。 */
async function emit(
  listener: AgentOutputEventListener | undefined,
  event: AgentOutputEvent,
): Promise<void> {
  try {
    await listener?.(event)
  }
  catch {
    // 阶段 6 的 DiagnosticSink 将记录观察器异常。
  }
}

/** 完整轨迹观察器同样隔离异常，避免调试设施改变业务结果。 */
async function emitTrace(
  listener: DefinedAgentConfig['observability']['onTrace'] | AgentExecutionOptions['onTrace'],
  event: AgentEvent,
): Promise<void> {
  try {
    await listener?.(event)
  }
  catch {
    // 阶段 6 的 DiagnosticSink 将记录观察器异常。
  }
}
