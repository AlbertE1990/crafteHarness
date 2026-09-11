import type {
  ModelFunctionToolCall,
  ModelMessage,
  SessionEventDraft,
} from '../contracts'
import type { HarnessLocale } from '../locale'
import type { ToolExecutionResult } from '../tools'
import type { ModelStepResult } from './model-stream'
import type { MutableRunState } from './run-state'
import type { RunSignals } from './stop-policy'
import type {
  AgentEvent,
  AgentEventBase,
  AgentLoopConfig,
  AgentLoopLimits,
  AgentRunCompletedResult,
  AgentRunErrorInfo,
  AgentRunFailedResult,
  AgentRunOptions,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStoppedResult,
  AgentTool,
} from './types'
import { randomUUID } from 'node:crypto'
import { diagnostic, resolveLocale } from '../locale'
import { deriveModelMessages, readSessionSnapshot, SessionStoreError } from '../sessions'
import {
  createToolFailure,
  normalizeModelError,
  normalizeSessionError,
  parseToolArguments,
} from './errors'
import { defineAgentLoopModelExecutionOptions } from './model-options'
import { consumeModelCompletion, consumeModelStream } from './model-stream'
import { addUsage, appendReasoning, createResultBase } from './run-state'
import {
  createLimits,
  createRunSignals,
  createStopError,
  getInterruption,
  getModelFinishStop,
  minimumDefined,
} from './stop-policy'
import { createAgentToolMap } from './tool-registry'

/**
 * 供应商、网络框架和数据库实现无关的 Agent 执行循环。
 *
 * 一次 Run 对应一次用户 Turn；每个 Step 只包含一次模型请求及其返回的一批 Tool Call。
 * Session Log 是模型历史的唯一事实来源，本类不会维护跨 Run 的第二份可变消息数组。
 */
export class AgentLoop<TContext = undefined> {
  readonly limits: AgentLoopLimits

  private readonly config: AgentLoopConfig<TContext>
  private readonly tools: ReadonlyMap<string, AgentTool<TContext>>
  private readonly locale: HarnessLocale
  private readonly now: () => Date
  private readonly createId: (kind: 'run' | 'turn' | 'event') => string

  constructor(config: AgentLoopConfig<TContext>) {
    const locale = resolveLocale(
      typeof config === 'object' && config !== null
        ? (config as { readonly locale?: unknown }).locale
        : undefined,
    )
    validateConfig(config, locale)
    const model = defineAgentLoopModelExecutionOptions(undefined, {
      stream: true,
      id: config.model.id,
      ...(config.model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: config.model.reasoningEffort }),
    }, locale)
    this.config = Object.freeze({
      ...config,
      locale,
      model: Object.freeze({
        id: model.id,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      }),
    })
    this.locale = locale
    this.limits = createLimits(config.limits, locale)
    this.tools = createAgentToolMap(config.tools ?? [], locale)
    this.now = config.now ?? (() => new Date())
    this.createId = config.createId ?? (kind => `${kind}-${randomUUID()}`)
  }

  /**
   * 执行一个完整用户 Turn，并返回封闭终态。
   *
   * 配置或请求形状错误会尽早抛出 TypeError；运行期模型、Session、预算和取消都会返回
   * AgentRunResult，并通过 onEvent 输出实时过程。
   */
  async run(request: AgentRunRequest<TContext>, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const input = validateRequest(request, this.locale)
    // 一次 Run 只解析一次模型设置，工具往返后的后续 Step 继续使用相同配置。
    const modelExecution = defineAgentLoopModelExecutionOptions(options.model, {
      stream: true,
      id: this.config.model.id,
      ...(this.config.model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.config.model.reasoningEffort }),
    }, this.locale)
    const state = this.createRunState(request, options)
    const signals = createRunSignals(this.limits.maxDurationMs, options.signal, this.locale)
    const eventBase = (): AgentEventBase => ({
      runId: state.runId,
      turnId: state.turnId,
      sessionId: state.sessionId,
      timestamp: this.getTimestamp(),
    })

    await emit(options.onEvent, {
      ...eventBase(),
      type: 'agent.run.started',
      provider: this.config.adapter.provider,
      model: modelExecution.id,
      modelExecution,
      limits: this.limits,
    })

    try {
      try {
        state.sessionVersion = await this.startTurn(request, input, state)
        state.turnStarted = true
      }
      catch (error) {
        return await this.finishFailure(
          state,
          'session_error',
          normalizeSessionError(error, state.sessionId),
          eventBase,
          options.onEvent,
          false,
        )
      }

      await emit(options.onEvent, { ...eventBase(), type: 'agent.turn.started' })

      while (state.steps < this.limits.maxModelSteps) {
        const interruption = getInterruption(signals, this.locale)
        if (interruption) {
          return await this.finishStopped(
            state,
            interruption.reason,
            interruption.error,
            eventBase,
            options.onEvent,
          )
        }

        if (
          this.limits.maxTotalTokens !== undefined
          && state.usage.total_tokens >= this.limits.maxTotalTokens
        ) {
          return await this.finishStopped(
            state,
            'max_total_tokens',
            createStopError('AGENT_MAX_TOTAL_TOKENS', diagnostic(this.locale, 'Run 已达到总 token 预算', 'Run reached its total token budget')),
            eventBase,
            options.onEvent,
          )
        }

        const step = state.steps + 1
        state.steps = step
        await emit(options.onEvent, {
          ...eventBase(),
          type: 'agent.step.started',
          step,
        })

        let stepResult: ModelStepResult
        try {
          stepResult = await this.runModelStep(
            state,
            step,
            modelExecution,
            signals.signal,
            eventBase,
            options.onEvent,
          )
        }
        catch (error) {
          const interrupted = getInterruption(signals, this.locale)
          if (interrupted) {
            return await this.finishStopped(
              state,
              interrupted.reason,
              interrupted.error,
              eventBase,
              options.onEvent,
            )
          }

          if (error instanceof SessionStoreError) {
            return await this.finishFailure(
              state,
              'session_error',
              normalizeSessionError(error, state.sessionId),
              eventBase,
              options.onEvent,
              false,
            )
          }

          const normalized = normalizeModelError(error, this.config.adapter.provider)
          return await this.finishFailure(
            state,
            normalized.protocol ? 'model_protocol_error' : 'model_error',
            normalized.error,
            eventBase,
            options.onEvent,
          )
        }

        state.content = stepResult.content
        appendReasoning(state, stepResult.reasoning)
        addUsage(state, stepResult.usage)

        const interrupted = getInterruption(signals, this.locale)
        if (interrupted) {
          return await this.finishStopped(
            state,
            interrupted.reason,
            interrupted.error,
            eventBase,
            options.onEvent,
          )
        }

        if (stepResult.toolCalls.length > 0) {
          if (state.toolCalls + stepResult.toolCalls.length > this.limits.maxToolCalls) {
            return await this.finishStopped(
              state,
              'max_tool_calls',
              createStopError('AGENT_MAX_TOOL_CALLS', diagnostic(this.locale, '模型请求的工具调用超过 Run 预算', 'Model-requested tool calls exceeded the Run budget')),
              eventBase,
              options.onEvent,
            )
          }

          try {
            await this.appendMessage(state, {
              role: 'assistant',
              content: stepResult.content,
              ...(stepResult.reasoning ? { reasoning_content: stepResult.reasoning } : {}),
              tool_calls: stepResult.toolCalls,
            })
            await this.executeToolCalls(
              state,
              step,
              stepResult.toolCalls,
              request.context as TContext,
              signals,
              eventBase,
              options.onEvent,
            )
          }
          catch (error) {
            return await this.finishFailure(
              state,
              'session_error',
              normalizeSessionError(error, state.sessionId),
              eventBase,
              options.onEvent,
              false,
            )
          }

          await emit(options.onEvent, {
            ...eventBase(),
            type: 'agent.step.completed',
            step,
            outcome: 'tool_calls',
            ...(stepResult.finishReason ? { finishReason: stepResult.finishReason } : {}),
            toolCallCount: stepResult.toolCalls.length,
            ...(stepResult.usage ? { usage: stepResult.usage } : {}),
          })
          continue
        }

        if (!stepResult.content) {
          return await this.finishFailure(
            state,
            'model_protocol_error',
            {
              code: 'MODEL_PROTOCOL_ERROR',
              message: diagnostic(this.locale, '模型既没有返回最终文本，也没有返回工具调用', 'The model returned neither final text nor tool calls'),
            },
            eventBase,
            options.onEvent,
          )
        }

        try {
          await this.appendMessage(state, {
            role: 'assistant',
            content: stepResult.content,
            ...(stepResult.reasoning ? { reasoning_content: stepResult.reasoning } : {}),
          })
        }
        catch (error) {
          return await this.finishFailure(
            state,
            'session_error',
            normalizeSessionError(error, state.sessionId),
            eventBase,
            options.onEvent,
            false,
          )
        }

        await emit(options.onEvent, {
          ...eventBase(),
          type: 'agent.step.completed',
          step,
          outcome: 'final_response',
          ...(stepResult.finishReason ? { finishReason: stepResult.finishReason } : {}),
          toolCallCount: 0,
          ...(stepResult.usage ? { usage: stepResult.usage } : {}),
        })

        const finishStop = getModelFinishStop(stepResult.finishReason, this.locale)
        if (finishStop) {
          return await this.finishStopped(
            state,
            finishStop.reason,
            finishStop.error,
            eventBase,
            options.onEvent,
          )
        }

        return await this.finishCompleted(state, eventBase, options.onEvent)
      }

      return await this.finishStopped(
        state,
        'max_model_steps',
        createStopError('AGENT_MAX_MODEL_STEPS', diagnostic(this.locale, 'Run 已达到最大模型 Step 数', 'Run reached the maximum number of model Steps')),
        eventBase,
        options.onEvent,
      )
    }
    finally {
      signals.clear()
    }
  }

  /** 创建本次执行的可变内部游标；该状态不会跨 Run 保存。 */
  private createRunState(request: AgentRunRequest<TContext>, options: AgentRunOptions): MutableRunState {
    const runId = options.runId ?? this.createId('run')
    const turnId = options.turnId ?? this.createId('turn')
    validateIdentifier(runId, 'runId', this.locale)
    validateIdentifier(turnId, 'turnId', this.locale)

    return {
      runId,
      turnId,
      scopeId: request.scopeId,
      sessionId: request.sessionId,
      sessionVersion: 0,
      turnStarted: false,
      steps: 0,
      toolCalls: 0,
      content: '',
      reasoning: '',
      usage: {
        completion_tokens: 0,
        prompt_tokens: 0,
        total_tokens: 0,
      },
    }
  }

  /** 在一个原子批次中创建可选 Session、写入 Turn 开始和用户消息。 */
  private async startTurn(
    request: AgentRunRequest<TContext>,
    input: string,
    state: MutableRunState,
  ): Promise<number> {
    const snapshot = await readSessionSnapshot(
      { scopeId: state.scopeId, sessionId: state.sessionId },
      this.config.store,
      { locale: this.locale },
    )
    const events: SessionEventDraft[] = []

    const occurredAt = this.getTimestamp()

    if (snapshot.version === 0) {
      events.push({
        type: 'session.created',
        eventId: this.createId('event'),
        timestamp: occurredAt,
        ...(request.sessionName ? { sessionName: request.sessionName } : {}),
        ...(request.sessionMetadata ? { metadata: request.sessionMetadata } : {}),
      })
      if (this.config.systemPrompt) {
        events.push({
          type: 'message.appended',
          eventId: this.createId('event'),
          timestamp: occurredAt,
          message: { role: 'system', content: this.config.systemPrompt },
        })
      }
    }

    events.push(
      { type: 'turn.started', runId: state.runId, turnId: state.turnId, eventId: this.createId('event'), timestamp: occurredAt },
      {
        type: 'message.appended',
        runId: state.runId,
        turnId: state.turnId,
        eventId: this.createId('event'),
        timestamp: occurredAt,
        message: { role: 'user', content: input },
      },
    )

    const appended = await this.config.store.append({
      scopeId: state.scopeId,
      sessionId: state.sessionId,
      expectedVersion: snapshot.version,
      events,
    })
    return appended.version
  }

  /** 每个 Step 都重新从固定 Session 快照推导模型消息，避免双份历史漂移。 */
  private async runModelStep(
    state: MutableRunState,
    step: number,
    modelExecution: ReturnType<typeof defineAgentLoopModelExecutionOptions>,
    signal: AbortSignal,
    eventBase: () => AgentEventBase,
    listener?: AgentRunOptions['onEvent'],
  ): Promise<ModelStepResult> {
    const snapshot = await readSessionSnapshot(
      { scopeId: state.scopeId, sessionId: state.sessionId },
      this.config.store,
      { locale: this.locale },
    )
    if (snapshot.version !== state.sessionVersion) {
      throw new SessionStoreError({
        code: 'SESSION_VERSION_CONFLICT',
        message: diagnostic(this.locale, `Session ${state.sessionId} 在 Run 执行期间被其他写入者修改`, `Session ${state.sessionId} was modified by another writer during the Run`),
        sessionId: state.sessionId,
        expectedVersion: state.sessionVersion,
        actualVersion: snapshot.version,
      })
    }

    const remainingTokens = this.limits.maxTotalTokens === undefined
      ? undefined
      : Math.max(1, this.limits.maxTotalTokens - state.usage.total_tokens)
    const stepTokenLimit = minimumDefined(
      this.limits.maxCompletionTokensPerStep,
      remainingTokens,
    )
    const toolModels = [...this.tools.values()].map(tool => tool.model)
    const request = {
      model: modelExecution.id,
      messages: deriveModelMessages(snapshot.events, this.locale),
      ...(toolModels.length > 0
        ? { tools: toolModels, parallel_tool_calls: false as const }
        : {}),
      ...(modelExecution.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: modelExecution.reasoningEffort }),
      ...(stepTokenLimit === undefined ? {} : { max_completion_tokens: stepTokenLimit }),
    }
    const callOptions = {
      signal,
      runId: state.runId,
      sessionId: state.sessionId,
      locale: this.locale,
    }

    if (!modelExecution.stream) {
      const completion = await this.config.adapter.complete(request, callOptions)
      await emit(listener, {
        ...eventBase(),
        type: 'agent.model.completed',
        step,
        completion,
      })
      return consumeModelCompletion(completion, this.config.adapter.provider, this.locale)
    }

    const stream = await this.config.adapter.stream(request, callOptions)

    return await consumeModelStream(stream, async (chunk) => {
      await emit(listener, {
        ...eventBase(),
        type: 'agent.model.chunk',
        step,
        chunk,
      })
    }, this.config.adapter.provider, this.locale)
  }

  /** 按模型返回顺序串行执行工具，并在每次执行后立即持久化对应 tool 消息。 */
  private async executeToolCalls(
    state: MutableRunState,
    step: number,
    toolCalls: readonly ModelFunctionToolCall[],
    context: TContext,
    signals: RunSignals,
    eventBase: () => AgentEventBase,
    listener?: AgentRunOptions['onEvent'],
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      state.toolCalls += 1
      await emit(listener, {
        ...eventBase(),
        type: 'agent.tool.call.started',
        step,
        callId: toolCall.id,
        toolName: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })

      const interrupted = getInterruption(signals, this.locale)
      const result = interrupted
        ? createToolFailure({
            code: 'TOOL_ABORTED',
            message: interrupted.error.message,
            retryable: false,
          })
        : await this.executeToolCall(
            state,
            step,
            toolCall,
            context,
            signals.signal,
            eventBase,
            listener,
          )

      // 成功、业务失败、用户拒绝和策略拒绝都必须产生对应的 role=tool 消息。
      // 这样下一 Model Step 能看到明确结果，不会留下只有 assistant tool_call、没有响应的悬空历史。
      await this.appendMessage(state, {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.content,
      })
      await emit(listener, {
        ...eventBase(),
        type: 'agent.tool.call.completed',
        step,
        callId: toolCall.id,
        toolName: toolCall.function.name,
        result,
      })
    }
  }

  /** 解析工具参数并调用统一 Tool Harness；查找和 JSON 错误也使用同一种结果外壳。 */
  private async executeToolCall(
    state: MutableRunState,
    step: number,
    toolCall: ModelFunctionToolCall,
    context: TContext,
    signal: AbortSignal,
    eventBase: () => AgentEventBase,
    listener?: AgentRunOptions['onEvent'],
  ): Promise<ToolExecutionResult<unknown>> {
    const tool = this.tools.get(toolCall.function.name)
    if (!tool) {
      return createToolFailure({
        code: 'TOOL_NOT_FOUND',
        message: diagnostic(this.locale, `工具 ${toolCall.function.name} 不存在`, `Tool ${toolCall.function.name} does not exist`),
        retryable: false,
      })
    }

    const parsed = parseToolArguments(toolCall.function.arguments, this.locale)
    if (!parsed.ok)
      return createToolFailure(parsed.error)

    return await tool.execute(parsed.value, {
      callId: toolCall.id,
      runId: state.runId,
      sessionId: state.sessionId,
      context,
      signal,
      locale: this.locale,
      ...(tool.guard !== undefined ? { guardOverride: tool.guard } : {}),
      ...(this.config.globalGuard ? { globalGuard: this.config.globalGuard } : {}),
      // AgentLoop 不理解前端或 HTTP；它只把 Agent 配置中的审批函数继续传给 Tool Harness。
      ...(this.config.requestToolApproval
        ? { requestApproval: this.config.requestToolApproval }
        : {}),
      onEvent: async (event) => {
        await safelyNotifyToolListener(this.config.onToolEvent, event)
        await emit(listener, {
          ...eventBase(),
          type: 'agent.tool.event',
          step,
          event,
        })
      },
    })
  }

  /** 使用当前乐观版本追加一条模型消息，并推进 Run 内 Session 游标。 */
  private async appendMessage(
    state: MutableRunState,
    message: ModelMessage,
  ): Promise<void> {
    const appended = await this.config.store.append({
      scopeId: state.scopeId,
      sessionId: state.sessionId,
      expectedVersion: state.sessionVersion,
      events: [{
        type: 'message.appended',
        runId: state.runId,
        turnId: state.turnId,
        eventId: this.createId('event'),
        timestamp: this.getTimestamp(),
        message,
      }],
    })
    state.sessionVersion = appended.version
  }

  /** 正常完成时先写入持久事实，再发送终态实时事件。 */
  private async finishCompleted(
    state: MutableRunState,
    eventBase: () => AgentEventBase,
    listener?: AgentRunOptions['onEvent'],
  ): Promise<AgentRunResult> {
    try {
      const appended = await this.config.store.append({
        scopeId: state.scopeId,
        sessionId: state.sessionId,
        expectedVersion: state.sessionVersion,
        events: [{
          type: 'turn.completed',
          runId: state.runId,
          turnId: state.turnId,
          eventId: this.createId('event'),
          timestamp: this.getTimestamp(),
        }],
      })
      state.sessionVersion = appended.version
    }
    catch (error) {
      return await this.finishFailure(
        state,
        'session_error',
        normalizeSessionError(error, state.sessionId),
        eventBase,
        listener,
        false,
      )
    }

    const result: AgentRunCompletedResult = {
      ...createResultBase(state),
      status: 'completed',
      stopReason: 'completed',
    }
    await emit(listener, { ...eventBase(), type: 'agent.run.completed', result })
    return result
  }

  /** 预算或取消停止时记录 failed/cancelled 事实；持久化失败会升级为 session_error。 */
  private async finishStopped(
    state: MutableRunState,
    reason: AgentRunStoppedResult['stopReason'],
    error: AgentRunErrorInfo,
    eventBase: () => AgentEventBase,
    listener?: AgentRunOptions['onEvent'],
  ): Promise<AgentRunResult> {
    if (state.turnStarted) {
      const occurredAt = this.getTimestamp()
      const event: SessionEventDraft = reason === 'cancelled'
        ? {
            type: 'turn.cancelled',
            runId: state.runId,
            turnId: state.turnId,
            eventId: this.createId('event'),
            timestamp: occurredAt,
            reason: error.message,
          }
        : {
            type: 'turn.failed',
            runId: state.runId,
            turnId: state.turnId,
            eventId: this.createId('event'),
            timestamp: occurredAt,
            error,
          }
      try {
        const appended = await this.config.store.append({
          scopeId: state.scopeId,
          sessionId: state.sessionId,
          expectedVersion: state.sessionVersion,
          events: [event],
        })
        state.sessionVersion = appended.version
      }
      catch (sessionError) {
        return await this.finishFailure(
          state,
          'session_error',
          normalizeSessionError(sessionError, state.sessionId),
          eventBase,
          listener,
          false,
        )
      }
    }

    const result: AgentRunStoppedResult = {
      ...createResultBase(state),
      status: 'stopped',
      stopReason: reason,
      error,
    }
    await emit(listener, { ...eventBase(), type: 'agent.run.stopped', result })
    return result
  }

  /** 运行异常统一归一化；仅在版本仍受本 Run 控制时尝试追加 turn.failed。 */
  private async finishFailure(
    state: MutableRunState,
    reason: AgentRunFailedResult['stopReason'],
    error: AgentRunErrorInfo,
    eventBase: () => AgentEventBase,
    listener: AgentRunOptions['onEvent'],
    persist: boolean = true,
  ): Promise<AgentRunResult> {
    let finalReason = reason
    let finalError = error

    if (persist && state.turnStarted) {
      try {
        const appended = await this.config.store.append({
          scopeId: state.scopeId,
          sessionId: state.sessionId,
          expectedVersion: state.sessionVersion,
          events: [{
            type: 'turn.failed',
            runId: state.runId,
            turnId: state.turnId,
            eventId: this.createId('event'),
            timestamp: this.getTimestamp(),
            error,
          }],
        })
        state.sessionVersion = appended.version
      }
      catch (sessionError) {
        finalReason = 'session_error'
        finalError = normalizeSessionError(sessionError, state.sessionId)
      }
    }

    const result: AgentRunFailedResult = {
      ...createResultBase(state),
      status: 'failed',
      stopReason: finalReason,
      error: finalError,
    }
    await emit(listener, { ...eventBase(), type: 'agent.run.failed', result })
    return result
  }

  /** 生成有效 ISO 时间；错误时尽早暴露错误的测试或 Runtime 注入。 */
  private getTimestamp(): string {
    const value = this.now()
    if (!Number.isFinite(value.getTime()))
      throw new TypeError(diagnostic(this.locale, 'AgentLoop now() 必须返回有效 Date', 'AgentLoop now() must return a valid Date'))
    return value.toISOString()
  }
}

/** 构造时验证不可缺少的 Ports 和可选系统指令。 */
function validateConfig<TContext>(config: AgentLoopConfig<TContext>, locale: HarnessLocale): void {
  if (!config || typeof config !== 'object')
    throw new TypeError(diagnostic(locale, 'AgentLoop config 必须是对象', 'AgentLoop config must be an object'))
  if (!config.adapter
    || typeof config.adapter.complete !== 'function'
    || typeof config.adapter.stream !== 'function') {
    throw new TypeError(diagnostic(locale, 'AgentLoop config.adapter 必须实现 ModelAdapter', 'AgentLoop config.adapter must implement ModelAdapter'))
  }
  if (typeof config.model !== 'object' || config.model === null)
    throw new TypeError(diagnostic(locale, 'AgentLoop config.model 必须是模型选择对象', 'AgentLoop config.model must be a model selection object'))
  if (!config.store || typeof config.store.read !== 'function' || typeof config.store.append !== 'function')
    throw new TypeError(diagnostic(locale, 'AgentLoop config.store 必须实现 SessionStore', 'AgentLoop config.store must implement SessionStore'))
  if (config.systemPrompt !== undefined && !config.systemPrompt.trim())
    throw new TypeError(diagnostic(locale, 'AgentLoop systemPrompt 不能是空字符串', 'AgentLoop systemPrompt cannot be an empty string'))
}

/** Run 请求在写 Session 前完成校验。 */
function validateRequest<TContext>(request: AgentRunRequest<TContext>, locale: HarnessLocale): string {
  if (!request || typeof request !== 'object')
    throw new TypeError(diagnostic(locale, 'AgentRunRequest 必须是对象', 'AgentRunRequest must be an object'))
  validateIdentifier(request.sessionId, 'sessionId', locale)
  validateIdentifier(request.scopeId, 'scopeId', locale)
  if (request.sessionName !== undefined)
    validateIdentifier(request.sessionName, 'sessionName', locale)
  if (typeof request.input !== 'string' || !request.input.trim())
    throw new TypeError(diagnostic(locale, 'input 必须是非空字符串', 'input must be a non-empty string'))
  return request.input.trim()
}

/** 验证关联 ID，参数顺序遵循“业务值在前、诊断字段名在后”。 */
function validateIdentifier(value: string, field: string, locale: HarnessLocale): void {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(diagnostic(locale, `${field} 必须是非空字符串`, `${field} must be a non-empty string`))
}

/** Agent 观察器属于旁路，抛错不能改变执行和持久化结果。 */
async function emit(listener: AgentRunOptions['onEvent'], event: AgentEvent): Promise<void> {
  try {
    await listener?.(event)
  }
  catch {
    // 后续 DiagnosticSink 会记录观察器异常；当前阶段保持业务主链不受影响。
  }
}

/** 配置级 Tool 观察器与 Agent 观察器相互隔离。 */
async function safelyNotifyToolListener(
  listener: AgentLoopConfig['onToolEvent'],
  event: Parameters<NonNullable<AgentLoopConfig['onToolEvent']>>[0],
): Promise<void> {
  try {
    await listener?.(event)
  }
  catch {
    // 与 Agent emit 保持相同的旁路隔离语义。
  }
}
