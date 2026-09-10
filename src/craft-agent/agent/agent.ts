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
  AgentOutputEvent,
  AgentRequest,
  AgentSessionDetail,
  AgentSessionMessage,
  GetAgentSessionRequest,
} from './types'
import { randomUUID } from 'node:crypto'
import { AgentLoop } from '../core'
import { readSessionSnapshot } from '../sessions'
import { defineAgentConfig } from './config'
import { AsyncEventStream } from './event-stream'
import {
  createAgentLoopModelExecution,
  defineAgentModelExecutionOptions,
} from './model-options'
import { ToolApprovalManager } from './tool-approval-manager'

/** Agent 内部把标准事件写入异步流时使用的输出端。 */
type AgentOutputSink = (event: AgentOutputEvent) => void | Promise<void>

/**
 * CraftAgent 的开发者门面。
 *
 * 本类统一包装模型配置、工具、Session Store、AgentLoop 和标准应用事件；它不读取环境变量，
 * 也不依赖 Fastify、数据库驱动或前端协议。
 */
export class Agent<TContext = undefined> {
  readonly config: DefinedAgentConfig<TContext>
  readonly store: SessionStore
  readonly limits: DefinedAgentConfig['execution']['limits']

  private readonly approvalManager: ToolApprovalManager<TContext>
  private readonly loop: AgentLoop<TContext>

  constructor(config: AgentConfigInput<TContext>) {
    this.config = defineAgentConfig(config)
    this.store = this.config.sessionStore
    this.approvalManager = new ToolApprovalManager({
      defaultTimeoutMs: this.config.tools.approvalTimeoutMs,
      now: this.config.execution.now,
    })
    this.loop = new AgentLoop({
      model: this.config.model,
      store: this.store,
      tools: this.config.tools.registered,
      ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
      limits: this.config.execution.limits,
      ...(this.config.tools.guard ? { globalGuard: this.config.tools.guard } : {}),
      requestToolApproval: this.approvalManager.requestApproval,
      ...(this.config.observability.onToolEvent
        ? { onToolEvent: this.config.observability.onToolEvent }
        : {}),
      now: this.config.execution.now,
    })
    this.limits = this.loop.limits
  }

  /** 执行一次非流式用户 Turn，并返回封闭结果。 */
  async invoke(
    request: AgentRequest<TContext>,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    return await this.execute(request, false, signal)
  }

  /**
   * 执行一次流式用户 Turn；消费方停止迭代时自动取消同一个 Run。
   *
   * 事件通道包含背压，慢速 SSE、CLI 或 UI 消费者不会令 Agent 无限缓存输出。
   */
  stream(
    request: AgentRequest<TContext>,
    signal?: AbortSignal,
  ): AsyncIterable<AgentOutputEvent> {
    return this.createOutputStream(request, signal)
  }

  /** invoke() 与 stream() 共享的唯一运行路径。 */
  private async execute(
    request: AgentRequest<TContext>,
    stream: boolean,
    signal?: AbortSignal,
    output?: AgentOutputSink,
  ): Promise<AgentRunResult> {
    if (typeof request !== 'object' || request === null)
      throw new TypeError('Agent request 必须是对象')
    const input = typeof request.input === 'string' ? request.input.trim() : ''
    if (!input)
      throw new TypeError('Agent request.input 不能为空')
    const scopeId = typeof request.scopeId === 'string' ? request.scopeId.trim() : ''
    if (!scopeId)
      throw new TypeError('Agent request.scopeId 不能为空')
    const sessionName = request.sessionName === undefined
      ? undefined
      : typeof request.sessionName === 'string'
        ? request.sessionName.trim()
        : ''
    if (sessionName === '')
      throw new TypeError('Agent request.sessionName 必须是非空字符串')

    const generatedSessionId = request.sessionId === undefined
      ? `session-${randomUUID()}`
      : undefined
    const sessionId = typeof request.sessionId === 'string'
      ? request.sessionId.trim()
      : typeof generatedSessionId === 'string'
        ? generatedSessionId.trim()
        : ''
    if (!sessionId)
      throw new TypeError('Agent sessionId 不能为空')

    const runId = createRunId()
    // 在进入循环前一次性解析，确保同一 Run 的多个模型 Step 不会使用不同设置。
    const modelExecution = defineAgentModelExecutionOptions(
      request.model,
      this.config.execution.model,
    )
    const loopModelExecution = createAgentLoopModelExecution(modelExecution, stream)
    // 没有应用事件出口时 ask 会得到 unavailable；这避免无法展示的审批长期占用内存。
    const stopObservingApprovals = output
      ? this.approvalManager.observeRun(
          runId,
          output,
        )
      : undefined

    try {
      await output?.({ type: 'session.started', sessionId })
      const project = createOutputProjector(sessionId, output)

      return await this.loop.run({
        scopeId,
        sessionId,
        input,
        context: request.context as TContext,
        ...(sessionName ? { sessionName } : {}),
        ...(request.sessionMetadata
          ? { sessionMetadata: request.sessionMetadata }
          : {}),
      }, {
        runId,
        ...(signal ? { signal } : {}),
        model: loopModelExecution,
        onEvent: async (event) => {
          await emitTrace(this.config.observability.onTrace, event)
          await project(event)
        },
      })
    }
    finally {
      stopObservingApprovals?.()
    }
  }

  /** 把内部回调协议适配为带背压和取消语义的 AsyncIterable。 */
  private async* createOutputStream(
    request: AgentRequest<TContext>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentOutputEvent> {
    const localController = new AbortController()
    const combined = combineAbortSignals(signal, localController.signal)
    const events = new AsyncEventStream<AgentOutputEvent>()
    const execution = this.execute(
      request,
      true,
      combined.signal,
      event => events.write(event),
    ).then(
      (result) => {
        events.close()
        return result
      },
      (error: unknown) => {
        events.fail(error)
        throw error
      },
    )

    try {
      for await (const event of events)
        yield event
      await execution
    }
    finally {
      localController.abort()
      combined.dispose()
      await events.return()
      await execution.catch(() => undefined)
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
    request: GetAgentSessionRequest,
  ): Promise<AgentSessionDetail | undefined> {
    if (typeof request !== 'object' || request === null)
      throw new TypeError('Agent getSession request 必须是对象')
    const scopeId = typeof request.scopeId === 'string' ? request.scopeId.trim() : ''
    if (!scopeId)
      throw new TypeError('scopeId 不能为空')
    const normalizedId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    if (!normalizedId)
      throw new TypeError('sessionId 不能为空')

    const snapshot = await readSessionSnapshot(
      { scopeId, sessionId: normalizedId },
      this.store,
      { pageSize: request.pageSize },
    )
    if (snapshot.version === 0)
      return undefined
    const created = snapshot.events[0]
    if (!created || created.type !== 'session.created')
      throw new Error(`Session ${normalizedId} 缺少 session.created`)

    return Object.freeze({
      scopeId,
      sessionId: normalizedId,
      ...(snapshot.sessionName ? { sessionName: snapshot.sessionName } : {}),
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
  async listSessions(options: ListSessionsOptions): Promise<SessionListPage> {
    if (typeof options !== 'object' || options === null)
      throw new TypeError('Agent listSessions options 必须是对象')
    const scopeId = typeof options.scopeId === 'string' ? options.scopeId.trim() : ''
    if (!scopeId)
      throw new TypeError('scopeId 不能为空')
    if (!isSessionCatalogStore(this.store))
      throw new TypeError('当前 SessionStore 未实现 list() 会话目录能力')

    return await this.store.list({ ...options, scopeId })
  }
}

/** Agent 必须在进入 AgentLoop 前确定 runId，审批管理器才能提前注册对应事件出口。 */
function createRunId(): string {
  return `run-${randomUUID()}`
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
  listener: AgentOutputSink | undefined,
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
        await listener?.({
          type: 'message.delta',
          sessionId,
          channel: 'reasoning',
          delta: separator + reasoning,
        })
      }

      const content = choice.delta.content ?? ''
      if (content) {
        await listener?.({
          type: 'message.delta',
          sessionId,
          channel: 'content',
          delta: content,
        })
      }
      return
    }

    if (event.type === 'agent.tool.event'
      && event.event.type === 'tool.guard.decided'
      && event.event.result.decision === 'deny') {
      await listener?.({
        type: 'tool.guard.denied',
        sessionId,
        runId: event.runId,
        callId: event.event.callId,
        toolName: event.event.toolName,
        reason: event.event.result.reason,
      })
      return
    }

    if (event.type === 'agent.run.completed') {
      await listener?.({
        type: 'message.completed',
        sessionId,
        content: event.result.content,
        reasoning: event.result.reasoning,
      })
      return
    }
    if (event.type !== 'agent.run.failed' && event.type !== 'agent.run.stopped')
      return

    await listener?.({
      type: 'error',
      sessionId,
      message: event.result.error.message,
      code: event.result.error.code,
      stopReason: event.result.stopReason,
    })
  }
}

/** 完整轨迹观察器同样隔离异常，避免调试设施改变业务结果。 */
async function emitTrace(
  listener: DefinedAgentConfig<unknown>['observability']['onTrace'],
  event: AgentEvent,
): Promise<void> {
  try {
    await listener?.(event)
  }
  catch {
    // 阶段 6 的 DiagnosticSink 将记录观察器异常。
  }
}

/** 组合调用方取消与流消费者取消，并提供显式监听清理。 */
function combineAbortSignals(
  external: AbortSignal | undefined,
  local: AbortSignal,
): { readonly signal: AbortSignal, dispose: () => void } {
  if (!external)
    return { signal: local, dispose: () => undefined }

  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(external.reason)
  const abortFromLocal = () => controller.abort(local.reason)
  external.addEventListener('abort', abortFromExternal, { once: true })
  local.addEventListener('abort', abortFromLocal, { once: true })
  if (external.aborted)
    abortFromExternal()
  else if (local.aborted)
    abortFromLocal()

  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener('abort', abortFromExternal)
      local.removeEventListener('abort', abortFromLocal)
    },
  }
}
