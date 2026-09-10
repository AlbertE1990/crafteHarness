import type { z } from 'zod'
import type { JsonObject, JsonSchema } from '../types/json'
import type { ToolGuardEvaluator } from './guard'

/** 同时兼容同步工具与异步工具的返回类型。 */
export type MaybePromise<T> = T | Promise<T>

/** 工具执行失败后再次尝试的退避策略。 */
export interface ToolRetryPolicy {
  /** 包含首次执行在内的最大尝试次数。 */
  readonly maxAttempts: number
  /** 第一次重试前的等待时间。 */
  readonly baseDelayMs: number
  /** 单次等待时间上限。 */
  readonly maxDelayMs: number
  /** 默认使用指数退避。 */
  readonly backoff?: 'fixed' | 'exponential'
  /** 0 至 1 之间的随机抖动比例，默认 0.2。 */
  readonly jitterRatio?: number
}

/** 单次尝试的超时和重试行为；这些字段不会发送给模型。 */
export interface ToolExecutionConfig {
  /** 单次尝试的协作式超时；同进程代码无法被强制终止。 */
  readonly timeoutMs?: number
  /**
   * 默认不重试。配置此字段即表示工具作者明确允许 CraftAgent 重复调用 execute()。
   * CraftAgent 无法证明业务幂等性，写操作应由工具作者自行使用幂等键消除重复副作用。
   */
  readonly retry?: ToolRetryPolicy
}

/** Harness 传给单次工具尝试的只读执行上下文。 */
export interface ToolRunContext<TContext = undefined> {
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly attempt: number
  /** 当前 agent.run() 注入的业务上下文；不会自动持久化或发送给模型。 */
  readonly context: TContext
  /** 工具必须观察或继续向下游传递此取消信号。 */
  readonly signal: AbortSignal
}

/** 发给模型 adapter 的供应商无关工具描述。 */
export interface ToolModelDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

/**
 * 工具作者填写的完整定义。
 *
 * 输入和成功输出都以 Zod 为唯一类型来源；metadata、Guard 和执行策略永远不会发送给模型。
 */
export interface ToolDefinition<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext = undefined,
  TMetadata extends JsonObject = JsonObject,
> {
  /** 稳定工具名，只允许字母、数字、下划线和连字符。 */
  readonly name: string
  /** 说明工具能力及适用时机的模型可见描述。 */
  readonly description: string
  /** 模型参数、TypeScript 推导和运行时输入校验的唯一来源。 */
  readonly inputSchema: TInputSchema
  /** 成功业务值的 TypeScript 推导和运行时输出校验规范。 */
  readonly outputSchema: TOutputSchema
  /** CraftAgent 不解释的 JSON 安全业务标签；未配置时为空对象。 */
  readonly metadata?: TMetadata
  /** 工具自身的参数级风险评估；缺省表示工具级 Guard 直接 allow。 */
  readonly toolGuard?: ToolGuardEvaluator<
    TContext,
    z.output<TInputSchema>,
    TMetadata
  >
  /** 单次尝试的超时与重试策略。 */
  readonly execution?: ToolExecutionConfig
  /** 将校验后的成功值投影为模型可见文本，默认安全 JSON 序列化。 */
  readonly renderOutput?: (value: z.output<TOutputSchema>) => string
  /** 执行业务逻辑并返回 outputSchema 可接受的原始值。 */
  execute: (
    input: z.output<TInputSchema>,
    context: ToolRunContext<TContext>,
  ) => MaybePromise<z.input<TOutputSchema>>
}

/** 经过注册期检查并缓存 JSON Schema 的可执行工具。 */
export interface DefinedTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext = undefined,
  TMetadata extends JsonObject = JsonObject,
> extends ToolDefinition<TInputSchema, TOutputSchema, TContext, TMetadata> {
  /** 未配置 metadata 时也归一化为空对象，Guard 无需处理 undefined。 */
  readonly metadata: Readonly<TMetadata>
  /** adapter 只读取该投影，不会接触 execute、metadata、Guard 或执行策略。 */
  readonly model: ToolModelDefinition
  /** 供文档、轨迹和未来组合工具读取的成功输出 Schema。 */
  readonly outputJsonSchema: JsonSchema
}
