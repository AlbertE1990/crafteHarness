import type {
  ModelAdapter,
  ModelCompletion,
  ModelStreamChunk,
  ModelTokenUsage,
  SessionStore,
} from '../contracts'
import type {
  ExecuteToolOptions,
  ToolApprovalHandler,
  ToolEventListener,
  ToolExecutionEvent,
  ToolExecutionResult,
  ToolGuardEvaluator,
  ToolModelDefinition,
} from '../tools'
import type { JsonObject } from '../types/json'

/** Agent Loop 默认使用的有限预算；所有数字都包含当前一次操作。 */
export interface AgentLoopLimits {
  /** 一次 Run 最多发起的模型请求数。 */
  readonly maxModelSteps: number
  /** 一次 Run 最多接受并执行的 Tool Call 数。 */
  readonly maxToolCalls: number
  /** 每次模型请求最多允许生成的 token 数。 */
  readonly maxCompletionTokensPerStep?: number
  /** 根据模型上报 usage 累计的 Run 总 token 上限。 */
  readonly maxTotalTokens?: number
  /** 整个 Run 的协作式墙上时间上限。 */
  readonly maxDurationMs?: number
}

/** 创建 AgentLoop 时注入的模型、存储、工具和部署侧策略。 */
export interface AgentLoopConfig<TContext = undefined> {
  readonly model: ModelAdapter
  readonly store: SessionStore
  /** 工具必须先通过 createAgentTool() 擦除不同 Schema 的泛型差异。 */
  readonly tools?: readonly AgentTool<TContext>[]
  /** 只在创建全新 Session 时写入；已有 Session 不会重复追加。 */
  readonly systemPrompt?: string
  readonly limits?: Partial<AgentLoopLimits>
  /** 部署、租户、用户和环境级 Guard；缺省表示该层 allow。 */
  readonly globalGuard?: ToolGuardEvaluator<TContext>
  readonly requestToolApproval?: ToolApprovalHandler<TContext>
  readonly onToolEvent?: ToolEventListener
  /** 测试可注入的墙上时钟。 */
  readonly now?: () => Date
  /** 测试或部署侧可注入的关联 ID 生成器。 */
  readonly createId?: (kind: 'run' | 'turn' | 'event') => string
}

/** 发起一次用户 Turn 的业务输入。 */
export interface AgentRunRequest<TContext = undefined> {
  readonly scopeId: string
  readonly sessionId: string
  readonly input: string
  /** 仅在本次 Run 内传给 Guard 和工具执行函数，不进入模型或 Session Log。 */
  readonly context?: TContext
  /** 仅在 Session 尚不存在时写入 session.created。 */
  readonly sessionName?: string
  readonly sessionMetadata?: JsonObject
}

/** 单次 Agent Run 的模型调用方式；同一 Run 的所有 Step 使用同一份解析结果。 */
export interface AgentLoopModelExecutionOptions {
  /** true 使用增量流，false 使用 ModelAdapter.complete()；默认 true。 */
  readonly stream?: boolean
  /**
   * 通用推理强度；`'off'` 表示显式关闭推理，其他非空字符串是供应商定义的等级。
   *
   * 具体供应商字段和合法等级由 ModelAdapter 决定。
   */
  readonly reasoningEffort?: string
}

/** 经过边界校验和默认值合并后的模型调用方式。 */
export interface DefinedAgentLoopModelExecutionOptions {
  readonly stream: boolean
  readonly reasoningEffort?: string
}

/** 单次 Run 的取消、关联和实时观察选项。 */
export interface AgentRunOptions {
  readonly signal?: AbortSignal
  readonly runId?: string
  readonly turnId?: string
  /** 覆盖本次 Run 的流式与推理设置。 */
  readonly model?: AgentLoopModelExecutionOptions
  /** 观察器异常会被隔离，不能改变 Agent 的执行结果。 */
  readonly onEvent?: AgentEventListener
}

/** 不同 DefinedTool 经过类型擦除后，Agent Loop 使用的统一注册项。 */
export interface AgentTool<TContext = undefined> {
  readonly name: string
  readonly model: ToolModelDefinition
  /** Agent 配置可以替换或移除内置工具的局部 Guard。 */
  readonly guard?: ToolGuardEvaluator<TContext> | null
  /** 始终通过 Tool Harness 执行，而不是直接调用业务工具的 execute。 */
  execute: (
    rawInput: unknown,
    options: ExecuteToolOptions<TContext>,
  ) => Promise<ToolExecutionResult<unknown>>
}

/** Agent Loop 累计的标准 token 用量。 */
export interface AgentTokenUsage {
  readonly completion_tokens: number
  readonly prompt_tokens: number
  readonly total_tokens: number
}

/** Agent Run 可正常或受控停止的原因。 */
export type AgentRunStopReason
  = | 'completed'
    | 'max_model_steps'
    | 'max_tool_calls'
    | 'max_total_tokens'
    | 'max_duration'
    | 'cancelled'
    | 'model_length'
    | 'model_content_filter'
    | 'model_finish_reason'
    | 'model_error'
    | 'model_protocol_error'
    | 'session_error'

/** 可安全进入实时事件和 Session 失败事件的 Agent 错误。 */
export interface AgentRunErrorInfo {
  readonly code: string
  readonly message: string
  readonly details?: JsonObject
}

/** 所有 Run 结果共有的关联、统计和最终文本。 */
export interface AgentRunResultBase {
  readonly runId: string
  readonly turnId: string
  readonly sessionId: string
  readonly content: string
  readonly reasoning: string
  readonly steps: number
  readonly toolCalls: number
  readonly usage: AgentTokenUsage
  readonly sessionVersion: number
}

/** 模型给出完整最终回答。 */
export interface AgentRunCompletedResult extends AgentRunResultBase {
  readonly status: 'completed'
  readonly stopReason: 'completed'
}

/** 预算、取消或模型停止原因导致的受控停止。 */
export interface AgentRunStoppedResult extends AgentRunResultBase {
  readonly status: 'stopped'
  readonly stopReason: Exclude<
    AgentRunStopReason,
    'completed' | 'model_error' | 'model_protocol_error' | 'session_error'
  >
  readonly error: AgentRunErrorInfo
}

/** 模型、协议或 Session 边界异常导致的失败。 */
export interface AgentRunFailedResult extends AgentRunResultBase {
  readonly status: 'failed'
  readonly stopReason: 'model_error' | 'model_protocol_error' | 'session_error'
  readonly error: AgentRunErrorInfo
}

/** AgentLoop.run() 的封闭结果。 */
export type AgentRunResult
  = | AgentRunCompletedResult
    | AgentRunStoppedResult
    | AgentRunFailedResult

/** 一次 Model Step 完成后的控制流走向。 */
export type AgentStepOutcome = 'final_response' | 'tool_calls'

/** Agent 实时事件共有的关联字段。 */
export interface AgentEventBase {
  readonly runId: string
  readonly turnId: string
  readonly sessionId: string
  readonly timestamp: string
}

/** Agent Loop 输出的实时生命周期、模型增量和工具轨迹。 */
export type AgentEvent = AgentEventBase & (
  | {
    readonly type: 'agent.run.started'
    readonly provider: string
    readonly model: string
    readonly modelExecution: DefinedAgentLoopModelExecutionOptions
    readonly limits: AgentLoopLimits
  }
  | { readonly type: 'agent.turn.started' }
  | { readonly type: 'agent.step.started', readonly step: number }
  | {
    readonly type: 'agent.model.chunk'
    readonly step: number
    readonly chunk: ModelStreamChunk
  }
  | {
    readonly type: 'agent.model.completed'
    readonly step: number
    readonly completion: ModelCompletion
  }
  | {
    readonly type: 'agent.tool.call.started'
    readonly step: number
    readonly callId: string
    readonly toolName: string
    readonly arguments: string
  }
  | {
    readonly type: 'agent.tool.event'
    readonly step: number
    readonly event: ToolExecutionEvent
  }
  | {
    readonly type: 'agent.tool.call.completed'
    readonly step: number
    readonly callId: string
    readonly toolName: string
    readonly result: ToolExecutionResult<unknown>
  }
  | {
    readonly type: 'agent.step.completed'
    readonly step: number
    readonly outcome: AgentStepOutcome
    readonly finishReason?: string
    readonly toolCallCount: number
    readonly usage?: ModelTokenUsage
  }
  | { readonly type: 'agent.run.completed', readonly result: AgentRunCompletedResult }
  | { readonly type: 'agent.run.stopped', readonly result: AgentRunStoppedResult }
  | { readonly type: 'agent.run.failed', readonly result: AgentRunFailedResult }
)

/** 观察实时 Agent 轨迹的回调。 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>
