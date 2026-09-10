import type { JsonObject, JsonSchema } from '../types/json'

/** Guard 决定可携带的安全 JSON 元数据；它只进入轨迹，不改变控制流。 */
export interface ToolGuardDecisionMetadata {
  readonly metadata?: JsonObject
}

/**
 * 工具调用在执行前允许得到的封闭决定。
 *
 * - allow：当前调用可以继续。
 * - deny：只拒绝当前工具调用，拒绝结果会交回 AgentLoop。
 * - ask：暂停当前调用，等待一次性用户审批。
 */
export type ToolGuardDecision
  = | ({ readonly decision: 'allow' } & ToolGuardDecisionMetadata)
    | ({ readonly decision: 'deny', readonly reason: string } & ToolGuardDecisionMetadata)
    | ({
      readonly decision: 'ask'
      readonly reason: string
      /** 交互层可选的用户可见标题。 */
      readonly title?: string
      /** 已确认可安全发送给交互层的结构化详情。 */
      readonly details?: JsonObject
      /** 当前调用的审批时限；-1 表示不自动过期。 */
      readonly approvalTimeoutMs?: number
    } & ToolGuardDecisionMetadata)

/** Guard 可以读取的工具静态信息，不包含业务执行函数。 */
export interface ToolGuardToolInfo<
  TMetadata extends JsonObject = JsonObject,
> {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  /** 工具作者定义的 JSON 安全业务信息；CraftAgent 不解释其中字段。 */
  readonly metadata: Readonly<TMetadata>
}

/**
 * 工具级和全局 Guard 共用的评估输入。
 *
 * `input` 已通过 inputSchema 校验。context 来自当前 agent.run()，不会发送给模型、
 * 写入 Session Log 或保存在 Agent 单例上。直接使用 Tool Harness 时，关联字段可以缺省。
 */
export interface ToolGuardRequest<
  TContext = undefined,
  TInput = unknown,
  TMetadata extends JsonObject = JsonObject,
> {
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly tool: ToolGuardToolInfo<TMetadata>
  readonly input: TInput
  readonly context: TContext
  /** Run 取消、超时或客户端断开时会中止异步评估和审批。 */
  readonly signal: AbortSignal
}

/** 一个 Guard 只负责风险判断，不负责等待用户或直接执行工具。 */
export type ToolGuardEvaluator<
  TContext = undefined,
  TInput = unknown,
  TMetadata extends JsonObject = JsonObject,
> = (
  request: ToolGuardRequest<TContext, TInput, TMetadata>,
) => ToolGuardDecision | Promise<ToolGuardDecision>

/**
 * 用户审批可能产生的封闭结果；只有 allowed-once 可以继续执行。
 * unavailable 用于通道缺失、超时或交互失败，aborted 用于整个调用已取消。
 */
export type ToolApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable' | 'aborted'

/** Runtime 交给前端、CLI 或其他交互层的单次审批请求。 */
export interface ToolApprovalRequest<TContext = undefined>
  extends ToolGuardRequest<TContext> {
  readonly reason: string
  readonly title?: string
  readonly details?: JsonObject
  /** Guard 计算出的最终时限；-1 表示永久等待。 */
  readonly approvalTimeoutMs?: number
}

/**
 * 执行一次用户审批并返回不可复用的单次结果。
 *
 * 实现可以等待前端、CLI 或外部审批系统；它只返回决定，不能绕过 Harness 直接执行工具。
 */
export type ToolApprovalHandler<TContext = undefined> = (
  request: ToolApprovalRequest<TContext>,
) => ToolApprovalOutcome | Promise<ToolApprovalOutcome>
